// Observables defined in section 2.2 of the paper.
//   rho  = N / A                 in a fixed measurement zone
//   Q    = N_out / T             through the exit line
//   Js   = Q / W                 specific flow
//   h_i  = t_i - t_{i-1}         passage headways,  CVh = s_h / mean_h
//   P    = rho * Var(v)          crowd pressure (Helbing 2007), NOT an SI pressure
// rho95 / P95 are the 95th percentiles of the time series, used instead of the
// single maximum to suppress numerical noise (paper, section 3.2).

export function percentile(arr, q) {
  if (!arr.length) return NaN;
  const a = Float64Array.from(arr).sort();
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
export const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
export function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
/** 95 % confidence interval half-width of the mean (normal approximation). */
export function ci95(a) { return a.length < 2 ? 0 : 1.96 * std(a) / Math.sqrt(a.length); }

export class ZoneRecorder {
  /**
   * rect zone {x0,y0,x1,y1} in world metres.
   * Two pressure conventions are recorded, because the paper cites Helbing 2007
   * for P but defines rho as the zone average N/A:
   *   P      = rho_zone * Var(v of agents in the zone)      "zone-averaged"
   *   Pfield = 95th pct of rho(r)*Var_v(r) on a lattice     "local field", as in
   *            Helbing, Johansson & Al-Abideen (2007), Gaussian kernel radius R
   */
  constructor(zone, { fieldRes = 0.2, kernelR = 0.7, fieldEvery = 3 } = {}) {
    this.zone = zone;
    this.area = Math.abs((zone.x1 - zone.x0) * (zone.y1 - zone.y0));
    this.rho = []; this.P = []; this.varV = []; this.varLat = [];
    this.nearRate = [];
    this.rhoField = []; this.Pfield = [];
    this.fieldRes = fieldRes; this.kernelR = kernelR; this.fieldEvery = fieldEvery;
    this._k = 0;
  }

  /** Gaussian-kernel local density / velocity variance on a lattice in the zone. */
  sampleField(crowd) {
    const { x, y, vx, vy, active, n } = crowd;
    const z = this.zone, R = this.kernelR, res = this.fieldRes;
    const inv = 1 / (Math.PI * R * R);
    const pad = 2 * R;
    const ids = [];
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      if (x[i] < z.x0 - pad || x[i] > z.x1 + pad || y[i] < z.y0 - pad || y[i] > z.y1 + pad) continue;
      ids.push(i);
    }
    if (ids.length < 2) { this.rhoField.push(0); this.Pfield.push(0); return; }
    let bestRho = 0, bestP = 0;
    const rhos = [], Ps = [];
    for (let gy = z.y0; gy <= z.y1 + 1e-9; gy += res) {
      for (let gx = z.x0; gx <= z.x1 + 1e-9; gx += res) {
        let wsum = 0, rho = 0, mu = 0, mv = 0;
        for (const i of ids) {
          const d2 = (x[i] - gx) ** 2 + (y[i] - gy) ** 2;
          const w = Math.exp(-d2 / (R * R));
          rho += inv * w; wsum += w; mu += w * vx[i]; mv += w * vy[i];
        }
        if (wsum < 1e-6) { rhos.push(0); Ps.push(0); continue; }
        mu /= wsum; mv /= wsum;
        let varv = 0;
        for (const i of ids) {
          const d2 = (x[i] - gx) ** 2 + (y[i] - gy) ** 2;
          const w = Math.exp(-d2 / (R * R));
          varv += w * ((vx[i] - mu) ** 2 + (vy[i] - mv) ** 2);
        }
        varv /= wsum;
        rhos.push(rho); Ps.push(rho * varv);
      }
    }
    // spatial 95th percentile at this instant, then pooled over time
    this.rhoField.push(percentile(rhos, 0.95));
    this.Pfield.push(percentile(Ps, 0.95));
  }
  sample(crowd) {
    const { x, y, vx, vy, r, active, n } = crowd;
    const z = this.zone;
    const xs = [], ys = [], us = [], vs = [];
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      if (x[i] < z.x0 || x[i] > z.x1 || y[i] < z.y0 || y[i] > z.y1) continue;
      xs.push(x[i]); ys.push(y[i]); us.push(vx[i]); vs.push(vy[i]);
    }
    const N = xs.length;
    const rho = N / this.area;
    this.rho.push(rho);
    if (N < 2) { this.P.push(0); this.varV.push(0); this.varLat.push(0); this.nearRate.push(0); return; }
    const mu = mean(us), mv = mean(vs);
    let varv = 0;
    for (let i = 0; i < N; i++) varv += (us[i] - mu) ** 2 + (vs[i] - mv) ** 2;
    varv /= N;
    // lateral component: perpendicular to the mean flow direction
    const sp = Math.hypot(mu, mv) || 1e-9;
    const tx = -mv / sp, ty = mu / sp;
    let varLat = 0;
    for (let i = 0; i < N; i++) varLat += ((us[i] - mu) * tx + (vs[i] - mv) * ty) ** 2;
    varLat /= N;
    // near-contact rate: fraction of pairs closer than 1.2 * (r_i + r_j)
    let near = 0, pairs = 0;
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      pairs++;
      if (Math.hypot(xs[i] - xs[j], ys[i] - ys[j]) < 1.2 * 0.46) near++;
    }
    this.P.push(rho * varv);
    this.varV.push(varv);
    this.varLat.push(varLat);
    this.nearRate.push(pairs ? near / pairs : 0);
  }
  summary() {
    return {
      rho95: percentile(this.rho, 0.95),
      rhoMean: mean(this.rho),
      P95: percentile(this.P, 0.95),
      Pmean: mean(this.P),
      rhoField95: percentile(this.rhoField, 0.95),
      Pfield95: percentile(this.Pfield, 0.95),
      varLat95: percentile(this.varLat, 0.95),
      nearRate95: percentile(this.nearRate, 0.95),
    };
  }
}

