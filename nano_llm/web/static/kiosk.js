// The booth's camera and brain screens (docs/superpowers/specs/2026-10-20-kiosk-display-design.md).
// Read-only: no layout is ever saved, nothing is loaded from the network. Pure logic is in
// kiosk_logic.js (tested with node); this file is the DOM. kioskScreen / viewMode come from kiosk.html.
const KIOSK_W = 1920, KIOSK_H = 1080, BANNER_H = 64;

// x, y, w, h in stage pixels for each camera-screen slot of kiosk_layout.json (spec §4.1): one camera,
// the whole stage under the banner (the booth branch lays out its ZED and ADI sensors here)
const CAMERA_RECTS = {
  camera: [8, 72, 1904, 1000],
};

let kioskLayout = null;      // /static/kiosk_layout.json
let kioskPlugins = [];       // plugin_added payloads, in order
let kioskConnections = [];   // plugin_connected payloads
let kioskBuilt = false;
let kioskPreset = null;      // current_preset from the init message
let kioskSaved = null;       // the kiosk's own pipeline layout of that preset (spec §7), {} if never saved
const kioskEdit = new URLSearchParams(window.location.search).get('edit') === '1';

function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

function place(e, rect) {
  const [x, y, w, h] = rect;
  Object.assign(e.style, {left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`});
}

let kioskScale = 1;   // the stage's CSS scale (Drawflow measures connections in screen pixels)

function fitStage() {
  const stage = document.getElementById('kiosk-stage');
  const s = kioskScale = Math.min(window.innerWidth / KIOSK_W, window.innerHeight / KIOSK_H);
  stage.style.transform = `scale(${s})`;
  stage.style.left = `${(window.innerWidth - KIOSK_W * s) / 2}px`;
  stage.style.top = `${(window.innerHeight - KIOSK_H * s) / 2}px`;
}

function buildBanner(stage) {
  const bar = el('div', 'k-banner', stage);
  el('div', 'k-badge', bar, '<img src="/static/advantech_logo.png" alt="Advantech">');
  // title, the wake-word call to action, a clock (2026-10-21: was one line of plain text)
  el('div', 'k-brand', bar, '<div class="k-brand-title">Edge AI Agent</div>');
  el('div', 'k-call', bar, '<span class="k-mic"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/>' +
                           '<path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg></span>' +
                           `<span class="k-call-text">${wakeHint(null, kioskLang).text}</span>`).id = 'k-call';
  const clock = el('div', 'k-clock', bar);
  // the machine runs on UTC; kiosk_layout.json "timezone" says where the booth is (none: the browser's own)
  const tick = () => {
    const opts = {hour: '2-digit', minute: '2-digit', hour12: false};
    if (kioskLayout && kioskLayout.timezone) opts.timeZone = kioskLayout.timezone;
    try { clock.textContent = new Date().toLocaleTimeString(CLOCK_LOCALE, opts); }
    catch (e) { delete opts.timeZone; clock.textContent = new Date().toLocaleTimeString(CLOCK_LOCALE, opts); }   // unknown zone name
  };
  tick();
  setInterval(tick, 1000);
}

// ---- startup screen (2026-10-21) ---------------------------------------------------------------
// Over the whole stage until Studio is connected, the pipeline is in and every model has loaded
// (GET /api/startup); again while Studio restarts. The page under it may rebuild or reload as it
// likes - visitors see the steps, not a page flashing (the "reload storm" during a slow load).

const kioskLang = new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'zh';
const T = kioskText(kioskLang);
const CLOCK_LOCALE = kioskLang === 'en' ? 'en-GB' : 'zh-TW';

// the shared views (chat, sensor overlays, the mic ring) keep Chinese unless told otherwise
function applyKioskLanguage() {
  if (kioskLang !== 'en') return;
  document.documentElement.lang = 'en';
  chatViewWords = T;
  sensorViewWords = {waiting: T.sensorWaiting, lost: T.sensorLost, status: T.status};
}

// L switches the language: the page comes back in the other one (everything rebuilds once)
function toggleKioskLanguage() {
  const q = new URLSearchParams(window.location.search);
  if (kioskLang === 'en') q.delete('lang'); else q.set('lang', 'en');
  window.location.search = q.toString();
}
const boot = {connected: false, restarting: false, startup: null, done: false, el: null};

function buildBoot(stage) {
  boot.el = el('div', 'k-boot', stage, `
    <div class="k-boot-glow"></div>
    <div class="k-boot-col">
      <div class="k-badge k-boot-badge"><img src="/static/advantech_logo.png" alt="Advantech"></div>
      <div class="k-brand-title k-boot-brand">Edge AI Agent</div>
      <div class="k-boot-title"><span data-k="title"></span><span class="k-boot-dots"><i>.</i><i>.</i><i>.</i></span></div>
      <div class="k-boot-card" data-k="steps"></div>
      <div class="k-boot-bar"><span></span></div>
      <div class="k-boot-hint" data-k="hint"></div>
    </div>`);
  renderBoot();
  setInterval(pollBoot, 1000);
}

function pollBoot() {
  if (boot.done || !boot.connected) return renderBoot();
  fetch('/api/startup', {cache: 'no-store'}).then(r => r.ok ? r.json() : null)
    .then(j => { if (j) boot.startup = j; renderBoot(); }).catch(() => renderBoot());
}

function renderBoot() {
  if (!boot.el) return;
  const v = bootView({connected: boot.connected, restarting: boot.restarting, nodes: kioskPlugins.length,
                      preset: kioskPreset, startup: boot.startup}, kioskLang);
  boot.el.querySelector('[data-k="title"]').textContent = v.title;
  boot.el.querySelector('[data-k="hint"]').textContent = v.hint;
  boot.el.querySelector('[data-k="steps"]').innerHTML = v.steps.map(x =>
    `<div class="k-boot-step ${x.status}"><span class="k-boot-icon"></span>` +
    `<span class="k-boot-label">${escapeHTML(x.label)}</span><span class="k-boot-detail">${escapeHTML(x.detail)}</span></div>`).join('');
  const done = v.ready && kioskBuilt;
  if (done !== boot.done) { boot.done = done; boot.el.classList.toggle('done', done); }
}

// websocket.js calls these when the connection drops: show it, then reload once Studio answers again
// (a fresh page re-subscribes everything once, so no listener is ever registered twice).
function showReloadMessage() {
  Object.assign(boot, {connected: false, restarting: true, startup: null});
  renderBoot();
}

function pollForReload() {
  const tryOnce = () => fetch('/api/health', {cache: 'no-store'})
    .then(r => { if (r.ok) window.location.reload(); else setTimeout(tryOnce, 2000); })
    .catch(() => setTimeout(tryOnce, 2000));
  setTimeout(tryOnce, 2000);
}

// ---- camera screen ----------------------------------------------------------------------------------

const kioskVideoListeners = {};   // VideoOutput name -> callback(ArrayBuffer)

function routeFrame(frame, metadata) {
  // the server sends the first 8 characters of the plugin name (grid.js onVideoFrameReceived())
  for (const [name, listener] of Object.entries(kioskVideoListeners))
    if (!metadata || name.startsWith(metadata) || metadata.startsWith(name.substring(0, 8))) {
      listener(frame);
      sensorSignalSeen(name);
      return;
    }
}

function buildVideoSlot(box, node) {
  // the ids track_boxes.js looks for (trackCanvas()): `${view}_grid_media_container` / `_mjpeg_stream`
  const media = el('div', 'k-media', box);
  media.id = `${node}_grid_media_container`;
  const img = el('img', 'k-video', media);
  img.id = `${node}_grid_mjpeg_stream`;
  sensorSignalRegister(node, media);
  let prev = null;
  kioskVideoListeners[node] = frame => {
    if (prev) URL.revokeObjectURL(prev);
    prev = URL.createObjectURL(new Blob([frame], {type: 'image/jpeg'}));
    img.src = prev;
    img.style.display = 'block';
  };
  setVideoSubscription(Object.keys(kioskVideoListeners));   // websocket.js: only the outputs shown here
  sendWebsocket({[node]: {'create_mjpeg_stream_port': node}});   // VideoOutput encodes only once asked
}

const cameraScreen = {slots: [], boxes: {}, calls: {}};
const LOOKED_MS = 4000;

function buildCameraScreen(stage) {
  const names = kioskPlugins.map(p => p.name);
  cameraScreen.slots = resolveSlots(kioskLayout.camera, names);
  for (const s of cameraScreen.slots) {
    const box = el('div', 'k-slot', stage);
    cameraScreen.boxes[s.slot] = box;
    el('div', 'k-looked-tag', box).textContent = T.aiLooking;
    place(box, CAMERA_RECTS[s.slot] || [0, 0, 0, 0]);
    el('div', `k-label ${s.brand}`, box).textContent = (kioskLang === 'en' && s.label_en) || s.label;
    if (s.missing) { el('div', 'k-missing', box, T.missing); continue; }
    if (s.kind === 'video') buildVideoSlot(box, s.node);
  }
  const hub = kioskPlugins.find(p => p.type === 'Tools_Hub');
  if (hub) addTrackBoxesHooks(hub.name);
  // the camera the AI reads lights up here, as "AI 剛看到的畫面" shows it on the brain screen (2026-10-22)
  for (const p of kioskPlugins.filter(p => p.type === 'AgentLoop')) addOutputListener(p.name, 6, onCameraScreenAgentEvent);
}

function onCameraScreenAgentEvent(data) {
  if (!data || !data.event) return;
  if (data.event === 'tool_call_pending') {
    const cache = cameraOfTool(data.args, '', cacheNames());
    cameraScreen.calls[data.call_id] = {args: data.args, linked: !!cache};
    if (cache) showLooked(cache);
  }
  if (data.event === 'tool_call_resolved') {
    const call = cameraScreen.calls[data.call_id];   // no source argument: the result names the camera
    if (call && !call.linked) {
      const cache = cameraOfTool(call.args, data.result, cacheNames());
      if (cache) showLooked(cache);
    }
    delete cameraScreen.calls[data.call_id];
  }
}

function showLooked(cache) {
  for (const slot of slotsForCache(cache, kioskConnections, cameraScreen.slots)) {
    const box = cameraScreen.boxes[slot];
    if (!box) continue;
    box.classList.add('k-looked');
    clearTimeout(box._kLookedTimer);
    box._kLookedTimer = setTimeout(() => box.classList.remove('k-looked'), LOOKED_MS);
  }
}

// ---- messages ---------------------------------------------------------------------------------------

function onKioskStats(stats) {
  for (const name in stats) {
    const st = stats[name];
    if (st && st.source) trackBoxesSetSource(name, st.source);   // the node feeding a VideoOutput
    if (!st || !('summary' in st)) continue;
  }
}

// the banner's hint follows the WakeWord node (both screens): quiet asleep, lit in a conversation
// The voice conversation as it happens (2026-10-21): the pill lights, the
// brain screen's chat shows what Whisper is hearing while the wake word listens.
const listen = {state: null, partial: '', bubble: null};

function watchWakeWord() {
  const call = document.getElementById('k-call');
  for (const p of kioskPlugins.filter(p => p.type === 'WakeWord'))
    addOutputListener(p.name, 3, state => {
      const hint = wakeHint(state, kioskLang), was = listen.state && listen.state.state;
      call.classList.toggle('on', hint.on);
      call.querySelector('.k-call-text').textContent = hint.text;
      const now = state && state.state;
      if ((now === 'listening' || now === 'greeting') && was !== 'listening' && was !== 'greeting') listen.partial = '';
      listen.state = state;
      renderListen();
    });
  // what Whisper hears so far: subscribed on the brain screen only - a subscriber is what makes
  // WhisperASR transcribe partials at all (its partial_transcripts rate)
  if (kioskScreen === 'brain')
    for (const p of kioskPlugins.filter(p => p.type === 'WhisperASR'))
      addOutputListener(p.name, 1, text => { if (typeof text === 'string') { listen.partial = text; renderListen(); } });
}

function renderListen() {
  if (!listen.bubble) return;
  const v = listenBubble(listen.state, listen.partial);
  listen.bubble.classList.toggle('on', v.show);
  listen.bubble.querySelector('.k-listen-text').textContent = v.text;
}

function kioskBuild() {
  if (kioskBuilt || !kioskLayout || !kioskPlugins.length) return;
  if (kioskScreen !== 'camera' && kioskSaved === null) return;   // wait for the kiosk's own layout
  kioskBuilt = true;
  const stage = document.getElementById('kiosk-stage');
  if (kioskScreen === 'camera') buildCameraScreen(stage);
  else if (kioskScreen === 'single') buildSingleScreen(stage);
  else if (kioskScreen === 'auto') buildAutoScreen(stage);
  else if (typeof buildBrainScreen === 'function') buildBrainScreen(stage);
  const wake = kioskShowsWakeCall(kioskScreen, kioskPlugins);   // typed-only pages hide it (spec 2026-11-04 §2)
  document.body.classList.toggle('k-nowake', !wake);
  if (wake) watchWakeWord();
  buildMicButton();
}

let kioskBuildTimer = null;
function kioskScheduleBuild() {
  // plugin_added and plugin_connected arrive as separate messages right after connecting
  clearTimeout(kioskBuildTimer);
  kioskBuildTimer = setTimeout(kioskBuild, 300);
}

function onKioskMsg(payload, type, metadata) {
  if (!boot.connected) { boot.connected = true; renderBoot(); }
  if (type === MESSAGE_VIDEO_FRAME) { routeFrame(payload, metadata); return; }
  if (type === MESSAGE_AUDIO) { kioskAudioPlay(payload); return; }
  if (type !== MESSAGE_JSON) return;
  if ('current_preset' in payload && kioskSaved === null) {
    kioskPreset = payload.current_preset;
    const done = saved => { kioskSaved = saved || {}; kioskScheduleBuild(); };
    if (!kioskPreset) done({});
    else fetch(`/api/kiosk_layout?preset=${encodeURIComponent(kioskPreset)}`, {cache: 'no-store'})
      .then(r => r.ok ? r.json() : {}).then(done).catch(() => done({}));
  }
  if ('plugin_added' in payload) {
    const list = pipelinePlugins(Array.isArray(payload.plugin_added) ? payload.plugin_added : [payload.plugin_added]);
    // every new websocket client makes the server resend the whole init to all clients (CLAUDE.md):
    // only a different set of nodes (another preset) rebuilds the page
    if (kioskBuilt) {
      if (hasNewNodes(kioskPlugins, list)) window.location.reload();
      return;
    }
    for (const p of list) if (!kioskPlugins.find(q => q.name === p.name)) kioskPlugins.push(p);
    kioskScheduleBuild();
  }
  if ('plugin_connected' in payload) {
    const list = Array.isArray(payload.plugin_connected) ? payload.plugin_connected : [payload.plugin_connected];
    if (!kioskBuilt)
      for (const c of list)
        if (!kioskConnections.find(d => d.from === c.from && d.output === c.output && d.to === c.to && d.input === c.input))
          kioskConnections.push(c);
  }
  if ('plugin_removed' in payload && kioskBuilt) { window.location.reload(); return; }
  if ('send_output' in payload) sendOutput(payload.send_output);
  if ('state_dict' in payload && typeof setKioskState === 'function') setKioskState(payload.state_dict);
  if ('stats' in payload) onKioskStats(payload.stats);
  if ('activity' in payload && typeof onKioskActivity === 'function') onKioskActivity(payload.activity);
}

function kioskStart() {
  const stage = document.getElementById('kiosk-stage');
  if (kioskScreen === 'single') document.body.classList.add('k-single');
  applyKioskLanguage();
  document.addEventListener('keydown', e => {
    if ((e.key === 'l' || e.key === 'L') && !(e.target.closest && e.target.closest('textarea,input'))) toggleKioskLanguage();
  });
  buildBanner(stage);
  buildBoot(stage);
  fitStage();
  window.addEventListener('resize', () => {
    fitStage();
    if (brain.tabs[brain.current]) fitTab(brain.tabs[brain.current]);
  });
  startSensorSignalWatch();
  kioskAudioStart();
  fetch('/static/kiosk_layout.json', {cache: 'no-store'})
    .then(r => r.json())
    .then(layout => { kioskLayout = layout; kioskScheduleBuild(); });
  connectWebsocket(onKioskMsg);
}

window.addEventListener('load', kioskStart);

// ---- brain screen (spec §3, §4.2, §4.3) ---------------------------------------------------------

const BRAIN_RECTS = {           // B with the chat on the right (user, 2026-10-20); what the AI saw under the chat (2026-10-21)
  pipeline: [8, 72, 1256, 650], perf: [8, 730, 820, 342], tracking: [836, 730, 428, 342],
  chat: [1272, 72, 640, 600], seen: [1272, 680, 640, 392],
};
const TRACK_MAX_AGE_MS = 2000;
const VIRTUAL_LINK_MS = 4000;
const FLOW_TICK_MS = 100;

const brain = {tabs: {}, current: 'main', ticks: [], idle: null, tracks: {}, trackState: null, generatingUntil: 0,
               calls: {}, seen: null, toolRun: new ToolRunState(1500), toolShown: null};

function nodeHtml(name, stubs) {
  const lines = stubs.map(s => `<div class="k-node-stub">${s.dir === 'in' ? '← ' : '→ '}${escapeHTML(s.other)}</div>`).join('');
  const hide = `<button type="button" class="k-hide" data-node="${escapeHTML(name)}" title="從這個分頁隱藏">✕</button>`;
  return `${hide}<div class="k-node-title">${escapeHTML(name)}</div><span class="k-node-note"></span>${lines}`;
}

function buildPipelineTab(host, key, names) {
  if (brain.tabs[key]) { brain.tabs[key].wrap.remove(); delete brain.tabs[key]; }
  const wrap = el('div', 'k-flow-host', host);
  wrap.style.display = 'none';
  const editor = new Drawflow(wrap);
  // edit mode (spec §7): drag only - no wiring, no deleting, no zoom (the fit sets it)
  editor.key = () => {};
  editor.contextmenu = e => e.preventDefault();
  editor.zoom_enter = () => {};
  editor.editor_mode = kioskEdit ? 'edit' : 'fixed';
  // wire bend points (2026-11-06): a double click on a wire adds one, dragging moves it, a double click
  // on it removes it. Drawflow keeps the points and their dragging; the wire through them is ours, one
  // smooth curve (Drawflow's per-stretch curves kinked at every point: "很奇怪的折線", the user)
  editor.reroute = true;
  editor.reroute_fix_curvature = false;
  editor.start();
  const layoutWires = editor.updateConnectionNodes.bind(editor);
  editor.updateConnectionNodes = id => { layoutWires(id); smoothWires(editor); };
  if (kioskEdit) {   // dragging the background would pan with Drawflow's own scale; the fit places the canvas
    // (a wire and its bend points are Drawflow's too: it selects the wire on mousedown, then a double click adds a point)
    const ownedByDrawflow = t => t.closest('.drawflow-node') || t.closest('.connection');
    wrap.addEventListener('mousedown', e => { if (!ownedByDrawflow(e.target)) e.stopPropagation(); }, true);
    // ctrl+wheel zooms round the pointer, a double click on the background fits again (2026-10-21)
    wrap.addEventListener('wheel', ev => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();                                  // not the browser's page zoom
      const tab = brain.tabs[key], r = wrap.getBoundingClientRect();
      const ed = tab.editor, view = {x: ed.canvas_x, y: ed.canvas_y, z: ed.zoom / kioskScale};
      const v = zoomAt(view, (ev.clientX - r.left) / kioskScale, (ev.clientY - r.top) / kioskScale,
                       ev.deltaY < 0 ? 1.1 : 1 / 1.1, 0.2, 3);
      applyView(tab, v.x, v.y, v.z);
    }, {passive: false});
    wrap.addEventListener('dblclick', e => { if (!ownedByDrawflow(e.target)) fitTab(brain.tabs[key]); }, true);
    wrap.addEventListener('dblclick', e => {
      const tab = brain.tabs[key];
      // Drawflow's own double click first adds a point on the last selected wire, then removes a clicked one
      tab.editor.connection_selected = null;
      const path = e.target.closest('.main-path');
      if (path) { e.stopPropagation(); addBendPoint(tab, path.parentElement, e); }
    }, true);
  }
  editor.precanvas.style.transformOrigin = '0 0';
  const saved = (kioskEdit ? brain.edit : kioskSaved)[key];
  const plugins = tabPlugins(kioskPlugins, names, saved), byName = {};
  const {inside, stubs} = edgesForTab(kioskConnections, plugins.map(p => p.name), kioskPlugins.map(p => p.name));
  for (const p of plugins) {
    const pos = p.layout_node || {};
    const mine = stubs.filter(s => s.node === p.name);
    byName[p.name] = editor.addNode(p.name, (p.inputs || []).length, (p.outputs || []).length,
                                    pos.x || 0, pos.y || 0, `k-node k-cat-${nodeCategory(p.type)} ${p.name}`, {}, nodeHtml(p.name, mine));
  }
  const edges = [];
  for (const c of inside) {
    const a = byName[c.from], b = byName[c.to];
    if (a === undefined || b === undefined) continue;
    try { editor.addConnection(a, b, `output_${c.output + 1}`, `input_${c.input + 1}`); } catch (e) { continue; }
    edges.push(c);
  }
  restoreRoutes(editor, byName, edges, cleanRoutes(saved && saved.routes, edges.map(routeKey)));
  brain.tabs[key] = {wrap, editor, byName, edges, svg: {}, names};
  if (kioskEdit) {
    editor.on('connectionCreated', c => editor.removeSingleConnection(c.output_id, c.input_id, c.output_class, c.input_class));
    wrap.addEventListener('click', e => {
      const b = e.target.closest('.k-hide');
      if (b) hideNode(key, b.dataset.node);
    });
  }
}

// the Drawflow record of wire c (its points live there)
function wireData(editor, byName, c) {
  const node = editor.drawflow.drawflow[editor.module].data[byName[c.from]];
  const out = node && node.outputs[`output_${c.output + 1}`];
  return out && out.connections.find(x => x.node === String(byName[c.to]) && x.output === `input_${c.input + 1}`);
}

// every wire with bend points: one smooth curve from where Drawflow starts it to where it ends it
function smoothWires(editor) {
  for (const svg of editor.precanvas.querySelectorAll('.connection')) {
    const pts = [...svg.querySelectorAll('.point')], path = svg.querySelector('.main-path');
    const ends = pts.length && path && pathEnds(path.getAttribute('d'));
    if (!ends) continue;
    path.setAttributeNS(null, 'd', smoothRoutePath(ends.start,
      pts.map(c => [+c.getAttribute('cx'), +c.getAttribute('cy')]), ends.end));
  }
}

function addBendPoint(tab, svg, ev) {
  const ed = tab.editor, c = tab.edges.find(c => edgeSvg(tab, c) === svg);
  const wire = c && wireData(ed, tab.byName, c), ends = pathEnds(svg.querySelector('.main-path').getAttribute('d'));
  if (!wire || !ends) return;
  const r = ed.precanvas.getBoundingClientRect();         // the canvas origin on screen; ed.zoom has the stage scale in it
  const p = [(ev.clientX - r.x) / ed.zoom, (ev.clientY - r.y) / ed.zoom];
  const pts = insertRoutePoint(ends.start, (wire.points || []).map(q => [q.pos_x, q.pos_y]), ends.end, p);
  wire.points = pts.map(([x, y]) => ({pos_x: x, pos_y: y}));
  // Drawflow finds a dragged point's entry by its place among the wire's children: keep them in order
  for (const old of svg.querySelectorAll('.point')) old.remove();
  for (const [x, y] of pts) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.classList.add('point');
    dot.setAttributeNS(null, 'cx', x); dot.setAttributeNS(null, 'cy', y); dot.setAttributeNS(null, 'r', ed.reroute_width);
    svg.appendChild(dot);
  }
  ed.updateConnectionNodes(`node-${tab.byName[c.from]}`);
}

function restoreRoutes(editor, byName, edges, routes) {
  const touched = new Set();
  for (const c of edges) {
    const pts = routes[routeKey(c)], wire = pts && wireData(editor, byName, c);
    if (!wire) continue;
    wire.points = pts.map(([x, y]) => ({pos_x: x, pos_y: y}));
    touched.add(byName[c.from]);
  }
  // draws the points and the extra path pieces; the next updateConnectionNodes (applyView) lays them out
  for (const id of touched) editor.addRerouteImport(editor.drawflow.drawflow[editor.module].data[id]);
}

// ---- edit mode (spec §7) ----------------------------------------------------------------------------

// the tab's wires as drawn now; wires of hidden nodes keep what they had
function editRoutes(key) {
  const tab = brain.tabs[key], out = Object.assign({}, brain.edit[key].routes);
  if (!tab) return out;
  for (const c of tab.edges) {
    const wire = wireData(tab.editor, tab.byName, c), k = routeKey(c);
    delete out[k];
    if (wire && wire.points && wire.points.length) out[k] = wire.points.map(p => [p.pos_x, p.pos_y]);
  }
  return cleanRoutes(out, Object.keys(out));
}

function editPositions(key) {
  const tab = brain.tabs[key], out = Object.assign({}, brain.edit[key].positions);
  if (!tab) return out;
  for (const [name, id] of Object.entries(tab.byName)) {
    const n = tab.editor.getNodeFromId(id);
    out[name] = {x: Math.round(n.pos_x), y: Math.round(n.pos_y)};
  }
  return out;
}

function rebuildTab(key) {
  brain.edit[key].positions = editPositions(key);
  brain.edit[key].routes = editRoutes(key);
  buildPipelineTab(brain.pipePanel, key, brain.tabs[key].names);
  showTab(brain.current);
  renderEditBar();
}

function hideNode(key, name) {
  brain.edit[key].hidden = [...new Set([...brain.edit[key].hidden, name])];
  rebuildTab(key);
}

function unhideNode(key, name) {
  brain.edit[key].hidden = brain.edit[key].hidden.filter(n => n !== name);
  rebuildTab(key);
}

function renderEditBar() {
  const bar = brain.editBar;
  if (!bar) return;
  bar.innerHTML = '';
  el('span', 'k-edit-hint', bar).textContent = '編輯模式：拖曳節點排列，✕ 從這個分頁隱藏（不會刪除 pipeline 的節點）；雙擊接線加轉折點、拖曳移動、雙擊轉折點刪除';
  for (const name of brain.edit[brain.current].hidden) {
    const b = el('button', 'k-edit-btn', bar);
    b.textContent = `顯示 ${name}`;
    b.addEventListener('click', () => unhideNode(brain.current, name));
  }
  const save = el('button', 'k-edit-btn k-edit-save', bar);
  save.textContent = '儲存並結束';
  save.addEventListener('click', saveEdit);
  const cancel = el('button', 'k-edit-btn', bar);
  cancel.textContent = '取消';
  cancel.addEventListener('click', leaveEdit);
}

function leaveEdit() {
  const url = new URL(window.location.href);
  url.searchParams.delete('edit');
  window.location.href = url.toString();
}

function saveEdit() {
  // the brain screen's tabs and the single page's share the preset's file: keep the other page's
  let layout = kioskSaved || {};
  for (const key of Object.keys(brain.edit))
    layout = mergeSavedLayout(layout, key, {positions: editPositions(key), hidden: brain.edit[key].hidden,
                                            routes: editRoutes(key)});
  fetch(`/api/kiosk_layout?preset=${encodeURIComponent(kioskPreset || '')}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(layout)})
    .then(r => { if (r.ok) leaveEdit(); else r.json().then(j => alert(`沒有存成功：${j.error || r.status}`)); })
    .catch(e => alert(`沒有存成功：${e}`));
}

