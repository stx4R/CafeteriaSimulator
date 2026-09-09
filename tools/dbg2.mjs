import fs from 'node:fs';
import { CampusSim } from '../core/run.js';
const cfg = JSON.parse(fs.readFileSync(new URL('../data/campus.json', import.meta.url)));
console.time('build');
const sim = new CampusSim(cfg, { seed: 1, headway: 45 });
console.timeEnd('build');
console.log(`grid ${sim.scn.grid.w} x ${sim.scn.grid.h} @ ${sim.scn.grid.cell} m`);
console.log(`schedule: ${sim.sched.plan.length} classes, last release ${sim.sched.plan.at(-1).t.toFixed(0)} s, grade order ${sim.sched.grades.map(g=>g+1).join('->')}`);
console.log('\nexit snapping + walking distance (nav field, metres):');
for (const e of sim.scn.exits) {
  const t = sim.travel[e.id];
  const A = Number.isFinite(t.viaA) ? t.viaA.toFixed(1) : 'X';
  const B = Number.isFinite(t.viaB) ? t.viaB.toFixed(1) : 'X';
  console.log(`  ${e.id}  moved ${e.movedBy.toFixed(1)} m -> (${e.x.toFixed(1)},${e.y.toFixed(1)})   viaA ${A}   viaB ${B}   picks ${t.viaA<=t.viaB?'A':'B'}`);
}
console.time('sim');
let last = 0;
const T = 2400;
for (let k = 0; k < Math.round(T / sim.o.dt); k++) {
  sim.step();
  if (sim.t - last >= 180) {
    last = sim.t; const c = sim.counts();
    console.log(`t=${(sim.t/60).toFixed(1).padStart(4)}min  spawned=${String(c.spawned).padStart(4)} outdoor=${String(c.outdoor).padStart(4)} queue=${String(c.queue).padStart(3)} seated=${String(c.seated).padStart(3)} door=${String(c.throughDoor).padStart(4)} served=${c.served}`);
  }
  if (sim.counts().served >= 1020) break;
}
console.timeEnd('sim');
console.log('\n' + JSON.stringify(sim.summary(), null, 1));
