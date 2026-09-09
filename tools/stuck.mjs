import fs from 'node:fs';
import { CampusSim, STAGE } from '../core/run.js';
import { distToPolyline } from '../core/campus.js';
const cfg = JSON.parse(fs.readFileSync(new URL('../data/campus.json', import.meta.url)));
const sim = new CampusSim(cfg, { seed: 1, headway: 45 });
for (let k = 0; k < Math.round(1800 / sim.o.dt); k++) sim.step();
const { crowd, routes, fields, F } = sim.scn;
const rows = [];
for (let i = 0; i < crowd.n; i++) {
  if (!crowd.active[i]) continue;
  if (crowd.stage[i] >= STAGE.QUEUE) continue;
  const key = sim.route[i] === 0 ? 'A' : 'B';
  const rd = distToPolyline(crowd.x[i], crowd.y[i], routes[key].polyline);
  rows.push({ i, st: crowd.stage[i], rt: key,
    x: +crowd.x[i].toFixed(1), y: +crowd.y[i].toFixed(1),
    v: +Math.hypot(crowd.vx[i], crowd.vy[i]).toFixed(2),
    dRoute: +rd.dist.toFixed(1), s: +rd.s.toFixed(1),
    Tgate: fields[key==='A'?F.gateA:F.gateB].valueAt(crowd.x[i],crowd.y[i]),
    Trun:  fields[key==='A'?F.runA:F.runB].valueAt(crowd.x[i],crowd.y[i]) });
}
console.log('stranded outdoors:', rows.length);
console.table(rows.slice(0, 30));