function nodeEl(tab, name) { return tab.wrap.querySelector(`#node-${tab.byName[name]}`); }

function fitTab(tab) {
  const nodes = Object.keys(tab.byName).map(n => nodeEl(tab, n)).filter(Boolean);
  if (!nodes.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const x = n.offsetLeft, y = n.offsetTop;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + n.offsetWidth); y1 = Math.max(y1, y + n.offsetHeight);
  }
  const W = tab.wrap.clientWidth, H = tab.wrap.clientHeight, pad = 24;
  const z = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0), 1.4);
  applyView(tab, pad - x0 * z + ((W - 2 * pad) - (x1 - x0) * z) / 2,
            pad - y0 * z + ((H - 2 * pad) - (y1 - y0) * z) / 2, z);
}

function applyView(tab, x, y, z) {
  const e = tab.editor;
  e.canvas_x = x;
  e.canvas_y = y;
  e.precanvas.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  // Drawflow divides screen-pixel offsets by its zoom - when it lays out connections and when a node
  // is dragged in edit mode - so its zoom includes the stage's own CSS scale; the canvas transform
  // above is ours. (Connections were laid out while the tab was hidden, all at 0,0.)
  e.zoom = e.zoom_last_value = z * kioskScale;
  for (const id of Object.values(tab.byName)) e.updateConnectionNodes(`node-${id}`);
}

