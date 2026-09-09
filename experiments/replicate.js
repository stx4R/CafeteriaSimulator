// M2 gate: does the JS social-force core reproduce the paper's no-obstacle
// baseline (Table 1) inside its 95 % confidence interval?
//
//   Q     = 2.008 +- 0.040 person/s
//   rho95 = 3.017 +- 0.014 person/m^2
//   P95   = 1.431 +- 0.047 s^-2
//   CVh   = 0.612 +- 0.032

import fs from 'node:fs';
import { runBenchmark } from '../core/benchmark.js';

/** constants identified in experiments/calibrate.js, stored beside the data */
export const CAL = JSON.parse(fs.readFileSync(new URL('../data/calibration.json', import.meta.url)));
import { mean, ci95 } from '../core/metrics.js';

export const TARGET = {
  Q:     { v: 2.008, ci: 0.040 },
  rho95: { v: 3.017, ci: 0.014 },
  P95:   { v: 1.431, ci: 0.047 },
  CVh:   { v: 0.612, ci: 0.032 },
};

export function runCondition(opts, seeds = [1,2,3,4,5,6,7,8,9,10]) {
  const base = { approachL: CAL.approachL, force: { A: CAL.A, B: CAL.B }, substeps: CAL.substeps };
  const runs = seeds.map((seed) => runBenchmark({ ...base, ...opts, seed,
    force: { ...base.force, ...(opts.force || {}) } }));
  const agg = {};
  for (const key of ['Q', 'Js', 'rho95', 'P95', 'CVh', 'meanH', 'passRate', 'rhoMean', 'Pmean', 'varLat95', 'tEnd']) {
    const vals = runs.map((r) => r[key]).filter(Number.isFinite);
    agg[key] = { mean: mean(vals), ci: ci95(vals), n: vals.length };
  }
  agg._runs = runs;
  return agg;
}

function fmt(name, got, tgt) {
  const inside = Math.abs(got.mean - tgt.v) <= (tgt.ci + got.ci);
  const dev = 100 * (got.mean - tgt.v) / tgt.v;
  return `  ${name.padEnd(6)} sim ${got.mean.toFixed(3)} +-${got.ci.toFixed(3)}   ` +
         `paper ${tgt.v.toFixed(3)} +-${tgt.ci.toFixed(3)}   ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%  ${inside ? 'PASS' : 'fail'}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const approachL = Number(process.argv[2] ?? 8.0);
  console.log(`no-obstacle baseline, approachL = ${approachL} m, 10 seeds`);
  const t0 = Date.now();
  const agg = runCondition({ approachL });
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const k of ['Q', 'rho95', 'P95', 'CVh']) console.log(fmt(k, agg[k], TARGET[k]));
  console.log(`  Js     ${agg.Js.mean.toFixed(3)} person/(m s)      passRate ${agg.passRate.mean.toFixed(3)}   tEnd ${agg.tEnd.mean.toFixed(1)} s`);
}
