// Full-campus scenario: 4 building exits -> free movement across the plaza ->
// one of two mandatory corridors -> a single cafeteria door -> serving lines ->
// seats -> tray return, with class release governed by the school's 3-10 rule.

import { Crowd, rng, gauss } from './sfm.js';
import { NavField } from './navfield.js';
import { ObstacleField } from './obstaclefield.js';
import { ZoneRecorder, ExitCounter } from './metrics.js';

const D2R = Math.PI / 180;

// ---------- geometry helpers ----------
export function barPolygon(start, angleDeg, length, halfWidth) {
  const a = angleDeg * D2R;
  const ux = Math.cos(a), uy = Math.sin(a);
  const nx = -uy, ny = ux;
  const [sx, sy] = start;
  return [
    [sx + nx * halfWidth, sy + ny * halfWidth],
    [sx + ux * length + nx * halfWidth, sy + uy * length + ny * halfWidth],
    [sx + ux * length - nx * halfWidth, sy + uy * length - ny * halfWidth],
    [sx - nx * halfWidth, sy - ny * halfWidth],
  ];
}
export function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** allocation-free variant: writes [dist, s] into `out` */
export function distToPolylineInto(px, py, pts, out) {
  let best = Infinity, acc = 0, bestS = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1], L2 = dx * dx + dy * dy;
    let t = L2 < 1e-12 ? 0 : ((px - p1[0]) * dx + (py - p1[1]) * dy) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (p1[0] + t * dx), ey = py - (p1[1] + t * dy);
    const d = Math.sqrt(ex * ex + ey * ey);
    const L = Math.sqrt(L2);
    if (d < best) { best = d; bestS = acc + t * L; }
    acc += L;
  }
  out[0] = best; out[1] = bestS;
  return out;
}

export function distToPolyline(px, py, pts) {
  let best = Infinity, bestT = 0, acc = 0, bestS = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    let t = L2 < 1e-12 ? 0 : ((px - x1) * dx + (py - y1) * dy) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = x1 + t * dx, cy = y1 + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) { best = d; bestS = acc + t * Math.sqrt(L2); }
    acc += Math.sqrt(L2);
  }
  return { dist: best, s: bestS, total: acc };
}
export function polylineLength(pts) {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return L;
}