function showTab(key) {
  brain.current = key;
  if (kioskEdit && kioskPreset) setTimeout(renderEditBar, 0);
  for (const [k, tab] of Object.entries(brain.tabs)) tab.wrap.style.display = k === key ? '' : 'none';
  for (const b of document.querySelectorAll('.k-tab')) b.classList.toggle('on', b.dataset.tab === key);
  requestAnimationFrame(() => fitTab(brain.tabs[key]));
}

function edgeSvg(tab, c) {
  const k = edgeKey(c.from, c.output, c.to);
  if (!tab.svg[k] || !tab.svg[k].isConnected)
    tab.svg[k] = tab.wrap.querySelector(`.connection.node_out_node-${tab.byName[c.from]}.node_in_node-${tab.byName[c.to]}` +
                                        `.output_${c.output + 1}.input_${c.input + 1}`);
  return tab.svg[k];
}

function onKioskActivity(counts) {
  const now = performance.now();
  brain.ticks.push({t: now, counts});
  brain.ticks = brain.ticks.filter(t => now - t.t < 1500);
}

// Tools_Hub's glow follows brain.toolRun (by call id, a minimum time, cleared when an answer ends)
function renderToolRun() {
  const v = brain.toolRun.view(performance.now()), shown = v.running ? v.name : null;
  if (shown === brain.toolShown) return;
  brain.toolShown = shown;
  setToolRunning(shown);
}

