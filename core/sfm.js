// Helbing-Farkas-Vicsek social force model (Nature 407, 487-490, 2000)
//
//   m_i dv_i/dt = m_i (v0_i e_i - v_i)/tau_i + SUM_j f_ij + SUM_W f_iW
//   f_ij = [ A exp((r_ij - d_ij)/B) + k g(r_ij - d_ij) ] n_ij
//          + kappa g(r_ij - d_ij) (dv_ji . t_ij) t_ij
//   g(x) = x for x > 0, else 0
//
// Desired direction e_i comes from a NavField (eikonal) so the same code drives
// both the paper's single-aperture benchmark and the full campus network.

export const HELBING = {
  A: 2000,      // N        interaction strength
  B: 0.08,      // m        interaction range
  k: 1.2e5,     // kg/s^2   body compression
  kappa: 2.4e5, // kg/(m s) sliding friction
};

export class SpatialHash {
  constructor(cell, x0, y0, w, h) {
    this.cell = cell; this.x0 = x0; this.y0 = y0;
    this.nx = Math.ceil(w / cell) + 1; this.ny = Math.ceil(h / cell) + 1;
    this.heads = new Int32Array(this.nx * this.ny);
    this.next = new Int32Array(0);
  }
  build(x, y, active, n) {
    if (this.next.length < n) this.next = new Int32Array(n);
    this.heads.fill(-1);
    const { cell, x0, y0, nx, ny } = this;
    for (let i = 0; i < n; i++) {
      if (!active[i]) { this.next[i] = -1; continue; }
      let cx = ((x[i] - x0) / cell) | 0, cy = ((y[i] - y0) / cell) | 0;
      if (cx < 0) cx = 0; else if (cx >= nx) cx = nx - 1;
      if (cy < 0) cy = 0; else if (cy >= ny) cy = ny - 1;
      const c = cy * nx + cx;
      this.next[i] = this.heads[c]; this.heads[c] = i;
    }
  }
  /** calls cb(j) for every candidate neighbour of world point (px,py) */
  forEachNear(px, py, cb) {
    const { cell, x0, y0, nx, ny, heads, next } = this;
    let cx = ((px - x0) / cell) | 0, cy = ((py - y0) / cell) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const gy = cy + dy; if (gy < 0 || gy >= ny) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx; if (gx < 0 || gx >= nx) continue;
        for (let j = heads[gy * nx + gx]; j !== -1; j = next[j]) cb(j);
      }
    }
  }
}

