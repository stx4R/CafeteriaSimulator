/* eslint-env browser */
/* global THREE, CampusSim, STAGE, buildCampus */
(function () {
  'use strict';

  const CFG = JSON.parse(JSON.stringify(window.CAMPUS));
  const dom = CFG.domain;
  const CX = (dom.x0 + dom.x1) / 2, CZ = (dom.y0 + dom.y1) / 2;
  const GW = dom.x1 - dom.x0, GH = dom.y1 - dom.y0;
  const TOTAL = CFG.population.grades * CFG.population.classesPerGrade * CFG.population.studentsPerClass;

  const COL = { a: 0x2a78d6, b: 0xeb6834, ok: 0x1baf7a, warn: 0xeda100, bad: 0xe34948, violet: 0x9085e9 };
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = false;
  $('stage').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);
  scene.fog = new THREE.Fog(0x0e1116, 260, 520);

  const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.5, 2000);
  const target = new THREE.Vector3(-14, 0, 26);
  const orbit = { az: -0.62, el: 0.72, dist: 168 };

  function placeCamera() {
    orbit.el = Math.max(0.10, Math.min(1.5308, orbit.el));
    orbit.dist = Math.max(25, Math.min(620, orbit.dist));
    const r = orbit.dist * Math.cos(orbit.el);
    camera.position.set(
      target.x + r * Math.sin(orbit.az),
      target.y + orbit.dist * Math.sin(orbit.el),
      target.z + r * Math.cos(orbit.az));
    camera.lookAt(target);
  }
  placeCamera();

  scene.add(new THREE.HemisphereLight(0xbfd4ee, 0x2a2f38, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(-70, 130, 60);
  scene.add(sun);

  // ------------------------------------------------------------ orbit input
  const el = renderer.domElement;
  let drag = null;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const s = orbit.dist * 0.0016;
      const ca = Math.cos(orbit.az), sa = Math.sin(orbit.az);
      target.x -= (dx * ca - dy * sa) * s;
      target.z += (dx * sa + dy * ca) * s;
    } else {
      orbit.az -= dx * 0.005;
      orbit.el += dy * 0.005;
    }
    placeCamera();
  });
  const endDrag = () => { drag = null; };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbit.dist *= Math.exp(e.deltaY * 0.0011);
    placeCamera();
  }, { passive: false });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ------------------------------------------------------------ static scene
  const world = new THREE.Group();
  scene.add(world);
  let staticGroup = null;

  function polyShape(poly) {
    const s = new THREE.Shape();
    poly.forEach((p, i) => (i ? s.lineTo(p[0] - CX, p[1] - CZ) : s.moveTo(p[0] - CX, p[1] - CZ)));
    s.closePath();
    return s;
  }

  function buildStatic(scn) {
    if (staticGroup) {
      staticGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      world.remove(staticGroup);
    }
    staticGroup = new THREE.Group();

    // ground: the satellite image, georeferenced to the domain rectangle
    const tex = new THREE.TextureLoader().load(window.GROUND);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GW, GH),
      new THREE.MeshBasicMaterial({ map: tex }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, 0);
    staticGroup.add(ground);
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(GW + 60, 3, GH + 60),
      new THREE.MeshLambertMaterial({ color: 0x161b23 }));
    slab.position.set(0, -1.55, 0);
    staticGroup.add(slab);

    // corridors, drawn as ribbons just above the ground
    for (const [key, colour] of [['A', COL.a], ['B', COL.b]]) {
      const r = scn.routes[key];
      const pts = r.polylineExt || r.polyline;
      const verts = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
        const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
        const nx = (-dy / L) * (r.width / 2), ny = (dx / L) * (r.width / 2);
        const q = [
          [x1 + nx - CX, y1 + ny - CZ], [x2 + nx - CX, y2 + ny - CZ],
          [x2 - nx - CX, y2 - ny - CZ], [x1 - nx - CX, y1 - ny - CZ]];
        verts.push(
          q[0][0], 0, q[0][1], q[1][0], 0, q[1][1], q[2][0], 0, q[2][1],
          q[0][0], 0, q[0][1], q[2][0], 0, q[2][1], q[3][0], 0, q[3][1]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial(
        { color: colour, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }));
      m.position.y = 0.06;
      staticGroup.add(m);
    }

    // buildings. The cafeteria is deliberately translucent: the serving queue
    // and the seated crowd are half the point of watching this run.
    for (const s of scn.solids) {
      if (!s.height) continue;
      const glass = s.id === 'cafeteria';
      const geo = new THREE.ExtrudeGeometry(polyShape(s.poly), { depth: s.height, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const mat = glass
        ? new THREE.MeshLambertMaterial({ color: 0xb7c3d2, transparent: true, opacity: 0.22,
                                          side: THREE.DoubleSide, depthWrite: false })
        : new THREE.MeshLambertMaterial({ color: 0x8f9aa8 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = s.height;
      if (glass) mesh.renderOrder = 2;
      staticGroup.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 25),
        new THREE.LineBasicMaterial({ color: 0x3d4652 }));
      edges.position.y = s.height;
      staticGroup.add(edges);
    }

    // planted islands
    const treeGeo = new THREE.CylinderGeometry(1, 1, 3.5, 12);
    const treeMat = new THREE.MeshLambertMaterial({ color: 0x37613f });
    for (const t of CFG.treeIslands) {
      const m = new THREE.Mesh(treeGeo, treeMat);
      m.scale.set(t.r, 1, t.r);
      m.position.set(t.x - CX, 1.75, t.y - CZ);
      staticGroup.add(m);
    }

    // exits and door
    for (const e of scn.exits) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(e.w, 0.4, e.h),
        new THREE.MeshBasicMaterial({ color: COL.bad, transparent: true, opacity: 0.55 }));
      m.position.set(e.x - CX, 0.2, e.y - CZ);
      staticGroup.add(m);
    }
    const dm = new THREE.Mesh(
      new THREE.BoxGeometry(scn.opts.doorWidth, 3.2, 0.5),
      new THREE.MeshBasicMaterial({ color: 0x36c8ff }));
    dm.position.set(CFG.door.x - CX, 1.6, CFG.door.y - CZ);
    staticGroup.add(dm);

    // serving counters
    if (sim) {
      for (const c of sim.counters) {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(1.0, 1.0, 3.0),
          new THREE.MeshLambertMaterial({ color: 0xc9a227 }));
        m.position.set(c.world[0] - CX, 0.5, c.world[1] - CZ);
        staticGroup.add(m);
      }
    }
    world.add(staticGroup);
  }

  // ------------------------------------------------------------------ agents
  const CAP = TOTAL + CFG.population.teachers + 64;
  const agentGeo = new THREE.CylinderGeometry(0.23, 0.23, 1.7, 6);
  agentGeo.translate(0, 0.85, 0);
  const agents = new THREE.InstancedMesh(
    agentGeo, new THREE.MeshLambertMaterial({}), CAP);
  agents.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  agents.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
  agents.count = 0;
  world.add(agents);
  const M4 = new THREE.Matrix4();
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
  const C3 = new THREE.Color();

  let colourMode = 'route';
  function agentColour(i) {
    const c = sim.scn.crowd;
    if (colourMode === 'grade') {
      const g = Math.floor(c.group[i] / 100);
      return g === 1 ? COL.a : g === 2 ? COL.warn : COL.violet;
    }
    if (colourMode === 'speed') {
      const s = Math.min(1, Math.hypot(c.vx[i], c.vy[i]) / 1.4);
      C3.setHSL(0.02 + 0.36 * s, 0.72, 0.5);
      return C3.getHex();
    }
    if (c.stage[i] >= STAGE.SEATED) return COL.ok;
    if (c.stage[i] >= STAGE.QUEUE) return COL.warn;
    return sim.route[i] === 0 ? COL.a : COL.b;
  }

  function syncAgents() {
    const c = sim.scn.crowd;
    agents.count = c.n;
    for (let i = 0; i < c.n; i++) {
      if (!c.active[i]) { agents.setMatrixAt(i, HIDE); continue; }
      M4.makeTranslation(c.x[i] - CX, 0, c.y[i] - CZ);
      agents.setMatrixAt(i, M4);
      C3.setHex(agentColour(i));
      agents.instanceColor.setXYZ(i, C3.r, C3.g, C3.b);
    }
    agents.instanceMatrix.needsUpdate = true;
    agents.instanceColor.needsUpdate = true;
  }

  // --------------------------------------------------------------------- sim
  let sim = null;
  const opts = {
    seed: 1, headway: 45, routePolicy: 'shortest', splitA: 0.5,
    servingLines: 4, serviceTime: 3.5, seats: 420, mealTime: 780, doorWidth: 1.2,
  };
  let playing = true, speed = 1, acc = 0;

  function rebuild(full) {
    const t0 = performance.now();
    sim = new CampusSim(CFG, { ...opts });
    if (full !== false) buildStatic(sim.scn);
    const iss = sim.scn.issues || [];
    const w = $('geomWarn');
    if (iss.length) { w.textContent = iss.join(' · '); w.classList.remove('hide'); }
    else w.classList.add('hide');
    const t = sim.travel;
    $('routeNote').textContent =
      'Walking distance from each exit — ' +
      Object.keys(t).map((k) => `${k} ${t[k].viaA.toFixed(0)}/${t[k].viaB.toFixed(0)} m`).join(', ') +
      ' (via A / via B). Under shortest-path choice every exit prefers B.';
    acc = 0;
    hist.length = 0;
    syncAgents();
    return performance.now() - t0;
  }

  // ------------------------------------------------------------------- chart
  const chart = $('chart'), cx2 = chart.getContext('2d');
  const hist = [];
  function drawChart() {
    const W = chart.width, H = chart.height;
    cx2.clearRect(0, 0, W, H);
    if (hist.length < 2) return;
    const maxY = Math.max(60, ...hist.map((h) => Math.max(h.o, h.q, h.s)));
    const maxT = Math.max(600, hist[hist.length - 1].t);
    cx2.strokeStyle = '#2a323f'; cx2.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = (H - 18) * (g / 4) + 4;
      cx2.beginPath(); cx2.moveTo(34, y); cx2.lineTo(W - 4, y); cx2.stroke();
    }
    cx2.fillStyle = '#68727f'; cx2.font = '10px \"IBM Plex Mono\",ui-monospace,monospace';
    cx2.textAlign = 'right';
    cx2.fillText(String(Math.round(maxY)), 30, 12);
    cx2.fillText('0', 30, H - 14);
    cx2.textAlign = 'left';
    cx2.fillText(`${Math.round(maxT / 60)} min`, W - 42, H - 3);
    const px = (t) => 34 + (W - 38) * (t / maxT);
    const py = (v) => 4 + (H - 18) * (1 - v / maxY);
    for (const [key, col] of [['o', '#9085e9'], ['q', '#eda100'], ['s', '#1baf7a']]) {
      cx2.beginPath(); cx2.strokeStyle = col; cx2.lineWidth = 2;
      hist.forEach((h, i) => (i ? cx2.lineTo(px(h.t), py(h[key])) : cx2.moveTo(px(h.t), py(h[key]))));
      cx2.stroke();
      // emphasised endpoint: the current value is the one actually being read
      const last = hist[hist.length - 1];
      cx2.beginPath(); cx2.fillStyle = col;
      cx2.arc(px(last.t), py(last[key]), 3, 0, 6.2832); cx2.fill();
      cx2.strokeStyle = '#0e1116'; cx2.lineWidth = 1.5; cx2.stroke();
    }
  }

  // --------------------------------------------------------------------- HUD
  const WIN = 3000;
  function pct95(arr) {
    const n = arr.length;
    if (!n) return 0;
    const from = Math.max(0, n - WIN);
    const w = arr.slice(from).sort((p, q) => p - q);
    return w[Math.min(w.length - 1, Math.floor(0.95 * (w.length - 1)))];
  }

  let hudClock = 0;
  function updateHUD() {
    const c = sim.counts(), d = sim.scn.door, z = sim.scn.doorZone;
    $('hDoor').textContent = c.throughDoor;
    $('barDoor').style.width = (100 * c.throughDoor / TOTAL).toFixed(1) + '%';
    const span = d.times.length > 1 ? d.times[d.times.length - 1] - d.times[0] : 0;
    $('hQ').textContent = span > 5 ? ((d.times.length - 1) / span).toFixed(2) : '—';
    // 95th percentile over a trailing window: the full series grows to tens of
    // thousands of samples and must not be sorted on every HUD tick.
    $('hRho').textContent = pct95(z.rho).toFixed(2);
    $('hP').textContent = pct95(z.P).toFixed(2);
    $('hOut').textContent = c.outdoor;
    $('hQueue').textContent = c.queue + c.service;
    $('hSeat').textContent = c.seated;
    const m = Math.floor(sim.t / 60), s = Math.floor(sim.t % 60);
    $('hTime').textContent = m + ':' + String(s).padStart(2, '0');
    const A = sim.routeCount[0], B = sim.routeCount[1], tot = A + B || 1;
    $('barA').style.width = (100 * A / tot) + '%';
    $('barB').style.width = (100 * B / tot) + '%';
    $('hA').textContent = A; $('hB').textContent = B;
    const note = $('hudNote');
    if (sim.rescued > TOTAL * 0.02) {
      note.textContent = `${sim.rescued} pedestrians had to be released from a permanent jam — ` +
        `above this load the force model arches and stops resolving, so treat these numbers as a bound, not a prediction.`;
      note.classList.remove('hide');
    } else note.classList.add('hide');
  }

  // -------------------------------------------------------------------- loop
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const wall = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (playing && sim) {
      acc += wall * speed;
      const dt = sim.o.dt;
      let guard = 0;
      while (acc >= dt && guard < 900) { sim.step(); acc -= dt; guard++; }
      syncAgents();
      if (now - hudClock > 120) {
        hudClock = now;
        updateHUD();
        const c = sim.counts();
        hist.push({ t: sim.t, o: c.outdoor, q: c.queue + c.service, s: c.seated });
        if (hist.length > 2000) hist.shift();
        drawChart();
      }
    }
    renderer.render(scene, camera);
  }

  // ----------------------------------------------------------------- UI wire
  function press(id, on) { $(id).setAttribute('aria-pressed', on ? 'true' : 'false'); }
  function bindSlider(id, vid, fmt, apply) {
    const s = $(id);
    const show = () => { $(vid).textContent = fmt(+s.value); };
    s.addEventListener('input', () => { show(); apply(+s.value); });
    show();
  }

  $('bPlay').onclick = () => { playing = !playing; $('bPlay').textContent = playing ? 'Pause' : 'Play'; press('bPlay', playing); };
  for (const [id, v] of [['bx1', 1], ['bx8', 8], ['bx30', 30]]) {
    $(id).onclick = () => {
      speed = v;
      press('bx1', v === 1); press('bx8', v === 8); press('bx30', v === 30);
    };
  }
  $('bReset').onclick = () => { rebuild(false); };

  bindSlider('sHead', 'vHead', (v) => v + ' s', (v) => { opts.headway = v; rebuild(false); });
  bindSlider('sSplit', 'vSplit', (v) => v + ' %', (v) => { opts.splitA = v / 100; rebuild(false); });
  bindSlider('sLines', 'vLines', (v) => String(v), (v) => { opts.servingLines = v; rebuild(false); });
  bindSlider('sSvc', 'vSvc', (v) => v.toFixed(1) + ' s', (v) => { opts.serviceTime = v; rebuild(false); });
  bindSlider('sSeats', 'vSeats', (v) => String(v), (v) => { opts.seats = v; rebuild(false); });
  bindSlider('sMeal', 'vMeal', (v) => (v / 60).toFixed(1) + ' min', (v) => { opts.mealTime = v; rebuild(false); });
  bindSlider('sDoor', 'vDoor', (v) => v.toFixed(2) + ' m', () => {});

  $('pShort').onclick = () => {
    opts.routePolicy = 'shortest'; press('pShort', true); press('pSplit', false);
    $('splitBox').classList.add('hide'); rebuild(false);
  };
  $('pSplit').onclick = () => {
    opts.routePolicy = 'split'; press('pShort', false); press('pSplit', true);
    $('splitBox').classList.remove('hide'); rebuild(false);
  };
  $('bApplyGeom').onclick = () => {
    opts.doorWidth = +$('sDoor').value;
    $('load').classList.remove('hide');
    setTimeout(() => { rebuild(true); $('load').classList.add('hide'); }, 30);
  };

  for (const [id, mode] of [['cRoute', 'route'], ['cGrade', 'grade'], ['cSpeed', 'speed']]) {
    $(id).onclick = () => {
      colourMode = mode;
      press('cRoute', mode === 'route'); press('cGrade', mode === 'grade'); press('cSpeed', mode === 'speed');
    };
  }
  $('bTop').onclick = () => {
    orbit.az = 0; orbit.el = 1.5; orbit.dist = 210;
    target.set(0, 0, 0); placeCamera();
  };

  const GEOM_KEYS = ['domain', 'exits', 'routes', 'door', 'buildings', 'blockers', 'treeIslands'];
  $('bGeom').onclick = () => {
    const box = $('geomBox');
    box.classList.toggle('hide');
    if (!box.classList.contains('hide')) {
      const sub = {};
      for (const k of GEOM_KEYS) sub[k] = CFG[k];
      $('geomJson').value = JSON.stringify(sub, null, 1);
    }
  };
  $('bApplyJson').onclick = () => {
    let parsed;
    try { parsed = JSON.parse($('geomJson').value); }
    catch (err) {
      const w = $('geomWarn');
      w.textContent = 'JSON error: ' + err.message; w.classList.remove('hide'); return;
    }
    for (const k of GEOM_KEYS) if (parsed[k]) CFG[k] = parsed[k];
    $('load').classList.remove('hide');
    setTimeout(() => { rebuild(true); $('load').classList.add('hide'); }, 30);
  };

  // ------------------------------------------------------------------- start
  setTimeout(() => {
    rebuild(true);
    $('load').classList.add('hide');
    updateHUD();
    requestAnimationFrame(frame);
  }, 40);
})();