// ---------- scenario ----------
export function buildCampus(cfg, opts = {}) {
  const o = {
    cell: 0.30,
    seed: 1,
    doorWidth: cfg.door.width,
    routeWidthA: cfg.routes.A.width,
    routeWidthB: cfg.routes.B.width,
    mergeApron: 5.0,           // radius of the shared merge zone at the door (m)
    routePolicy: 'shortest',   // 'shortest' | 'split' | 'assign'
    splitA: 0.5,               // used when routePolicy === 'split'
    force: {},
    ...opts,
  };

  const dom = cfg.domain;
  const cell = o.cell;
  const gw = Math.ceil((dom.x1 - dom.x0) / cell) + 1;
  const gh = Math.ceil((dom.y1 - dom.y0) / cell) + 1;
  const GX = (i) => dom.x0 + i * cell, GY = (j) => dom.y0 + j * cell;

  // --- solid geometry -------------------------------------------------------
  const solids = [];
  for (const b of cfg.buildings) {
    const poly = b.kind === 'bar' ? barPolygon(b.start, b.angle_deg, b.length, b.halfWidth) : b.poly;
    solids.push({ id: b.id, poly, height: b.height });
  }
  for (const b of cfg.blockers) solids.push({ id: b.id, poly: b.poly, height: 0 });

  const blocked = new Uint8Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const X = GX(i), Y = GY(j);
    let b = 0;
    for (const s of solids) if (pointInPoly(X, Y, s.poly)) { b = 1; break; }
    if (!b) for (const t of cfg.treeIslands) if (Math.hypot(X - t.x, Y - t.y) < t.r) { b = 1; break; }
    blocked[j * gw + i] = b;
  }
  // carve the cafeteria doorway back open
  const dw = o.doorWidth;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const X = GX(i), Y = GY(j);
    if (Math.abs(X - cfg.door.x) <= dw / 2 + cell && Math.abs(Y - cfg.door.y) <= 3.0) blocked[j * gw + i] = 0;
  }

  const grid = { x0: dom.x0, y0: dom.y0, w: gw, h: gh, cell, blocked };
  const obstacleField = new ObstacleField(grid);

  // The red boxes mark doors ON the building, so their centres land inside the
  // traced footprint. Push each spawn point out to the nearest free cell with
  // enough clearance for a spawn cluster.
  const exits = cfg.exits.map((e) => {
    const need = Math.max(e.w, e.h) / 2 + 0.6;
    let best = null, bestD = Infinity;
    const R = Math.ceil(28 / cell);
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const i = Math.round((e.x - dom.x0) / cell) + di;
      const j = Math.round((e.y - dom.y0) / cell) + dj;
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      if (blocked[j * gw + i]) continue;
      const s3 = [0, 0, 0];
      obstacleField.sample(GX(i), GY(j), s3);
      if (s3[0] < need) continue;
      const d = Math.hypot(GX(i) - e.x, GY(j) - e.y);
      if (d < bestD) { bestD = d; best = [GX(i), GY(j)]; }
    }
    return best ? { ...e, x: best[0], y: best[1], movedBy: bestD, origin: [e.x, e.y] }
                : { ...e, movedBy: 0, origin: [e.x, e.y], unreachable: true };
  });

  // Seeds sit ~2 m past the threshold, otherwise the field bottoms out at the
  // door line and nobody ever crosses it.
  const doorIn = [cfg.door.x + cfg.door.normal[0] * 2.0, cfg.door.y + cfg.door.normal[1] * 2.0];

  // --- corridors ------------------------------------------------------------
  // The traced green lines stop a few metres short of the door, which leaves the
  // corridor mask disconnected from the doorway. Extend each one to the
  // threshold: that also gives the two streams a shared merge apron, which is
  // the structure the paper's single symmetric funnel cannot represent.
  const routes = {};
  for (const key of ['A', 'B']) {
    const pl = cfg.routes[key].polyline;
    const plExt = [...pl, [cfg.door.x, cfg.door.y], doorIn];
    const width = key === 'A' ? o.routeWidthA : o.routeWidthB;
    const mask = new Uint8Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const c = j * gw + i;
      if (blocked[c]) continue;
      const d = distToPolyline(GX(i), GY(j), plExt).dist;
      // taper the last few metres down to the door width
      const near = Math.hypot(GX(i) - cfg.door.x, GY(j) - cfg.door.y);
      const w = near < 4 ? Math.max(dw, width * (near / 4)) : width;
      if (d <= w / 2) mask[c] = 1;
      // Both streams need a shared apron in front of the door; without it a
      // pedestrian squeezed sideways out of the funnel lands on a cell where no
      // corridor field is defined and simply stops. This apron is also the
      // structure the paper's single symmetric funnel cannot represent.
      if (near <= o.mergeApron) mask[c] = 1;
    }
    routes[key] = { polyline: pl, polylineExt: plExt, width, mask, length: polylineLength(pl) };
  }
  const doorSeeds = [];
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const X = GX(i), Y = GY(j);
    if (Math.hypot(X - doorIn[0], Y - doorIn[1]) <= Math.max(dw / 2, cell * 1.5)) doorSeeds.push(j * gw + i);
  }

  // field 0/1: inside corridor A / B, heading for the door
  const fields = [];
  for (const key of ['A', 'B']) {
    const m = routes[key].mask;
    const bl = new Uint8Array(gw * gh);
    for (let c = 0; c < gw * gh; c++) bl[c] = m[c] ? 0 : 1;
    for (const c of doorSeeds) bl[c] = 0;
    fields.push(new NavField({ ...grid, blocked: bl }).solve(doorSeeds));
  }
  // field 2/3: anywhere in free space, heading for the mouth of corridor A / B
  for (const key of ['A', 'B']) {
    const pl = routes[key].polyline;
    const [hx, hy] = pl[0];
    const seeds = [];
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const c = j * gw + i;
      if (!blocked[c] && Math.hypot(GX(i) - hx, GY(j) - hy) <= routes[key].width / 2) seeds.push(c);
    }
    fields.push(new NavField({ ...grid, blocked }).solve(seeds));
  }
  const F = { runA: 0, runB: 1, gateA: 2, gateB: 3 };

  // Geometry sanity: every route waypoint must sit in free space, and the whole
  // corridor must be reachable from the door. Traced polygons are easy to get
  // wrong, so fail loudly with the offending coordinate instead of silently
  // simulating a crowd that can never arrive.
  const issues = [];
  for (const key of ['A', 'B']) {
    cfg.routes[key].polyline.forEach((pt, k) => {
      const i = Math.round((pt[0] - dom.x0) / cell), j = Math.round((pt[1] - dom.y0) / cell);
      const c = j * gw + i;
      if (i < 0 || j < 0 || i >= gw || j >= gh) issues.push(`route ${key} waypoint ${k} ${JSON.stringify(pt)} is outside the domain`);
      else if (blocked[c]) issues.push(`route ${key} waypoint ${k} ${JSON.stringify(pt)} is inside solid geometry`);
      else if (!Number.isFinite(fields[key === 'A' ? 0 : 1].valueAt(pt[0], pt[1])))
        issues.push(`route ${key} waypoint ${k} ${JSON.stringify(pt)} cannot reach the door through corridor ${key}`);
    });
    const reach = fields[key === 'A' ? 0 : 1].T.reduce((s2, v) => s2 + (Number.isFinite(v) ? 1 : 0), 0);
    const total = routes[key].mask.reduce((s2, v) => s2 + v, 0);
    if (total && reach / total < 0.85) issues.push(`corridor ${key}: only ${reach}/${total} cells reach the door`);
  }
  for (const e of exits) if (e.unreachable) issues.push(`exit ${e.id} has no free cell within 28 m`);
  if (issues.length) { console.warn('[campus] geometry problems:'); for (const s2 of issues) console.warn('   - ' + s2); }

  const cap = cfg.population.grades * cfg.population.classesPerGrade * cfg.population.studentsPerClass
            + cfg.population.teachers + 32;
  const crowd = new Crowd({
    capacity: cap,
    bounds: { x0: dom.x0, y0: dom.y0, w: dom.x1 - dom.x0, h: dom.y1 - dom.y0 },
    params: { dt: 0.03, ...o.force },
  });
  crowd.obstacleField = obstacleField;
  for (const f of fields) crowd.addField(f);

  // ExitCounter's normal is (dy,-dx)/L, so order the endpoints such that the
  // normal points into the hall (along cfg.door.normal).
  // The doorway is carved one cell wider than the nominal opening, so the
  // detector segment has to be wider still - otherwise a pedestrian can slip
  // through the carve past the end of the segment and never be counted.
  const dn = cfg.door.normal;
  const det = dw / 2 + 1.5 * cell;
  let ax = cfg.door.x - det, bx = cfg.door.x + det;
  let door = new ExitCounter(ax, cfg.door.y, bx, cfg.door.y, dw);
  if (door.nx * dn[0] + door.ny * dn[1] < 0) door = new ExitCounter(bx, cfg.door.y, ax, cfg.door.y, dw);
  const doorZone = new ZoneRecorder({
    x0: cfg.door.x - 3.0, y0: cfg.door.y - 3.6, x1: cfg.door.x + 3.0, y1: cfg.door.y,
  });   // 6.0 x 3.6 m immediately upstream of the door

  return { cfg, opts: o, grid, obstacleField, fields, F, routes, crowd, door, doorZone, solids, exits, issues,
           travel: routeTravelEstimates({ ...cfg, exits }, fields, F, routes) };
}

