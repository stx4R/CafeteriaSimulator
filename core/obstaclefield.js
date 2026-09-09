// Signed distance-to-obstacle field with outward normals.
//
// At campus scale the per-agent loop over wall segments dominates the step cost
// and cannot express traced polygons cheaply. The blocked grid is turned once
// into (signed distance, outward normal) lookups, so the wall term in the social
// force model is two array reads per agent.
//
// Sign convention: positive in free space (distance to the nearest obstacle),
// negative inside an obstacle (depth), with the normal always pointing towards
// free space. An agent that ends up inside geometry is therefore pushed out
// instead of receiving zero force.

// 1-D squared EDT (Felzenszwalb & Huttenlocher) with argmin tracking.
function edt1d(f, n) {
  const D = new Float64Array(n), A = new Int32Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    D[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    A[q] = v[k];
  }
  return { D, A };
}

/** squared distance + nearest-seed (i,j) for every cell, seeds where mask==1 */
function edt2d(mask, w, h) {
  const INF = 1e12;
  const d1 = new Float64Array(w * h), a1 = new Int32Array(w * h);
  const col = new Float64Array(h);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) col[j] = mask[j * w + i] ? 0 : INF;
    const { D, A } = edt1d(col, h);
    for (let j = 0; j < h; j++) { d1[j * w + i] = D[j]; a1[j * w + i] = A[j]; }
  }
  const dist = new Float64Array(w * h);
  const si = new Int32Array(w * h), sj = new Int32Array(w * h);
  const row = new Float64Array(w);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) row[i] = d1[j * w + i];
    const { D, A } = edt1d(row, w);
    for (let i = 0; i < w; i++) {
      const c = j * w + i;
      dist[c] = D[i];
      si[c] = A[i];
      sj[c] = a1[j * w + A[i]];
    }
  }
  return { dist, si, sj };
}

export class ObstacleField {
  /** @param {{x0:number,y0:number,w:number,h:number,cell:number,blocked:Uint8Array}} g */
  constructor({ x0, y0, w, h, cell, blocked }) {
    Object.assign(this, { x0, y0, w, h, cell, blocked });
    const N = w * h;
    const free = new Uint8Array(N);
    for (let c = 0; c < N; c++) free[c] = blocked[c] ? 0 : 1;

    const out = edt2d(blocked, w, h);   // for free cells: distance to obstacle
    const inn = edt2d(free, w, h);      // for blocked cells: depth inside

    this.dist = new Float64Array(N);
    this.nx = new Float64Array(N);
    this.ny = new Float64Array(N);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const c = j * w + i;
      let dx, dy, dm;
      if (blocked[c]) {
        this.dist[c] = -Math.sqrt(inn.dist[c]) * cell;
        dx = inn.si[c] - i; dy = inn.sj[c] - j;      // point towards free space
      } else {
        this.dist[c] = Math.sqrt(out.dist[c]) * cell;
        dx = i - out.si[c]; dy = j - out.sj[c];      // point away from obstacle
      }
      dm = Math.hypot(dx, dy);
      if (dm < 1e-9) { this.nx[c] = 0; this.ny[c] = 0; }
      else { this.nx[c] = dx / dm; this.ny[c] = dy / dm; }
    }
  }

  /** out = [signedDistance_m, normalX, normalY] at world (x,y) */
  sample(x, y, out) {
    const { x0, y0, w, h, cell, dist, nx, ny } = this;
    let i = Math.round((x - x0) / cell), j = Math.round((y - y0) / cell);
    if (i < 0) i = 0; else if (i >= w) i = w - 1;
    if (j < 0) j = 0; else if (j >= h) j = h - 1;
    const c = j * w + i;
    out[0] = dist[c]; out[1] = nx[c]; out[2] = ny[c];
    return out;
  }
}
