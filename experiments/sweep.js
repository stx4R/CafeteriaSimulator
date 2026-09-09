// The experiment the paper is missing.
//
// The published study varied obstacle geometry (d*, l*, x*) and found no
// arrangement that improved throughput and safety together. This sweep varies
// the two things the school actually controls and the paper never touched:
//
//   headway     - the tempo of the 3-10 release rule (s between classes)
//   routePolicy - shortest-path self-selection vs. an enforced split across the
//                 two mandatory corridors
//
// Reported per condition: door flow, headway variability, density and crowd
// pressure at the door, makespan, peak outdoor crowd, and the realised split.

import fs from 'node:fs';
import { CampusSim } from '../core/run.js';
import { mean, ci95 } from '../core/metrics.js';

const cfg = JSON.parse(fs.readFileSync(new URL('../data/campus.json', import.meta.url)));

const HEADWAYS = [20, 30, 45, 60, 90];
const POLICIES = [
  { id: 'shortest', routePolicy: 'shortest' },
  { id: 'split50', routePolicy: 'split', splitA: 0.5 },
  { id: 'split30', routePolicy: 'split', splitA: 0.3 },
];
const SEEDS = [1, 2, 3];
const TMAX = 5400;

const KEYS = ['doorQ', 'doorCVh', 'rho95', 'P95', 'makespan', 'doorSpan',
              'peakOutdoor', 'peakQueue', 'completion', 'stranded', 'rescued'];

function runOne(opts) {
  const sim = new CampusSim(cfg, opts);
  const maxK = Math.round(TMAX / sim.o.dt);
  for (let k = 0; k < maxK; k++) {
    sim.step();
    if ((k & 255) === 0 && sim.isComplete()) break;
  }
  const s = sim.summary();
  s.splitA = s.routeSplit[0] / (s.routeSplit[0] + s.routeSplit[1]);
  s.history = sim.history;
  return s;
}

const out = [];
const t0 = Date.now();
for (const hw of HEADWAYS) {
  for (const pol of POLICIES) {
    const runs = SEEDS.map((seed) => runOne({ seed, headway: hw, ...pol }));
    const agg = { headway: hw, policy: pol.id };
    for (const k of KEYS) {
      const v = runs.map((r) => r[k]).filter(Number.isFinite);
      agg[k] = { mean: mean(v), ci: ci95(v) };
    }
    agg.splitA = mean(runs.map((r) => r.splitA));
    agg.history = runs[0].history;
    out.push(agg);
    console.log(
      `hw=${String(hw).padStart(2)} ${pol.id.padEnd(8)} ` +
      `Q=${agg.doorQ.mean.toFixed(3)} CVh=${agg.doorCVh.mean.toFixed(2)} ` +
      `rho95=${agg.rho95.mean.toFixed(2)} P95=${agg.P95.mean.toFixed(2)} ` +
      `makespan=${Math.round(agg.makespan.mean)}s peakOut=${Math.round(agg.peakOutdoor.mean)} ` +
      `A:B=${(100 * agg.splitA).toFixed(0)}:${(100 * (1 - agg.splitA)).toFixed(0)} ` +
      `done=${agg.completion.mean.toFixed(3)} resc=${agg.rescued.mean.toFixed(1)} ` +
      `[${((Date.now() - t0) / 1000).toFixed(0)}s]`);
    fs.writeFileSync(new URL('../data/sweep.json', import.meta.url), JSON.stringify(out, null, 1));
  }
}
console.log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min -> data/sweep.json`);