function renderFlow() {
  renderToolRun();
  const tab = brain.tabs[brain.current];
  // no animation while arranging: over remote desktop every moving pixel is re-encoded and dragging
  // lagged (2026-10-20); the data itself is ~3 KB/s
  if (!tab || kioskEdit) return;
  const levels = activityLevels(brain.ticks, performance.now());
  const active = new Set();
  for (const c of tab.edges) {
    const svg = edgeSvg(tab, c), level = levels[edgeKey(c.from, c.output, c.to)] || 0;
    if (!svg) continue;
    svg.style.setProperty('--k-flow', level.toFixed(2));
    svg.classList.toggle('k-flow', level > 0.02);
    if (level > 0.02) { active.add(c.from); active.add(c.to); }
  }
  for (const name of Object.keys(tab.byName)) {
    const n = nodeEl(tab, name);
    if (n) n.classList.toggle('k-active', active.has(name));
  }
  const gen = performance.now() < brain.generatingUntil;
  for (const p of kioskPlugins.filter(p => p.type === 'vLLM')) {
    const n = nodeEl(tab, p.name);
    if (n) { n.classList.toggle('k-generating', gen); n.querySelector('.k-node-note').textContent = gen ? T.generating : ''; }
  }
}

function setToolRunning(tool) {
  for (const tab of Object.values(brain.tabs))
    for (const p of kioskPlugins.filter(p => p.type === 'Tools_Hub')) {
      const n = nodeEl(tab, p.name);
      if (!n) continue;
      n.classList.toggle('k-running', !!tool);
      n.querySelector('.k-node-note').textContent = tool ? T.running(tool) : '';
    }
}

