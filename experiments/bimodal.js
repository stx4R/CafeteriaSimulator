// The sweep's makespan CI at headway 20 s was +-1577 s on three seeds: that is
// not measurement noise, it is a bimodal outcome. Either the crowd clears in
// ~900 s, or a jam forms where the two streams merge at the door and the run
// never recovers. Enforcing a corridor split is therefore not a mean
// improvement - it removes the tail. Run every seed and report them all.

import fs from 'node:fs';
import { CampusSim } from '../core/run.js';

const cfg = JSON.parse(fs.readFileSync(new URL('../data/campus.json', import.meta.url)));
const SEEDS = [1, 2, 3, 4, 5, 6];
const CASES = [
  { id: 'A-share 0 %', routePolicy: 'shortest' },
  { id: 'A-share 50 %', routePolicy: 'split', splitA: 0.5 },
];

const out = {};
for (const c of CASES) {
  out[c.id] = [];
  for (const seed of SEEDS) {
    const sim = new CampusSim(cfg, {
      seed, headway: 20, routePolicy: c.routePolicy, splitA: c.splitA,
    });
    for (let k = 0; k < Math.round(5400 / sim.o.dt); k++) {
      sim.step();
      if ((k & 255) === 0 && sim.isComplete()) break;
    }
    const s = sim.summary();
    out[c.id].push({
      seed,
      makespan: +s.makespan.toFixed(0),
      P95: +s.P95.toFixed(2),
      CVh: +s.doorCVh.toFixed(2),
      peakOutdoor: s.peakOutdoor,
      rescued: s.rescued,
      completion: +s.completion.toFixed(3),
    });
    process.stdout.write(
      `${c.id}  seed ${seed}: makespan ${Math.round(s.makespan)} s  ` +
      `P95 ${s.P95.toFixed(2)}  CVh ${s.doorCVh.toFixed(2)}  resc ${s.rescued}\n`);
    fs.writeFileSync(new URL('../data/bimodal.json', import.meta.url), JSON.stringify(out, null, 1));
  }
}
for (const k of Object.keys(out)) {
  const v = out[k].map((r) => r.makespan).sort((a, b) => a - b);
  console.log(`${k}: min ${v[0]}  median ${v[Math.floor(v.length / 2)]}  max ${v[v.length - 1]}  spread ${v[v.length - 1] - v[0]} s`);
}