/** Deterministic PRNG (mulberry32) so runs are reproducible per seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Crowd {
  /**
   * @param {object} o
   * @param {number} o.capacity   max agents
   * @param {object} o.bounds     {x0,y0,w,h} world extent (metres)
   * @param {Array}  o.walls      [{x1,y1,x2,y2}] line segments
   * @param {Array}  o.obstacles  [{x,y,r}] circular obstacles
   * @param {object} o.params     overrides for HELBING + {dt, forceCap}
   */
  constructor({ capacity, bounds, walls = [], obstacles = [], params = {} }) {
    const N = capacity;
    this.n = 0; this.capacity = N;
    this.bounds = bounds;
    this.walls = walls;
    this.obstacles = obstacles;
    // Interaction cutoff: with B ~ 0.055 m the exponential term is already
    // below 0.2 N at 1.2 m centre distance, so a 2 m cutoff only buys neighbour
    // bookkeeping. The hash cell must be >= cutoff/2 for the 3x3 scan to be exact.
    this.p = { ...HELBING, dt: 0.03, forceCap: 6e4, cutoff: 1.2, ...params };

    this.x = new Float64Array(N); this.y = new Float64Array(N);
    this.vx = new Float64Array(N); this.vy = new Float64Array(N);
    this.fx = new Float64Array(N); this.fy = new Float64Array(N);
    this.r = new Float64Array(N); this.m = new Float64Array(N);
    this.v0 = new Float64Array(N); this.tau = new Float64Array(N);
    this.active = new Uint8Array(N);
    this.field = new Int32Array(N);      // which NavField drives this agent
    this.group = new Int32Array(N);      // grade*100 + class, for the 3-10 rule
    this.tSpawn = new Float64Array(N);
    this.tDone = new Float64Array(N).fill(NaN);
    this.stage = new Uint8Array(N);      // 0 approach, 1 queueing, 2 served, ...

    this.fields = [];
    this.hash = new SpatialHash(Math.max(0.6, this.p.cutoff / 2), bounds.x0, bounds.y0, bounds.w, bounds.h);
    this.t = 0;
    // per-step diagnostics
    this.contactCount = 0;
    this.stallT = new Float64Array(N);
  }

  addField(f) { this.fields.push(f); return this.fields.length - 1; }

  spawn({ x, y, v0, tau = 0.5, r = 0.23, m = 75, field = 0, group = 0 }) {
    const i = this.n++;
    if (i >= this.capacity) throw new Error('crowd capacity exceeded');
    this.x[i] = x; this.y[i] = y; this.vx[i] = 0; this.vy[i] = 0;
    this.r[i] = r; this.m[i] = m; this.v0[i] = v0; this.tau[i] = tau;
    this.active[i] = 1; this.field[i] = field; this.group[i] = group;
    this.tSpawn[i] = this.t;
    this.stage[i] = 0;
    return i;
  }

  deactivate(i) { this.active[i] = 0; this.tDone[i] = this.t; }

  step(dt = this.p.dt) {
    const { x, y, vx, vy, fx, fy, r, m, v0, tau, active, n, p } = this;
    const { A, B, k, kappa, forceCap } = p;
    const cut2 = p.cutoff * p.cutoff;
    this.hash.build(x, y, active, n);
    fx.fill(0, 0, n); fy.fill(0, 0, n);
    this.contactCount = 0;
    const dirBuf = [0, 0];

    // --- driving force ---
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const f = this.fields[this.field[i]];
      f.dir(x[i], y[i], dirBuf);
      fx[i] += m[i] * (v0[i] * dirBuf[0] - vx[i]) / tau[i];
      fy[i] += m[i] * (v0[i] * dirBuf[1] - vy[i]) / tau[i];
    }

    // --- pedestrian-pedestrian (each unordered pair once) ---
    // The spatial-hash walk is inlined rather than driven by a callback: at
    // campus scale the per-agent closure allocation dominated the step cost.
    const H = this.hash, heads = H.heads, nxt = H.next;
    const hc = H.cell, hx0 = H.x0, hy0 = H.y0, hnx = H.nx, hny = H.ny;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const xi = x[i], yi = y[i], ri = r[i];
      const cx = ((xi - hx0) / hc) | 0, cy = ((yi - hy0) / hc) | 0;
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        if (gy < 0 || gy >= hny) continue;
        const rowBase = gy * hnx;
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          if (gx < 0 || gx >= hnx) continue;
          for (let j = heads[rowBase + gx]; j !== -1; j = nxt[j]) {
            if (j <= i || !active[j]) continue;
            const dx = xi - x[j], dy = yi - y[j];
            const d2 = dx * dx + dy * dy;
            if (d2 > cut2) continue;
            const d = Math.sqrt(d2) || 1e-9;
            const nrx = dx / d, nry = dy / d;
            const overlap = ri + r[j] - d;
            let fn = A * Math.exp(overlap / B);
            let ft = 0;
            if (overlap > 0) {
              fn += k * overlap;
              const tx = -nry, ty = nrx;
              ft = kappa * overlap * ((vx[j] - vx[i]) * tx + (vy[j] - vy[i]) * ty);
              this.contactCount++;
            }
            let Fx = fn * nrx - ft * nry;   // t = (-n_y, n_x)
            let Fy = fn * nry + ft * nrx;
            const mag = Math.sqrt(Fx * Fx + Fy * Fy);
            if (mag > forceCap) { const sc = forceCap / mag; Fx *= sc; Fy *= sc; }
            fx[i] += Fx; fy[i] += Fy;
            fx[j] -= Fx; fy[j] -= Fy;
          }
        }
      }
    }

    // --- geometry: grid distance field when present, else segment/circle loops ---
    if (this.obstacleField) {
      const s = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        if (!active[i]) continue;
        this.obstacleField.sample(x[i], y[i], s);
        const d = s[0], nx = s[1], ny = s[2];
        if (d > r[i] + 0.8) continue;
        if (nx === 0 && ny === 0) continue;
        const overlap = r[i] - d;
        let fn = A * Math.exp(Math.min(overlap, 0.5) / B);
        let ft = 0;
        if (overlap > 0) {
          fn += k * overlap;
          const tx = -ny, ty = nx;
          ft = -kappa * overlap * (vx[i] * tx + vy[i] * ty);
        }
        let Fx = fn * nx - ft * ny, Fy = fn * ny + ft * nx;
        const mag = Math.hypot(Fx, Fy);
        if (mag > forceCap) { Fx *= forceCap / mag; Fy *= forceCap / mag; }
        fx[i] += Fx; fy[i] += Fy;
      }
    } else
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const xi = x[i], yi = y[i], ri = r[i];
      for (const w of this.walls) {
        const [px, py] = closestOnSegment(xi, yi, w.x1, w.y1, w.x2, w.y2);
        const dx = xi - px, dy = yi - py;
        const d = Math.hypot(dx, dy) || 1e-9;
        if (d > ri + 1.0) continue;
        const nx = dx / d, ny = dy / d;
        const overlap = ri - d;
        let fn = A * Math.exp(overlap / B);
        let ft = 0;
        if (overlap > 0) {
          fn += k * overlap;
          const tx = -ny, ty = nx;
          ft = -kappa * overlap * (vx[i] * tx + vy[i] * ty);
        }
        let Fx = fn * nx - ft * ny, Fy = fn * ny + ft * nx;
        const mag = Math.hypot(Fx, Fy);
        if (mag > forceCap) { Fx *= forceCap / mag; Fy *= forceCap / mag; }
        fx[i] += Fx; fy[i] += Fy;
      }
      for (const o of this.obstacles) {
        const dx = xi - o.x, dy = yi - o.y;
        const dc = Math.hypot(dx, dy) || 1e-9;
        const d = dc - o.r;
        if (d > ri + 1.0) continue;
        const nx = dx / dc, ny = dy / dc;
        const overlap = ri - d;
        let fn = A * Math.exp(overlap / B);
        let ft = 0;
        if (overlap > 0) {
          fn += k * overlap;
          const tx = -ny, ty = nx;
          ft = -kappa * overlap * (vx[i] * tx + vy[i] * ty);
        }
        let Fx = fn * nx - ft * ny, Fy = fn * ny + ft * nx;
        const mag = Math.hypot(Fx, Fy);
        if (mag > forceCap) { Fx *= forceCap / mag; Fy *= forceCap / mag; }
        fx[i] += Fx; fy[i] += Fy;
      }
    }

    // --- unwedging: a pedestrian pinned motionless in a jam corner shuffles
    //     rather than standing frozen forever. Without this a handful of agents
    //     never arrive and the completion metric is meaningless. ---
    if (this.stallT) {
      const rnd = this._urnd || (this._urnd = rng(20260909));
      for (let i = 0; i < n; i++) {
        if (!active[i]) continue;
        const sp2 = vx[i] * vx[i] + vy[i] * vy[i];
        if (sp2 < 0.0016) this.stallT[i] += dt; else this.stallT[i] = 0;
        if (this.stallT[i] > 15) {
          const a = rnd() * 6.283185;
          fx[i] += Math.cos(a) * m[i] * 1.2;
          fy[i] += Math.sin(a) * m[i] * 1.2;
          if (this.stallT[i] > 25) this.stallT[i] = 0;
        }
      }
    }

    // --- semi-implicit Euler ---
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      vx[i] += (fx[i] / m[i]) * dt;
      vy[i] += (fy[i] / m[i]) * dt;
      const sp = Math.hypot(vx[i], vy[i]);
      const vmax = 2.5 * v0[i];               // physical speed ceiling
      if (sp > vmax) { vx[i] *= vmax / sp; vy[i] *= vmax / sp; }
      x[i] += vx[i] * dt; y[i] += vy[i] * dt;
    }
    this.t += dt;
  }
}

export function closestOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return [x1, y1];
  let t = ((px - x1) * dx + (py - y1) * dy) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [x1 + t * dx, y1 + t * dy];
}
