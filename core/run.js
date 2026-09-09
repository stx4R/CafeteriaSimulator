// Campus run loop.
//
// Outdoors the agents are social-force particles. Inside the hall they switch to
// a queueing model (serving lines with a service rate, seats with a dwell time),
// because the question the interior has to answer is which constraint binds --
// the 1.2 m door or the serving counters -- and a force model would only blur
// that with contact noise. Stages:
//   0 walk to the mouth of the assigned corridor      (social force)
//   1 walk the corridor to the door                   (social force)
//   2 queue for a serving line                        (queueing)
//   3 being served                                    (queueing)
//   4 seated, eating                                  (dwell)
//   5 left the hall

import { buildCampus, buildSchedule, distToPolylineInto } from './campus.js';
import { rng, gauss } from './sfm.js';
import { mean, percentile, std } from './metrics.js';

export const STAGE = { TO_GATE: 0, IN_CORRIDOR: 1, QUEUE: 2, SERVICE: 3, SEATED: 4, DONE: 5 };

function localFrame(cfg) {
  const face = cfg.buildings.find((b) => b.id === 'cafeteria').poly;
  const [ax, ay] = face[0], [bx, by] = face[1];
  const L = Math.hypot(bx - ax, by - ay);
  const vx = (bx - ax) / L, vy = (by - ay) / L;
  let ux = -vy, uy = vx;
  const cx = face.reduce((s, p) => s + p[0], 0) / face.length;
  const cy = face.reduce((s, p) => s + p[1], 0) / face.length;
  if ((cx - cfg.door.x) * ux + (cy - cfg.door.y) * uy < 0) { ux = -ux; uy = -uy; }
  return { ox: cfg.door.x, oy: cfg.door.y, ux, uy, vx, vy };
}
const toWorld = (f, u, v) => [f.ox + f.ux * u + f.vx * v, f.oy + f.uy * u + f.vy * v];

export class CampusSim {
  constructor(cfg, opts = {}) {
    this.o = {
      seed: 1,
      headway: 45,          // s between class releases (the 3-10 rule's tempo)
      gradeGap: 0,
      routePolicy: 'shortest',
      splitA: 0.5,
      servingLines: cfg.cafeteria.servingLines,
      serviceTime: cfg.cafeteria.serviceTime_s,
      seats: cfg.cafeteria.seats,
      mealTime: cfg.cafeteria.mealTime_s,
      egressRate: 2.0,      // people/s that can physically leave one doorway
      teacherSpread: true,
      dt: 0.06,
      substeps: 2,
      ...opts,
    };
    this.cfg = cfg;
    this.scn = buildCampus(cfg, {
      seed: this.o.seed,
      routePolicy: this.o.routePolicy,
      force: opts.force,
      ...(opts.cell !== undefined ? { cell: opts.cell } : {}),
      ...(opts.mergeApron !== undefined ? { mergeApron: opts.mergeApron } : {}),
      ...(opts.doorWidth !== undefined ? { doorWidth: opts.doorWidth } : {}),
      ...(opts.routeWidthA !== undefined ? { routeWidthA: opts.routeWidthA } : {}),
      ...(opts.routeWidthB !== undefined ? { routeWidthB: opts.routeWidthB } : {}),
    });
    this.sched = buildSchedule(cfg, { seed: this.o.seed, headway: this.o.headway, gradeGap: this.o.gradeGap });
    this.frame = localFrame(cfg);
    this.rand = rng(this.o.seed * 7919 + 13);
    this.t = 0;
    this.released = 0;
    this.route = new Uint8Array(this.scn.crowd.capacity);   // 0 = A, 1 = B
    this.line = new Int32Array(this.scn.crowd.capacity).fill(-1);
    this.timer = new Float64Array(this.scn.crowd.capacity);
    this.queues = Array.from({ length: this.o.servingLines }, () => []);
    this.seatsUsed = 0;
    this.servedTimes = [];
    this.seatedTimes = [];
    this.doorTimes = [];
    this.routeCount = [0, 0];
    this.history = [];
    this.rescued = 0;
    this.stallClock = new Float64Array(this.scn.crowd.capacity);
    this.lastT = new Float64Array(this.scn.crowd.capacity).fill(Infinity);
    this.sampleEvery = 5;      // s between time-series samples
    this._nextSample = 0;
    this.pending = [];        // people released by the schedule but not yet through their doorway
    this.spawnCredit = new Map();
    this.#buildInteriorLayout();
    this.#assignRoutes();
  }