function cacheNames() { return kioskPlugins.filter(p => BRIDGE_TYPES.includes(p.type)).map(p => p.name); }

function drawVirtualLink(cache, tool) {
  // tools read caches by name, not over a wire (plugin independence): a temporary dashed line between
  // the sides that face each other, and the cache itself lit, show it
  const tab = brain.tabs.main || brain.tabs.single, hub = kioskPlugins.find(p => p.type === 'Tools_Hub');
  if (!tab || !hub || !(cache in tab.byName) || !(hub.name in tab.byName)) return;
  const a = nodeEl(tab, cache), b = nodeEl(tab, hub.name);
  if (!a || !b) return;
  const box = n => ({x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight});
  const {x0, y0, x1, y1} = linkEnds(box(a), box(b)), mx = (x0 + x1) / 2;
  a.classList.add('k-read');
  a.querySelector('.k-node-note').textContent = T.reading;
  clearTimeout(a._kReadTimer);
  a._kReadTimer = setTimeout(() => { a.classList.remove('k-read'); a.querySelector('.k-node-note').textContent = ''; }, VIRTUAL_LINK_MS);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'k-virtual');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`);
  svg.appendChild(path);
  tab.editor.precanvas.appendChild(svg);
  setTimeout(() => svg.remove(), VIRTUAL_LINK_MS);
}

function onAgentEvent(data) {
  brain.idle.poke(Date.now());
  if (!data || !data.event) return;
  if (data.event === 'segment_start' || data.event === 'segment_delta') brain.generatingUntil = performance.now() + 1500;
  if (data.event === 'tool_call_pending') {
    brain.toolRun.start(data.call_id, data.name, performance.now());
    const cache = cameraOfTool(data.args, '', cacheNames());
    brain.calls[data.call_id] = {name: data.name, args: data.args, linked: !!cache};
    if (cache) drawVirtualLink(cache, data.name);
  }
  if (data.event === 'tool_call_resolved') {
    // no source argument: the tool chose the camera itself, its result says which
    const call = brain.calls[data.call_id];
    if (call && !call.linked) {
      const cache = cameraOfTool(call.args, data.result, cacheNames());
      if (cache) drawVirtualLink(cache, call.name);
    }
    delete brain.calls[data.call_id];
    brain.toolRun.end(data.call_id, performance.now());
  }
  if (data.event === 'tool_call_image') showSeen(data);
  if (data.event === 'turn_error') endOfAnswer('turn_error');
}

// the answer is over: nothing can still be running - say in the console if a tool's end never came
function endOfAnswer(why) {
  const left = brain.toolRun.clear();
  if (left.length) console.warn(`kiosk: ${why} with no tool_call_resolved for ${left.join(', ')}; Tools_Hub turned off`);
}

// ---- what the AI just saw (2026-10-21): the image the last tool handed the model ----------------

function showSeen(ev) {
  const seen = brain.seen;
  if (!seen) return;
  seen.img.src = ev.image;
  seen.img.style.display = '';
  seen.empty.style.display = 'none';
  seen.at = Date.now();
  seen.what = `${ev.name}` + (cameraOfTool(ev.args, '', cacheNames()) ? ` · ${ev.args.source}` : '');
  renderSeenAge();
}

function renderSeenAge() {
  const seen = brain.seen;
  if (!seen || !seen.at) return;
  const s = Math.round((Date.now() - seen.at) / 1000);
  seen.caption.textContent = `${seen.what} · ${s < 2 ? T.justNow : s < 60 ? T.secAgo(s) : T.minAgo(Math.round(s / 60))}`;
}

function fmtDistance(m) { return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`; }

const TRACK_PAGE_MS = 5000;

