// The paper fixes r, m, v0, tau, dt, W and the approach width, but never states
// the Helbing force constants (A, B, k, kappa) or how long the approach region
// is - yet those control packing density and therefore Q, rho95, P95 and CVh.
//
// Rather than assume them, scan and report which set reproduces Table 1. The
// outcome is itself a finding: it pins down the paper's unstated setup.

import { runCondition, TARGET } from './replicate.js';

const KEYS = ['Q', 'rho95', 'P95', 'CVh'];

function loss(agg) {
  // normalised squared deviation, each metric weighted by its published CI
  let s = 0;
  for (const k of KEYS) {
    const d = (agg[k].mean - TARGET[k].v) / TARGET[k].v;
    s += d * d;
  }
  return Math.sqrt(s / KEYS.length);
}
function insideCount(agg) {
  return KEYS.filter((k) => Math.abs(agg[k].mean - TARGET[k].v) <= TARGET[k].ci + agg[k].ci).length;
}

const grid = [];
for (const approachL of [5, 6.5, 8, 10])
  for (const A of [1200, 2000, 3000])
    for (const B of [0.05, 0.08, 0.12, 0.16])
      grid.push({ approachL, A, B });

const seeds = [1, 2, 3, 4, 5];   // 5 seeds while scanning, 10 to confirm
const results = [];
const t0 = Date.now();
for (const g of grid) {
  const agg = runCondition({ approachL: g.approachL, force: { A: g.A, B: g.B } }, seeds);
  const L = loss(agg), ins = insideCount(agg);
  results.push({ ...g, L, ins, agg });
  process.stdout.write(
    `L=${g.approachL.toString().padStart(4)}  A=${String(g.A).padStart(4)}  B=${g.B.toFixed(2)}  ` +
    `Q=${agg.Q.mean.toFixed(3)} rho=${agg.rho95.mean.toFixed(3)} P=${agg.P95.mean.toFixed(3)} CV=${agg.CVh.mean.toFixed(3)}  ` +
    `pass=${agg.passRate.mean.toFixed(2)}  loss=${L.toFixed(4)}  in=${ins}/4\n`);
}
results.sort((a, b) => (b.ins - a.ins) || (a.L - b.L));
console.log(`\nscan done in ${((Date.now() - t0) / 1000).toFixed(0)} s. best 5:`);
for (const r of results.slice(0, 5)) {
  console.log(`  approachL=${r.approachL} A=${r.A} B=${r.B}  loss=${r.L.toFixed(4)}  inside=${r.ins}/4`);
}
const best = results[0];
console.log('\nconfirming best with 10 seeds:');
const conf = runCondition({ approachL: best.approachL, force: { A: best.A, B: best.B } },
                          [1,2,3,4,5,6,7,8,9,10]);
for (const k of KEYS) {
  const g = conf[k], t = TARGET[k];
  const ok = Math.abs(g.mean - t.v) <= t.ci + g.ci;
  console.log(`  ${k.padEnd(6)} sim ${g.mean.toFixed(3)} +-${g.ci.toFixed(3)}   paper ${t.v.toFixed(3)} +-${t.ci.toFixed(3)}   ` +
              `${((g.mean - t.v) / t.v * 100).toFixed(1)}%  ${ok ? 'PASS' : 'fail'}`);
}
console.log(JSON.stringify({ approachL: best.approachL, A: best.A, B: best.B }, null, 0));
