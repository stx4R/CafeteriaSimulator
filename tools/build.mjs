// Bundle the simulator into one self-contained HTML file.
// Artifacts must render standalone weeks later, so nothing is fetched at runtime:
// Three.js, the core modules, the campus geometry and the ground texture are all
// inlined. The core files are ES modules; import/export are stripped so they can
// share one classic-script lexical scope.

import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const CORE = ['core/navfield.js', 'core/obstaclefield.js', 'core/metrics.js',
              'core/sfm.js', 'core/campus.js', 'core/run.js'];

function strip(src, file) {
  const out = src
    .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(const|let|var|function|class|async))/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
  if (/\bimport\b|\bexport\b/.test(out.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) {
    throw new Error(`leftover module syntax in ${file}`);
  }
  return `\n/* ===== ${file} ===== */\n${out}`;
}

const core = CORE.map((f) => strip(read(f), f)).join('\n');
const three = read('node_modules/three/build/three.min.js');
const app = read('view/app.js');
const campus = read('data/campus.json');
const ground = 'data:image/jpeg;base64,' +
  fs.readFileSync(path.join(root, 'data/ground.jpg')).toString('base64');

let html = read('view/app.src.html')
  .replace('/*INLINE:three*/', () => three)
  .replace('/*INLINE:core*/', () => core)
  .replace('/*INLINE:app*/', () => app)
  .replace('/*INLINE:campus*/', () => campus)
  .replace('/*INLINE:ground*/', () => ground);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const outPath = path.join(root, 'dist/simulator.html');
fs.writeFileSync(outPath, html);
const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`dist/simulator.html  ${kb} KB`);
for (const bad of ['/*INLINE:', 'INLINE:three']) {
  if (html.includes(bad)) { console.error('unreplaced placeholder:', bad); process.exit(1); }
}
console.log('core modules bundled:', CORE.length, '| three', (three.length / 1024).toFixed(0), 'KB',
            '| ground', (ground.length / 1024).toFixed(0), 'KB');