  #buildInteriorLayout() {
    const f = this.frame, n = this.o.servingLines;
    const span = Math.min(this.cfg.cafeteria.hall.h - 4, 4 * n);
    this.counters = [];
    for (let i = 0; i < n; i++) {
      const v = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
      this.counters.push({ u: 11, v, world: toWorld(f, 11, v) });
    }
    this.seatGrid = [];
    const cols = Math.ceil(Math.sqrt(this.o.seats * 1.6)), rows = Math.ceil(this.o.seats / cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (this.seatGrid.length >= this.o.seats) break;
      const u = 16 + r * 0.95, v = -cols * 0.42 + c * 0.84;
      this.seatGrid.push(toWorld(f, u, v));
    }
  }

  #assignRoutes() {
    // route choice is fixed per person at release; policies differ only here
    this.travel = this.scn.travel;
  }

  chooseRoute(exitId) {
    const tr = this.travel[exitId];
    const p = this.o;
    if (p.routePolicy === 'split') return this.rand() < p.splitA ? 0 : 1;
    if (p.routePolicy === 'assign') return null;      // caller supplies
    return tr.viaA <= tr.viaB ? 0 : 1;                // 'shortest'
  }

  /**
   * A class does not appear on the plaza all at once: 34 students file out of
   * one classroom doorway. Dumping them into the spawn box simultaneously packs
   * them at ~7 persons/m^2, which the contact forces cannot resolve and which
   * strands an entire exit's worth of people. They are queued and metered out
   * instead, and a slot is only used when it is physically clear.
   */
  releaseClass(entry) {
    const exits = this.scn.exits;
    const ex = exits[(entry.grade * 10 + entry.klass) % exits.length];
    for (let k = 0; k < this.cfg.population.studentsPerClass; k++) {
      this.pending.push({ ex, group: entry.grade * 100 + entry.klass });
    }
    this.released++;
  }

  #drainPending(dt) {
    const { crowd } = this.scn;
    if (!this.pending.length) return;
    for (const ex of this.scn.exits) {
      const c = (this.spawnCredit.get(ex.id) ?? 0) + this.o.egressRate * dt;
      this.spawnCredit.set(ex.id, c);
    }
    let guard = 0;
    for (let n = 0; n < this.pending.length && guard < 400; ) {
      const p = this.pending[n];
      const credit = this.spawnCredit.get(p.ex.id) ?? 0;
      if (credit < 1) { n++; continue; }
      // find a clear spot in the doorway's spawn box
      let px = 0, py = 0, ok = false;
      for (let tryN = 0; tryN < 12 && !ok; tryN++) {
        guard++;
        px = p.ex.x + (this.rand() - 0.5) * p.ex.w;
        py = p.ex.y + (this.rand() - 0.5) * p.ex.h;
        ok = true;
        for (let i = 0; i < crowd.n; i++) {
          if (!crowd.active[i]) continue;
          const dx = crowd.x[i] - px, dy = crowd.y[i] - py;
          if (dx * dx + dy * dy < 0.36) { ok = false; break; }   // 0.6 m clearance
        }
      }
      if (!ok) { n++; continue; }
      this.spawnCredit.set(p.ex.id, credit - 1);
      let v0 = 1.34 + 0.12 * gauss(this.rand);
      v0 = Math.max(0.7, Math.min(1.9, v0));
      const i = crowd.spawn({ x: px, y: py, v0, tau: 0.5, r: 0.23, m: 75, field: 0, group: p.group });
      const rt = this.chooseRoute(p.ex.id) ?? 0;
      this.route[i] = rt;
      this.routeCount[rt]++;
      crowd.stage[i] = STAGE.TO_GATE;
      crowd.field[i] = rt === 0 ? this.scn.F.gateA : this.scn.F.gateB;
      this.pending.splice(n, 1);
    }
  }

  step() {
    const { crowd, door, doorZone, routes, F } = this.scn;
    const o = this.o, dt = o.dt, ns = o.substeps, hdt = dt / ns;

    // --- releases ---
    while (this.released < this.sched.plan.length && this.sched.plan[this.released].t <= this.t) {
      this.releaseClass(this.sched.plan[this.released]);
    }

    this.#drainPending(dt);

    // --- outdoor physics ---
    for (let s = 0; s < ns; s++) {
      crowd.step(hdt);
      for (const i of door.update(crowd)) {
        // count the crossing whatever stage they were in: an agent shoved
        // through the threshold has physically entered the hall
        if (crowd.stage[i] < STAGE.QUEUE) { this.#enterHall(i); this.doorTimes.push(crowd.t); }
      }
    }

    // --- stage transitions outdoors (a walker covers <0.1 m per step, so
    //     testing corridor entry every 4th step costs nothing in accuracy) ---
    if ((this._tick = (this._tick | 0) + 1) % 4 === 0) {
      const rd = this._rd || (this._rd = [0, 0]);
      for (let i = 0; i < crowd.n; i++) {
        if (!crowd.active[i] || crowd.stage[i] !== STAGE.TO_GATE) continue;
        const key = this.route[i] === 0 ? 'A' : 'B';
        distToPolylineInto(crowd.x[i], crowd.y[i], routes[key].polyline, rd);
        if (rd[0] <= routes[key].width / 2 && rd[1] < routes[key].length * 0.45) {
          crowd.stage[i] = STAGE.IN_CORRIDOR;
          crowd.field[i] = this.route[i] === 0 ? F.runA : F.runB;
        }
      }
    }

    // --- last-resort rescue -------------------------------------------------
    // A handful of pedestrians can end up wedged against the apron wall where
    // the corridor gradient points into the building. Rather than let them
    // invalidate the completion metric, push them through and COUNT how many
    // needed it - if this number is not tiny the geometry is wrong, not the crowd.
    // Distinguishing a wedged pedestrian from one legitimately queueing is the
    // whole difficulty: both stop moving. A queue member has neighbours; someone
    // wedged against the apron wall after the crowd has passed is alone. Only
    // that case is rescued, and the count is reported so it can be audited.
    if ((this._tick % 32) === 0) {
      const dtc = dt * 32;
      for (let i = 0; i < crowd.n; i++) {
        if (!crowd.active[i] || crowd.stage[i] >= STAGE.QUEUE) continue;
        const sp2 = crowd.vx[i] * crowd.vx[i] + crowd.vy[i] * crowd.vy[i];
        if (sp2 > 0.01) { this.stallClock[i] = 0; continue; }
        let near = 0;
        for (let j = 0; j < crowd.n; j++) {
          if (j === i || !crowd.active[j] || crowd.stage[j] >= STAGE.QUEUE) continue;
          const dx = crowd.x[j] - crowd.x[i], dy = crowd.y[j] - crowd.y[i];
          if (dx * dx + dy * dy < 6.25 && ++near >= 3) break;   // 2.5 m
        }
        if (near >= 3) { this.stallClock[i] = 0; continue; }    // waiting in a queue
        this.stallClock[i] += dtc;
        if (this.stallClock[i] > 120) {
          this.rescued++;
          this.#enterHall(i);
          this.scn.door.times.push(crowd.t);
          this.stallClock[i] = 0;
        }
      }
    }

    // --- interior queueing ---
    this.#stepInterior(dt);

    doorZone.sample(crowd);
    this.t += dt;
    if (this.t >= this._nextSample) {
      this._nextSample += this.sampleEvery;
      const c = this.counts();
      const z = this.scn.doorZone;
      this.history.push({
        t: +this.t.toFixed(1),
        outdoor: c.outdoor, queue: c.queue + c.service, seated: c.seated,
        door: c.throughDoor, served: c.served,
        rho: +(z.rho[z.rho.length - 1] ?? 0).toFixed(3),
        P: +(z.P[z.P.length - 1] ?? 0).toFixed(3),
      });
    }
    return this;
  }

  #enterHall(i) {
    const { crowd } = this.scn;
    crowd.vx[i] = 0; crowd.vy[i] = 0;
    let best = 0;
    for (let q = 1; q < this.queues.length; q++) if (this.queues[q].length < this.queues[best].length) best = q;
    this.queues[best].push(i);
    this.line[i] = best;
    crowd.stage[i] = STAGE.QUEUE;
  }

  #stepInterior(dt) {
    const { crowd } = this.scn;
    const f = this.frame;
    for (let q = 0; q < this.queues.length; q++) {
      const Q = this.queues[q], ctr = this.counters[q];
      // park everyone at their slot, 0.45 m apart, backing away from the counter
      for (let k = 0; k < Q.length; k++) {
        const i = Q[k];
        const [wx, wy] = toWorld(f, ctr.u - 1.0 - k * 0.45, ctr.v);
        crowd.x[i] = wx; crowd.y[i] = wy;
      }
      if (!Q.length) continue;
      const head = Q[0];
      if (crowd.stage[head] === STAGE.QUEUE) {
        crowd.stage[head] = STAGE.SERVICE;
        this.timer[head] = this.o.serviceTime * (0.75 + 0.5 * this.rand());
      } else if (crowd.stage[head] === STAGE.SERVICE) {
        this.timer[head] -= dt;
        if (this.timer[head] <= 0) {
          Q.shift();
          this.servedTimes.push(this.t);
          if (this.seatsUsed < this.o.seats) {
            const seat = this.seatGrid[this.seatsUsed++];
            crowd.x[head] = seat[0]; crowd.y[head] = seat[1];
            crowd.stage[head] = STAGE.SEATED;
            this.timer[head] = this.o.mealTime * (0.8 + 0.4 * this.rand());
            this.seatedTimes.push(this.t);
          } else {
            crowd.stage[head] = STAGE.DONE;   // no seat: leaves with the tray
            crowd.deactivate(head);
          }
        }
      }
    }
    for (let i = 0; i < crowd.n; i++) {
      if (crowd.stage[i] === STAGE.SEATED && crowd.active[i]) {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) { crowd.stage[i] = STAGE.DONE; crowd.deactivate(i); this.seatsUsed--; }
      }
    }
  }

  /** cheap completion test - summary() sorts long arrays and must not be
   *  called from a loop condition */
  isComplete() {
    return this.released >= this.sched.plan.length && this.pending.length === 0 &&
           this.scn.door.times.length + this.strandedCount() >= this.totalPeople() &&
           this.strandedCount() === 0;
  }
  totalPeople() {
    const p = this.cfg.population;
    return p.grades * p.classesPerGrade * p.studentsPerClass;
  }

  strandedCount() {
    const { crowd } = this.scn;
    let n = 0;
    for (let i = 0; i < crowd.n; i++) if (crowd.active[i] && crowd.stage[i] < STAGE.QUEUE) n++;
    return n;
  }

  counts() {
    const { crowd } = this.scn;
    const c = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < crowd.n; i++) if (crowd.active[i]) c[crowd.stage[i]]++;
    return { outdoor: c[0] + c[1], toGate: c[0], corridor: c[1], queue: c[2], service: c[3], seated: c[4],
             spawned: crowd.n, throughDoor: this.scn.door.times.length, served: this.servedTimes.length };
  }

  summary() {
    const d = this.scn.door.summary();
    const z = this.scn.doorZone.summary();
    const total = this.cfg.population.grades * this.cfg.population.classesPerGrade * this.cfg.population.studentsPerClass;
    const q = [];
    for (const Q of this.queues) q.push(Q.length);
    return {
      t: this.t,
      released: this.released,
      spawned: this.scn.crowd.n,
      throughDoor: d.N,
      doorQ: d.Q,
      doorCVh: d.CVh,
      rho95: z.rho95,
      P95: z.P95,
      served: this.servedTimes.length,
      routeSplit: [...this.routeCount],
      totalPeople: total,
      maxQueue: Math.max(...q, 0),
      stranded: this.strandedCount(),
      rescued: this.rescued,
      makespan: this.servedTimes.length ? this.servedTimes[this.servedTimes.length - 1] : NaN,
      doorSpan: this.scn.door.times.length > 1
        ? this.scn.door.times[this.scn.door.times.length - 1] - this.scn.door.times[0] : NaN,
      peakOutdoor: this.history.reduce((m, h) => Math.max(m, h.outdoor), 0),
      peakQueue: this.history.reduce((m, h) => Math.max(m, h.queue), 0),
      completion: d.N / total,
    };
  }
}
