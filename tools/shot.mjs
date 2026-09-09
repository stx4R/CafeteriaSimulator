import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', m => { if (m.type()==='error') errs.push('CONSOLE: '+m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR: '+e.message));
await p.goto('file:///home/claude/cafsim/dist/simulator.html');
await p.waitForTimeout(9000);
await p.screenshot({ path: '/tmp/shot1.png' });
const hud = await p.evaluate(() => ({
  door: document.getElementById('hDoor').textContent,
  out: document.getElementById('hOut').textContent,
  time: document.getElementById('hTime').textContent,
  note: document.getElementById('routeNote').textContent.slice(0,140),
  loadHidden: document.getElementById('load').classList.contains('hide'),
}));
console.log(JSON.stringify(hud, null, 1));
// speed up and run further
await p.click('#bx30');
await p.waitForTimeout(12000);
await p.screenshot({ path: '/tmp/shot2.png' });
console.log('after 30x:', JSON.stringify(await p.evaluate(() => ({
  door: document.getElementById('hDoor').textContent,
  q: document.getElementById('hQ').textContent,
  seat: document.getElementById('hSeat').textContent,
  time: document.getElementById('hTime').textContent }))));
console.log(errs.length ? errs.slice(0,10).join('\n') : 'no page errors');
await b.close();
