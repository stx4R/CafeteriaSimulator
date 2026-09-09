// Reconstruction of the paper's MATLAB scenario (section 3.1):
//   6.0 m wide approach narrowing to a W = 1.2 m entrance, 60 pedestrians,
//   r = 0.23 m, m = 75 kg, v0 = 1.34 +- 0.12 m/s, tau = 0.5 s, dt = 0.03 s,
//   t_max = 52 s, cylindrical obstacle at (d*, l*, x*) = (D/W, L/W, X/W).
//
// Geometry the paper does not state (approach length, where agents start,
// Helbing force constants) is exposed here so it can be scanned rather than
// silently assumed.

import { Crowd, rng, gauss } from './sfm.js';
import { NavField } from './navfield.js';
import { ZoneRecorder, ExitCounter } from './metrics.js';

export const PAPER = {
  W: 1.2,            // entrance width (m)
  approachW: 6.0,    // approach width (m)
  N: 60,
  r: 0.23, m: 75, v0mean: 1.34, v0sd: 0.12, tau: 0.5,
  dt: 0.03, tmax: 52,
  zoneArea: 4.32,    // = W * 3.6
};

export function buildBenchmark(opts = {}) {
  const o = {
    ...PAPER,
    approachL: 8.0,     // unstated in the paper
    exitL: 4.0,
    dStar: 0, lStar: 0, xStar: 0,   // obstacle: 0 diameter = no obstacle
    cell: 0.05,
    substeps: 4,      // physics substeps per 0.03 s reporting step
    // The paper gives the analysis zone only as "4.32 m^2 immediately before
    // the entrance". Two readings fit that area:
    //   'throat' : W x 3.6  = 1.2 x 3.6   (aligned with the aperture)
    //   'strip'  : 6.0 x 0.72            (full approach width, at the wall)
    zoneShape: 'throat',
    seed: 1,
    ...opts,
  };
  const { W, approachW, approachL, exitL } = o;
  const hy = approachW / 2, ay = W / 2;

  const walls = [
    // approach side walls
    { x1: -approachL, y1: -hy, x2: 0, y2: -hy },
    { x1: -approachL, y1: hy, x2: 0, y2: hy },
    // back wall
    { x1: -approachL, y1: -hy, x2: -approachL, y2: hy },
    // bottleneck wall with the aperture
    { x1: 0, y1: -hy, x2: 0, y2: -ay },
    { x1: 0, y1: ay, x2: 0, y2: hy },
    // downstream corridor
    { x1: 0, y1: -ay, x2: exitL, y2: -ay },
    { x1: 0, y1: ay, x2: exitL, y2: ay },
  ];

  const obstacles = [];
  if (o.dStar > 0) {
    obstacles.push({ x: -o.lStar * W, y: o.xStar * W, r: (o.dStar * W) / 2 });
  }

  const bounds = { x0: -approachL - 1, y0: -hy - 1, w: approachL + exitL + 2, h: approachW + 2 };

  // ---- navigation field: target is the far end of the exit corridor ----
  const cell = o.cell;
  const gw = Math.ceil(bounds.w / cell), gh = Math.ceil(bounds.h / cell);
  const blocked = new Uint8Array(gw * gh);
  const gx = (i) => bounds.x0 + i * cell, gy = (j) => bounds.y0 + j * cell;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const X = gx(i), Y = gy(j);
    let b = 0;
    if (X < 0) {                      // approach room
      if (Y < -hy || Y > hy || X < -approachL) b = 1;
    } else {                          // downstream corridor
      if (Y < -ay || Y > ay || X > exitL) b = 1;
    }
    for (const ob of obstacles) if (Math.hypot(X - ob.x, Y - ob.y) < ob.r) b = 1;
    blocked[j * gw + i] = b;
  }
  const seeds = [];
  for (let j = 0; j < gh; j++) {
    const i = gw - 2;
    const X = gx(i), Y = gy(j);
    if (Y >= -ay && Y <= ay && X <= exitL) seeds.push(j * gw + i);
  }
  // if the sampling above missed (grid rounding), seed the corridor end column
  if (!seeds.length) {
    const i = Math.max(0, Math.round((exitL - cell - bounds.x0) / cell));
    for (let j = 0; j < gh; j++) if (!blocked[j * gw + i]) seeds.push(j * gw + i);
  }
  const nav = new NavField({ x0: bounds.x0, y0: bounds.y0, w: gw, h: gh, cell, blocked }).solve(seeds);

  const crowd = new Crowd({
    capacity: o.N + 8, bounds, walls, obstacles,
    params: { dt: o.dt, ...(o.force || {}) },
  });
  crowd.addField(nav);

  // ---- seed agents without initial overlap ----
  const rand = rng(o.seed);
  let placed = 0, guard = 0;
  while (placed < o.N && guard < 200000) {
    guard++;
    const X = -approachL + 0.4 + rand() * (approachL - 0.9);
    const Y = -hy + 0.4 + rand() * (approachW - 0.8);
    let ok = true;
    for (let i = 0; i < crowd.n; i++) {
      if (Math.hypot(crowd.x[i] - X, crowd.y[i] - Y) < 2 * o.r + 0.06) { ok = false; break; }
    }
    if (!ok) continue;
    for (const ob of obstacles) if (Math.hypot(X - ob.x, Y - ob.y) < ob.r + o.r + 0.05) ok = false;
    if (!ok) continue;
    let v0 = o.v0mean + o.v0sd * gauss(rand);
    v0 = Math.max(0.6, Math.min(2.0, v0));
    crowd.spawn({ x: X, y: Y, v0, tau: o.tau, r: o.r, m: o.m, field: 0 });
    placed++;
  }

  const zone = new ZoneRecorder(
    o.zoneShape === 'strip'
      ? { x0: -(o.zoneArea / approachW), y0: -hy, x1: 0, y1: hy }   // 6.0 x 0.72
      : { x0: -(o.zoneArea / W), y0: -ay, x1: 0, y1: ay });          // 1.2 x 3.6
  const exit = new ExitCounter(0, -ay, 0, ay, W);

  return { crowd, nav, zone, exit, opts: o, walls, obstacles };
}

export function runBenchmark(opts = {}) {
  const scn = buildBenchmark(opts);
  const { crowd, zone, exit, opts: o } = scn;
  const steps = Math.round(o.tmax / o.dt);
  const ns = Math.max(1, o.substeps | 0), hdt = o.dt / ns;
  outer:
  for (let s = 0; s < steps; s++) {
    for (let k = 0; k < ns; k++) {
      crowd.step(hdt);
      exit.update(crowd);
      for (let i = 0; i < crowd.n; i++) {
        if (crowd.active[i] && crowd.x[i] > o.exitL - 0.2) crowd.deactivate(i);
      }
      if (exit.times.length >= o.N) { zone.sample(crowd); zone.sampleField(crowd); break outer; }
    }
    zone.sample(crowd);   // observables sampled at the paper's 0.03 s cadence
    if ((s % zone.fieldEvery) === 0) zone.sampleField(crowd);
  }
  const ex = exit.summary(), zs = zone.summary();
  return {
    ...ex, ...zs,
    passRate: ex.N / o.N,
    tEnd: crowd.t,
    opts: o,
  };
}