function renderTracking(listEl) {
  // one row per kind of object, and what the tracker was asked to find (2026-10-21)
  const targets = trackingTargets(brain.trackState);
  const rows = groupTracks(brain.tracks, performance.now(), TRACK_MAX_AGE_MS);
  const seenLabels = new Set(rows.map(r => r.label));
  // one line for every camera that tracks: what it was asked for, where, and what is not seen yet
  const wanted = [...new Set(targets.flatMap(t => t.targets))], missing = wanted.filter(x => !seenLabels.has(x));
  let goal = '';
  if (targets.length)
    goal = `<div class="k-track-goal">${T.lookingFor}<b>${escapeHTML(wanted.join(T.listSep) || '—')}</b>` +
           // what is still missing matters more than the frame rates, so it comes first on the line
           `<span class="k-track-cam">${missing.length ? `<span class="k-track-miss">${T.notSeen}${escapeHTML(missing.join(T.listSep))}</span>　` : ''}` +
           `${escapeHTML(targets.map(t => t.source + (typeof t.fps === 'number' ? ` ${t.fps.toFixed(0)} fps` : '')).join('、'))}</span></div>`;
  const rowHtml = r =>
    `<div class="k-track-row"><span class="k-track-name"><span class="k-track-dot" style="background:${colorFor(r.label)}"></span>` +
    `${escapeHTML(r.label)}<span class="k-track-count">×${r.count}</span></span>` +
    `<span class="k-track-cams">${escapeHTML(r.cameras.join(T.listSep))}</span>` +
    `<span class="k-track-dist">${r.nearest === null ? '' : (r.count > 1 ? T.nearest : '') + fmtDistance(r.nearest)}</span></div>`;
  if (!goal && !rows.length) { listEl.innerHTML = `<div class="k-track-empty">${T.noTracks}</div>`; return; }
  // as many rows as fit (2026-10-21: a long list ran past the panel); when not all do, the list
  // pages through them every TRACK_PAGE_MS with a page line
  const pageLine = (p, n) => `<div class="k-track-more">${T.page(p, n, rows.length)}</div>`;
  const fits = () => listEl.scrollHeight <= listEl.clientHeight + 1;
  listEl.innerHTML = goal + rows.map(rowHtml).join('');
  if (fits()) return;
  let per = rows.length - 1;
  for (; per > 1; per--) {
    listEl.innerHTML = goal + rows.slice(0, per).map(rowHtml).join('') + pageLine(9, 9);
    if (fits()) break;
  }
  const pg = trackPage(rows, per, Date.now(), TRACK_PAGE_MS);
  listEl.innerHTML = goal + pg.rows.map(rowHtml).join('') + pageLine(pg.page, pg.pages);
}

// ---- performance (2026-10-21: more than four numbers) ------------------------------------------

function buildPerf(panel, name) {
  const p = el('div', 'k-perf', panel);
  p.innerHTML = `
    <div class="k-perf-model" data-k="model">—</div>
    <div class="k-perf-cards">
      ${[['response', T.response], ['speed', T.speed], ['gpu', T.gpu], ['power', T.power]].map(([k, label]) => `
        <div class="k-perf-card"><div class="k-perf-label">${label}</div><div class="k-perf-value" data-k="${k}">—</div>
          <svg viewBox="0 0 160 30" preserveAspectRatio="none"><polyline data-spark="${k}"/></svg></div>`).join('')}
    </div>
    <div class="k-perf-turn-title">${T.turnTitle} <span data-k="turn_total"></span></div>
    <div class="k-perf-turn" data-k="turn"></div>
    <div class="k-perf-extra" data-k="extra"></div>`;
  addPerformanceMonitorHooks(name);
  const q = k => p.querySelector(`[data-k="${k}"]`), spark = k => p.querySelector(`[data-spark="${k}"]`);
  const render = () => {
    const st = perfMonitorStates[name] || {}, v = compactView(st, T.secUnit), turns = st.turns || [], hist = st.history || [];
    const last = turns.length ? turns[turns.length - 1] : null, sys = st.system || {};
    q('model').textContent = st.model ? `${st.model}${st.mtp ? ' · MTP' : ''}` : '';
    for (const k of ['response', 'speed', 'gpu', 'power']) q(k).textContent = v[k];
    const recent = turns.slice(-20);
    spark('response').setAttribute('points', sparkPoints(recent.map(t => t.response_s), 160, 30));
    spark('speed').setAttribute('points', sparkPoints(recent.map(t => t.tok_s), 160, 30));
    spark('gpu').setAttribute('points', sparkPoints(hist.slice(-120).map(h => h[1]), 160, 30));
    spark('power').setAttribute('points', sparkPoints(hist.slice(-120).map(h => h[2]), 160, 30));
    const segs = turnSegments(last, kioskLang), total = segs.reduce((a, x) => a + x.seconds, 0);
    q('turn_total').textContent = last && last.input ? `「${last.input}」` : '';
    q('turn').innerHTML = segs.length ? segs.map(x =>
      `<div class="k-seg k-seg-${x.kind}" style="flex-grow:${Math.max(x.seconds / total, 0.06)}" title="${escapeHTML(x.label)}">` +
      `<span>${escapeHTML(x.label)}</span><b>${x.seconds < 0.1 ? x.seconds.toFixed(2) : x.seconds.toFixed(1)} s</b></div>`).join('')
      : `<div class="k-track-empty">${T.noTurn}</div>`;
    const rounds = last ? last.rounds || [] : [];
    const cached = rounds.reduce((a, r) => a + (r.cached_tok || 0), 0), prompt = rounds.reduce((a, r) => a + (r.prompt_tok || 0), 0);
    const bits = [];
    if (last && last.prefill_tok_s) bits.push(T.prefill(Math.round(last.prefill_tok_s).toLocaleString()));
    if (prompt) bits.push(T.cacheHit(Math.round(100 * cached / prompt)));
    if (typeof sys.mem_used_gb === 'number') bits.push(T.memory(sys.mem_used_gb.toFixed(0)));
    if (typeof sys.cpu === 'number') bits.push(`CPU ${sys.cpu.toFixed(0)}%`);
    q('extra').textContent = bits.join('　·　');
  };
  render();
  setInterval(render, 1000);
}

// ---- panels shared by the brain screen and the single page ------------------------------------------

// tabs: [{key, label, names}]; the buttons only when there is more than one
function buildPipelinePanel(stage, rect, tabs) {
  const pipe = el('div', 'k-panel', stage); place(pipe, rect);
  el('div', 'k-panel-title', pipe).textContent = 'EDGE AGENT PIPELINE';
  if (tabs.length > 1) {
    const bar = el('div', 'k-tabs', pipe);
    tabs.forEach(({key, label}, i) => {
      const b = el('button', 'k-tab', bar); b.textContent = `${i + 1}  ${label}`; b.dataset.tab = key;
      b.addEventListener('click', () => { brain.idle.poke(Date.now()); showTab(key); });
    });
  }
  brain.pipePanel = pipe;
  if (kioskEdit) {
    const copy = k => ({positions: Object.assign({}, ((kioskSaved[k] || {}).positions) || {}),
                        hidden: [...(((kioskSaved[k] || {}).hidden) || [])],
                        routes: Object.assign({}, ((kioskSaved[k] || {}).routes) || {})});
    brain.edit = {};
    for (const {key} of tabs) brain.edit[key] = copy(key);
    document.body.classList.add('k-edit');
    brain.editBar = el('div', 'k-edit-bar', pipe);
    if (!kioskPreset) brain.editBar.textContent = '沒有載入 preset，不能編輯';
  }
  for (const {key, names} of tabs) buildPipelineTab(pipe, key, names);
  return pipe;
}

