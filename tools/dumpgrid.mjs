import fs from 'node:fs';
import { buildCampus } from '../core/campus.js';
const cfg = JSON.parse(fs.readFileSync(new URL('../data/campus.json', import.meta.url)));
const scn = buildCampus(cfg);
const { grid, routes, fields, F } = scn;
const { w, h, cell, x0, y0, blocked } = grid;
const out = { w, h, cell, x0, y0,
  blocked: Array.from(blocked),
  maskA: Array.from(routes.A.mask), maskB: Array.from(routes.B.mask),
  TrunA: Array.from(fields[F.runA].T, v => Number.isFinite(v) ? +v.toFixed(2) : -1),
  TrunB: Array.from(fields[F.runB].T, v => Number.isFinite(v) ? +v.toFixed(2) : -1),
  TgateB: Array.from(fields[F.gateB].T, v => Number.isFinite(v) ? +v.toFixed(2) : -1),
};
fs.writeFileSync('/tmp/grid.json', JSON.stringify(out));
const cnt = (a,f)=>a.reduce((s,v)=>s+(f(v)?1:0),0);
console.log('blocked', cnt(out.blocked,v=>v), '/', w*h);
console.log('maskA', cnt(out.maskA,v=>v), ' maskB', cnt(out.maskB,v=>v));
console.log('TrunA reachable', cnt(out.TrunA,v=>v>=0), ' TrunB reachable', cnt(out.TrunB,v=>v>=0));
console.log('door', cfg.door, 'doorTimesSegment', scn.door.x1, scn.door.y1, scn.door.x2, scn.door.y2, 'n', scn.door.nx, scn.door.ny);
