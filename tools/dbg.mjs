import { buildBenchmark } from '../core/benchmark.js';
const s = buildBenchmark({ seed: 1, approachL: 8 });
const nav = s.nav;
console.log('grid', nav.w, 'x', nav.h, 'cell', nav.cell, 'origin', nav.x0.toFixed(2), nav.y0.toFixed(2));
const o=[0,0];
for (const [x,y] of [[-7,0],[-4,0],[-2,0],[-0.5,0],[-0.5,2.5],[-3,2.8],[0.3,0],[2,0],[3.8,0]]) {
  nav.dir(x,y,o);
  console.log(`T(${x},${y}) = ${nav.valueAt(x,y).toFixed(2)}  dir=(${o[0].toFixed(2)},${o[1].toFixed(2)})`);
}
console.log('agents spawned:', s.crowd.n);
// run and watch
const {crowd, exit, opts} = s;
for (let step=0; step<Math.round(52/0.03); step++) {
  crowd.step(0.03);
  exit.update(crowd);
  for (let i=0;i<crowd.n;i++) if (crowd.active[i] && crowd.x[i] > 3.8) crowd.deactivate(i);
  if (step % 200 === 0) {
    let act=0, meanx=0, maxx=-99, sp=0;
    for (let i=0;i<crowd.n;i++) if (crowd.active[i]) { act++; meanx+=crowd.x[i]; maxx=Math.max(maxx,crowd.x[i]); sp+=Math.hypot(crowd.vx[i],crowd.vy[i]); }
    console.log(`t=${crowd.t.toFixed(1)} active=${act} meanX=${(meanx/act).toFixed(2)} maxX=${maxx.toFixed(2)} meanSpd=${(sp/act).toFixed(2)} exited=${exit.times.length}`);
  }
}