// the tracker's boxes and its panel state, into brain.tracks / brain.trackState
function watchTracking(conf) {
  if (!kioskPlugins.find(p => p.name === conf.tracking)) return;
  addOutputListener(conf.tracking, 2, msg => {
    if (msg && msg.overlay === 'tracking') brain.tracks[msg.camera] = {t: performance.now(), tracks: msg.tracks || []};
  });
  addOutputListener(conf.tracking, 1, msg => { if (msg && msg.panel === 'tracking') brain.trackState = msg.state; });
}

function buildChatPanel(stage, rect, conf, opts) {
  const find = name => kioskPlugins.find(p => p.name === name);
  const chat = el('div', 'k-panel', stage); place(chat, rect);
  el('div', 'k-panel-title', chat).textContent = T.chat;
  brain.idle = new IdleTimer(conf.idle_ms || 30000);
  brain.idle.poke(Date.now());
  if (opts.listenBubble)
    listen.bubble = el('div', 'k-listen', chat,
      `<div class="k-listen-label"><span class="k-listen-dot"></span>${escapeHTML(T.listening)}</div><div class="k-listen-text"></div>`);
  if (find(conf.chat)) {
    // the chat registers its own channel-6 listener first (addAgentLoopTimeline() skips if one exists)
    const chatBox = el('div', 'k-chat', chat);
    mountAgentLoopChat(chatBox, conf.chat, 'kiosk_chat', 'AgentLoop',
                       {input: find(conf.input) ? conf.input : null, placeholder: opts.placeholder});
    if (listen.bubble) chatBox.insertBefore(listen.bubble, chatBox.querySelector('.chat-input'));   // after the history
    if (opts.examples && opts.examples.length) buildExamples(chatBox, conf.chat, opts.examples);

    addOutputListener(conf.chat, 6, onAgentEvent);
    // the history is broadcast when a turn starts (last entry: the question) and ends (the answer)
    addOutputListener(conf.chat, 3, history => {
      brain.idle.poke(Date.now());
      const last = Array.isArray(history) && history.length ? history[history.length - 1] : null;
      if (last && last.role !== 'user') endOfAnswer('answer finished');
    });
  }
  return chat;
}

// "試試問我" over the chat input: one example at a time; a click asks it, unless the AI is answering
const EXAMPLE_PERIOD_MS = 6000;
function buildExamples(chatBox, chatName, examples) {
  const bar = el('button', 'k-examples', null);
  bar.type = 'button';
  chatBox.insertBefore(bar, chatBox.querySelector('.chat-input'));
  const state = {clickedAt: 0, lastEventAt: 0};
  addOutputListener(chatName, 6, data => { if (isAnswerEvent(data)) state.lastEventAt = Date.now(); });
  let shown = null;
  const render = () => {
    const q = exampleAt(examples, Date.now(), EXAMPLE_PERIOD_MS);
    bar.classList.toggle('busy', agentBusy(state, Date.now()));
    if (q === shown) return;
    shown = q;
    bar.classList.remove('k-in'); void bar.offsetWidth; bar.classList.add('k-in');   // restart the fade
    bar.innerHTML = `<span class="k-examples-label">💡 ${escapeHTML(T.tryAsking)}</span>「${escapeHTML(q)}」`;
  };
  bar.addEventListener('click', () => {
    if (!shown || agentBusy(state, Date.now())) return;
    const input = chatBox.querySelector('.chat-input textarea');
    if (!input) return;
    input.value = shown;   // the chat's own send (same as typing it and pressing Enter)
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    state.clickedAt = Date.now();
    render();
  });
  render();
  setInterval(render, 500);
}

function buildSeenPanel(stage, rect) {
  const seenPanel = el('div', 'k-panel', stage); place(seenPanel, rect);
  el('div', 'k-panel-title', seenPanel).textContent = T.seen;
  const seenBox = el('div', 'k-seen', seenPanel);
  brain.seen = {img: el('img', 'k-seen-img', seenBox), caption: el('div', 'k-seen-caption', seenBox),
                empty: el('div', 'k-track-empty k-seen-empty', seenBox), at: 0};
  brain.seen.img.style.display = 'none';
  brain.seen.empty.textContent = T.seenEmpty;
  setInterval(renderSeenAge, 1000);
  return seenPanel;
}

function buildBrainScreen(stage) {
  const conf = kioskLayout.brain, find = name => kioskPlugins.find(p => p.name === name);

  const parts = partitionNodes(kioskPlugins);
  buildPipelinePanel(stage, BRAIN_RECTS.pipeline, [{key: 'main', label: T.tabMain, names: parts.main},
                                                   {key: 'sensor', label: T.tabSensor, names: parts.sensor}]);

  const perf = el('div', 'k-panel', stage); place(perf, BRAIN_RECTS.perf);
  el('div', 'k-panel-title', perf).textContent = T.perf;
  if (find(conf.perf)) buildPerf(perf, conf.perf);

  const track = el('div', 'k-panel', stage); place(track, BRAIN_RECTS.tracking);
  el('div', 'k-panel-title', track).textContent = T.tracking;
  const list = el('div', 'k-track-list', track);
  watchTracking(conf);
  setInterval(() => renderTracking(list), 500);

  buildChatPanel(stage, BRAIN_RECTS.chat, conf, {placeholder: T.placeholder, listenBubble: true});
  buildSeenPanel(stage, BRAIN_RECTS.seen);

  document.addEventListener('keydown', e => {
    brain.idle.poke(Date.now());
    if (e.target.closest && e.target.closest('textarea,input')) return;   // typing a question
    if (e.key === '1') showTab('main');
    if (e.key === '2') showTab('sensor');
  });
  document.addEventListener('mousemove', () => brain.idle.poke(Date.now()));
  if (!kioskEdit)   // nobody is arranging nodes on the booth screen
    setInterval(() => { if (brain.idle.check(Date.now()) && brain.current !== 'main') showTab('main'); }, 1000);
  setInterval(renderFlow, FLOW_TICK_MS);
  showTab('main');
}

// ---- single page (docs/superpowers/specs/2026-11-04-orin-single-screen-kiosk-design.md) -------------
// One screen, one camera (the Orin workshop): camera above the pipeline on the left, the chat above
// what the AI saw on the right, four numbers in the banner. Nodes come from kiosk_layout.json "single".

const SINGLE_RECTS = {camera: [8, 72, 1184, 496], pipeline: [8, 576, 1184, 496],
                      chat: [1200, 72, 712, 620], seen: [1200, 700, 712, 372]};

function buildSingleBanner(conf) {
  const title = document.querySelector('.k-banner .k-brand-title');
  if (title && conf.title) title.textContent = (kioskLang === 'en' && conf.title_en) || conf.title;
  const bar = document.querySelector('.k-banner'), clock = bar && bar.querySelector('.k-clock');
  if (!bar) return;
  const kpis = el('div', 'k-kpis');
  bar.insertBefore(kpis, clock);
  const hasPerf = !!kioskPlugins.find(p => p.name === conf.perf);
  if (hasPerf) addPerformanceMonitorHooks(conf.perf);
  const render = () => {
    kpis.innerHTML = bannerKpis(hasPerf ? perfMonitorStates[conf.perf] : null, kioskLang).map(k =>
      `<div class="k-kpi"><span class="k-kpi-label">${escapeHTML(k.label)}</span><b>${escapeHTML(k.value)}</b></div>`).join('');
  };
  render();
  setInterval(render, 1000);
}

