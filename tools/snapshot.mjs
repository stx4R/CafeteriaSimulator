import fs from 'node:fs';
import { CampusSim, STAGE } from '../core/run.js';
const cfg = JSON.parse(fs.readFileSync(new URL('../data/campus.json', import.meta.url)));
const cell = Number(process.argv[2] ?? 0.30);
const at = Number(process.argv[3] ?? 400);
const t0 = Date.now();
const sim = new CampusSim(cfg, { seed: 1, headway: 0, cell });
console.log(`cell=${cell} build ${Date.now()-t0} ms  grid ${sim.scn.grid.w}x${sim.scn.grid.h}`);
for (let k = 0; k < Math.round(at / sim.o.dt); k++) sim.step();
const { crowd } = sim.scn;
// histogram of remaining travel distance along the route, plus stage counts
const st = [0,0,0,0,0,0];
const bins = new Array(14).fill(0);
for (let i = 0; i < crowd.n; i++) {
  if (!crowd.active[i]) continue;
  st[crowd.stage[i]]++;
  const d = Math.hypot(crowd.x[i]-cfg.door.x, crowd.y[i]-cfg.door.y);
  bins[Math.min(13, Math.floor(d/10))]++;
}
console.log(`t=${sim.t.toFixed(0)}s stages toGate=${st[0]} corridor=${st[1]} queue=${st[2]} svc=${st[3]} seated=${st[4]}`);
console.log('distance-to-door histogram (10 m bins):');
bins.forEach((n,b)=>{ if(n) console.log(`  ${String(b*10).padStart(3)}-${String(b*10+10).padStart(3)} m : ${'#'.repeat(Math.round(n/12))} ${n}`); });
const s = sim.summary();
console.log(`doorQ=${s.doorQ.toFixed(3)} through=${s.throughDoor} rho95=${s.rho95.toFixed(2)} P95=${s.P95.toFixed(2)}`);