export class ExitCounter {
  /** counts agents crossing a line segment (x1,y1)-(x2,y2) in the +normal sense */
  constructor(x1, y1, x2, y2, width) {
    Object.assign(this, { x1, y1, x2, y2 });
    const dx = x2 - x1, dy = y2 - y1;
    const L = Math.hypot(dx, dy);
    this.nx = dy / L; this.ny = -dx / L;      // unit normal
    this.W = width ?? L;
    this.times = [];
    this.prevSide = null;
  }
  side(x, y) { return (x - this.x1) * this.nx + (y - this.y1) * this.ny; }
  /** call once per step; returns array of agent indices that just crossed */
  update(crowd) {
    const { x, y, active, n, t } = crowd;
    if (!this.prevSide || this.prevSide.length < n) {
      const p = new Float64Array(crowd.capacity).fill(NaN);
      if (this.prevSide) p.set(this.prevSide);
      this.prevSide = p;
    }
    const crossed = [];
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const s = this.side(x[i], y[i]);
      const p = this.prevSide[i];
      if (!Number.isNaN(p) && p < 0 && s >= 0) {
        // require the crossing point to lie inside the segment
        const tt = ((x[i] - this.x1) * (this.x2 - this.x1) + (y[i] - this.y1) * (this.y2 - this.y1)) /
                   ((this.x2 - this.x1) ** 2 + (this.y2 - this.y1) ** 2);
        if (tt >= -0.02 && tt <= 1.02) { this.times.push(t); crossed.push(i); }
      }
      this.prevSide[i] = s;
    }
    return crossed;
  }
  headways() {
    const h = [];
    for (let i = 1; i < this.times.length; i++) h.push(this.times[i] - this.times[i - 1]);
    return h;
  }
  summary() {
    const T = this.times;
    const h = this.headways();
    const span = T.length > 1 ? T[T.length - 1] - T[0] : NaN;
    return {
      N: T.length,
      tFirst: T[0] ?? NaN,
      tLast: T[T.length - 1] ?? NaN,
      // standard bottleneck flow: (N-1) gaps over the discharge span
      Q: T.length > 1 ? (T.length - 1) / span : NaN,
      Q_fromZero: T.length ? T.length / T[T.length - 1] : NaN,
      Js: T.length > 1 ? (T.length - 1) / span / this.W : NaN,
      meanH: h.length ? h.reduce((s, v) => s + v, 0) / h.length : NaN,
      CVh: h.length > 1 ? std(h) / (h.reduce((s, v) => s + v, 0) / h.length) : NaN,
    };
  }
}