function buildSingleCamera(stage, conf) {
  const box = el('div', 'k-slot k-single-camera', stage);
  place(box, SINGLE_RECTS.camera);
  el('div', 'k-looked-tag', box).textContent = T.aiLooking;
  const missing = !kioskPlugins.find(p => p.name === conf.video);
  cameraScreen.slots = [{slot: 'single', node: conf.video, track: true, missing}];
  cameraScreen.boxes.single = box;
  if (missing) { el('div', 'k-missing', box, T.missing); return; }
  buildVideoSlot(box, conf.video);
  const hub = kioskPlugins.find(p => p.type === 'Tools_Hub');
  if (hub) addTrackBoxesHooks(hub.name);
  // "AI 正在看" lights the camera the AI reads, found by wiring as on the camera screen
  for (const p of kioskPlugins.filter(p => p.type === 'AgentLoop')) addOutputListener(p.name, 6, onCameraScreenAgentEvent);
  const tag = el('div', 'k-track-tag', box);
  setInterval(() => {
    const v = trackingTag(brain.trackState, brain.tracks, performance.now(), TRACK_MAX_AGE_MS, kioskLang);
    tag.textContent = v.text;
    tag.classList.toggle('on', v.show);
  }, 500);
}

function buildSingleScreen(stage) {
  const conf = kioskLayout.single || {};
  buildSingleBanner(conf);
  // the chat first: its live timeline is only built by the first channel-6 listener of the AgentLoop
  // (addAgentLoopTimeline()), and the camera's "AI 正在看" listens on channel 6 too
  buildChatPanel(stage, SINGLE_RECTS.chat, conf, {placeholder: T.placeholderTyped, listenBubble: false,
                                                  examples: exampleQuestions(conf, kioskLang)});
  buildSingleCamera(stage, conf);
  watchTracking(conf);
  buildPipelinePanel(stage, SINGLE_RECTS.pipeline, [{key: 'single', label: '', names: singleNodes(kioskPlugins)}]);
  buildSeenPanel(stage, SINGLE_RECTS.seen);
  setInterval(renderFlow, FLOW_TICK_MS);
  showTab('single');
}

// ---- speaker (2026-10-21) ---------------------------------------------------------------------
// The kiosk's speaker: WebAudioOut's 48 kHz int16 samples (MESSAGE_AUDIO) played through the same
// AudioOutputProcessor worklet as Studio (audioWorkers.js), output only - the microphone is never
// opened, so there is no permission prompt. Which screen plays: kioskPlaysAudio() (kiosk_logic.js).
// A browser starts audio suspended until the page is clicked or a key is pressed: until then a hint
// shows, and samples are dropped rather than queued (they would play late, all at once).

const kioskAudio = {ctx: null, worklet: null, hint: null};

function kioskAudioStart() {
  if (!kioskPlaysAudio(kioskScreen, window.location.search) || !window.AudioContext) return;
  try {
    kioskAudio.ctx = new AudioContext({sampleRate: 48000});
  } catch (e) {
    console.warn('kiosk audio unavailable', e);
    return;
  }
  kioskWorklets(kioskAudio.ctx).then(() => {
    kioskAudio.worklet = new AudioWorkletNode(kioskAudio.ctx, 'AudioOutputProcessor');
    kioskAudio.worklet.connect(kioskAudio.ctx.destination);
  }).catch(e => console.warn('kiosk audio worklet failed', e));

  kioskAudio.hint = document.createElement('div');
  kioskAudio.hint.className = 'k-audio-hint';
  kioskAudio.hint.textContent = T.audioHint;
  document.body.appendChild(kioskAudio.hint);
  // click, not pointerdown: Firefox counts a press as a gesture only once it is a click (2026-10-21)
  const unlock = () => { if (kioskAudio.ctx.state !== 'running') kioskAudio.ctx.resume().then(kioskAudioShowState); };
  for (const ev of ['click', 'keydown', 'touchend']) window.addEventListener(ev, unlock, {capture: true});
  kioskAudio.ctx.addEventListener('statechange', kioskAudioShowState);
  kioskAudioShowState();
}

// audioWorkers.js once per context: loading it again re-registers its processors, which throws
function kioskWorklets(ctx) {
  if (!ctx._kWorklets) ctx._kWorklets = ctx.audioWorklet.addModule('/static/audioWorkers.js');
  return ctx._kWorklets;
}

// ---- browser microphone (2026-11-06): what Studio's mic does (audio.js openAudioDevices) - 16-bit
// samples as MESSAGE_AUDIO at the context's 48 kHz, which WebAudioIn assumes (web_audio.py) ----
const kioskMic = {on: false, stream: null, nodes: [], btn: null};

function buildMicButton() {
  if (!kioskNeedsBrowserMic(kioskScreen, kioskPlugins)) return;
  const bar = document.querySelector('.k-banner');
  if (!bar) return;
  kioskMic.btn = document.createElement('button');
  kioskMic.btn.type = 'button';
  kioskMic.btn.className = 'k-micbtn';
  bar.insertBefore(kioskMic.btn, bar.querySelector('.k-kpis') || bar.querySelector('.k-clock'));
  kioskMic.btn.addEventListener('click', () => kioskMic.on ? stopKioskMic() : startKioskMic());
  renderKioskMic();
}

function renderKioskMic(text) {
  if (!kioskMic.btn) return;
  kioskMic.btn.classList.toggle('on', kioskMic.on);
  kioskMic.btn.textContent = `🎤 ${text || (kioskMic.on ? T.micOff : T.micOn)}`;
}

async function startKioskMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
    if (!kioskAudio.ctx) kioskAudio.ctx = new AudioContext({sampleRate: 48000});
    const ctx = kioskAudio.ctx;
    if (ctx.state !== 'running') await ctx.resume();     // the click is the gesture
    await kioskWorklets(ctx);
    const src = ctx.createMediaStreamSource(stream), cap = new AudioWorkletNode(ctx, 'AudioCaptureProcessor');
    const silent = ctx.createGain();
    silent.gain.value = 0;                               // pulled by the graph, never heard
    src.connect(cap).connect(silent).connect(ctx.destination);
    cap.port.onmessage = e => { if (kioskMic.on) sendWebsocket(e.data, MESSAGE_AUDIO); };
    Object.assign(kioskMic, {on: true, stream, nodes: [src, cap, silent]});
    renderKioskMic();
  } catch (e) {
    console.warn('kiosk microphone', e);
    renderKioskMic(T.micDenied);
    setTimeout(() => renderKioskMic(), 4000);
  }
}

function stopKioskMic() {
  kioskMic.on = false;
  for (const n of kioskMic.nodes) n.disconnect();
  if (kioskMic.stream) kioskMic.stream.getTracks().forEach(t => t.stop());
  Object.assign(kioskMic, {stream: null, nodes: []});
  renderKioskMic();
}

function kioskAudioShowState() {
  if (kioskAudio.hint) kioskAudio.hint.classList.toggle('on', kioskAudio.ctx.state !== 'running');
}

function kioskAudioPlay(payload) {
  if (!kioskAudio.worklet || kioskAudio.ctx.state !== 'running') return;
  const samples = new Int16Array(payload);
  kioskAudio.worklet.port.postMessage(samples, [samples.buffer]);
}
