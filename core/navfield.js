// Navigation field: solves the eikonal equation |grad T| = 1 on a regular grid
// with Fast Marching, giving an isotropic travel-time-to-target field.
// The negative gradient of T is the agents' desired walking direction.
//
// Plain Dijkstra on an 8-neighbour lattice has ~8% metrication error, which
// biases walking directions near a bottleneck. FMM keeps that under ~1%.

const FAR = 0, NARROW = 1, FROZEN = 2;

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v, n = k.length;
    const topK = k[0], topV = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (n > 1) {
      k[0] = lastK; v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < k.length && k[l] < k[s]) s = l;
        if (r < k.length && k[r] < k[s]) s = r;
        if (s === i) break;
        [k[s], k[i]] = [k[i], k[s]]; [v[s], v[i]] = [v[i], v[s]]; i = s;
      }
    }
    return [topK, topV];
  }
}

export class NavField {
  /**
   * @param {object} o
   * @param {number} o.x0,o.y0   world coords of grid origin (metres)
   * @param {number} o.w,o.h     grid size in cells
   * @param {number} o.cell      cell size (metres)
   * @param {Uint8Array} o.blocked  1 = obstacle / wall, 0 = free   (length w*h)
   */
  constructor({ x0, y0, w, h, cell, blocked }) {
    Object.assign(this, { x0, y0, w, h, cell, blocked });
    this.T = new Float64Array(w * h).fill(Infinity);
    this.state = new Uint8Array(w * h);
  }

  idx(i, j) { return j * this.w + i; }

  /** Seed cells (world-space points or a predicate) then march. */
  solve(seedCells) {
    const { w, h, cell, blocked, T, state } = this;
    const heap = new MinHeap();
    for (const c of seedCells) {
      if (blocked[c]) continue;
      T[c] = 0; state[c] = NARROW; heap.push(0, c);
    }
    const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (heap.size) {
      const [t, c] = heap.pop();
      if (state[c] === FROZEN) continue;
      if (t > T[c]) continue;
      state[c] = FROZEN;
      const i = c % w, j = (c / w) | 0;
      for (const [di, dj] of NB) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nc = nj * w + ni;
        if (blocked[nc] || state[nc] === FROZEN) continue;
        const nt = this.#solveCell(ni, nj);
        if (nt < T[nc]) { T[nc] = nt; state[nc] = NARROW; heap.push(T[nc], nc); }
      }
    }
    return this;
  }

  // Godunov upwind update for |grad T| = 1 (unit speed)
  #solveCell(i, j) {
    const { w, h, cell, T, blocked } = this;
    let a = Infinity, b = Infinity;
    if (i > 0 && !blocked[j * w + i - 1]) a = Math.min(a, T[j * w + i - 1]);
    if (i < w - 1 && !blocked[j * w + i + 1]) a = Math.min(a, T[j * w + i + 1]);
    if (j > 0 && !blocked[(j - 1) * w + i]) b = Math.min(b, T[(j - 1) * w + i]);
    if (j < h - 1 && !blocked[(j + 1) * w + i]) b = Math.min(b, T[(j + 1) * w + i]);
    if (a === Infinity && b === Infinity) return Infinity;
    if (a === Infinity) return b + cell;
    if (b === Infinity) return a + cell;
    const diff = a - b;
    if (Math.abs(diff) >= cell) return Math.min(a, b) + cell;
    // two-sided update
    const s = a + b, d = 2 * cell * cell - diff * diff;
    return 0.5 * (s + Math.sqrt(d));
  }

  /** Unit descent direction of T at world point (x,y). */
  dir(x, y, out) {
    const { x0, y0, w, h, cell, T, blocked } = this;
    const i = Math.max(1, Math.min(w - 2, Math.round((x - x0) / cell)));
    const j = Math.max(1, Math.min(h - 2, Math.round((y - y0) / cell)));
    const c = j * w + i;
    const ok = (idx) => !blocked[idx] && Number.isFinite(T[idx]);

    // If we are standing on a blocked / unreachable cell, walk to the best
    // reachable neighbour in a small window instead of differencing garbage.
    if (!ok(c)) {
      let bi = -1, bj = -1, best = Infinity;
      const R = this.escapeRadius ?? 12;
      for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
        const idx = jj * w + ii;
        if (ok(idx) && T[idx] < best) { best = T[idx]; bi = ii; bj = jj; }
      }
      if (bi < 0) { out[0] = 0; out[1] = 0; return out; }
      const dx = (x0 + bi * cell) - x, dy = (y0 + bj * cell) - y;
      const n = Math.hypot(dx, dy) || 1e-9;
      out[0] = dx / n; out[1] = dy / n;
      return out;
    }

    // One-sided differences wherever the opposite neighbour is unusable, so a
    // wall next door no longer injects a spurious 1e6 gradient.
    const Tc = T[c];
    const l = c - 1, r = c + 1, u = c - w, d = c + w;
    let gx;
    if (ok(l) && ok(r)) gx = (T[r] - T[l]) / (2 * cell);
    else if (ok(r)) gx = (T[r] - Tc) / cell;
    else if (ok(l)) gx = (Tc - T[l]) / cell;
    else gx = 0;
    let gy;
    if (ok(u) && ok(d)) gy = (T[d] - T[u]) / (2 * cell);
    else if (ok(d)) gy = (T[d] - Tc) / cell;
    else if (ok(u)) gy = (Tc - T[u]) / cell;
    else gy = 0;

    const n = Math.hypot(gx, gy);
    if (n < 1e-9) { out[0] = 0; out[1] = 0; return out; }
    out[0] = -gx / n; out[1] = -gy / n;
    return out;
  }

  valueAt(x, y) {
    const { x0, y0, w, h, cell, T } = this;
    const i = Math.max(0, Math.min(w - 1, Math.round((x - x0) / cell)));
    const j = Math.max(0, Math.min(h - 1, Math.round((y - y0) / cell)));
    return T[j * w + i];
  }
}