/** expected walking distance from each exit through each route, using the fields */
export function routeTravelEstimates(cfg, fields, F, routes) {
  const out = {};
  for (const e of cfg.exits) {
    const gA = fields[F.gateA].valueAt(e.x, e.y);
    const gB = fields[F.gateB].valueAt(e.x, e.y);
    out[e.id] = {
      viaA: Number.isFinite(gA) ? gA + routes.A.length : Infinity,
      viaB: Number.isFinite(gB) ? gB + routes.B.length : Infinity,
    };
  }
  return out;
}

// ---------- the 3-10 release rule ----------
/**
 * Grades are served one after another in a random order; within a grade the ten
 * classes are released in a random order. A grade only starts once every class
 * of the previous grade has been released.
 */
export function buildSchedule(cfg, { seed = 1, headway = 45, gradeGap = 0, order = null } = {}) {
  const rand = rng(seed);
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const G = cfg.population.grades, C = cfg.population.classesPerGrade;
  const grades = order?.grades ?? shuffle([...Array(G).keys()]);
  const plan = [];
  let t = 0;
  for (const g of grades) {
    const classes = order?.classes?.[g] ?? shuffle([...Array(C).keys()]);
    for (const c of classes) { plan.push({ grade: g + 1, klass: c + 1, t }); t += headway; }
    t += gradeGap;
  }
  return { plan, totalReleaseTime: t, grades };
}
