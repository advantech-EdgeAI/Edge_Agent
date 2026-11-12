// The auto page, /kiosk?screen=auto (docs/superpowers/specs/2026-11-06-generic-kiosk-display-design.md):
// for any preset - the camera, the pipeline, and a column of cards chosen by node type. Which cards and
// where is decided in kiosk_logic.js (autoCards, mainVideo, layoutCards, columnRects); this file is the
// DOM, built on kiosk.js's pieces. Read-only like the other kiosk pages.

const auto = {title: '', alert: null};

// kiosk.js hands every state_dict here (onKioskMsg): the same listeners Studio's widgets use (output_bus.js)
function setKioskState(stateDict) {
  for (const [name, state] of Object.entries(stateDict || {}))
    for (const listener of stateListeners[name] || []) {
      try { listener(state); } catch (e) { console.error(`state listener for ${name} failed:`, e); }
    }
}

function buildAutoScreen(stage) {
  const byType = type => kioskPlugins.find(p => p.type === type);
  const perf = byType('PerformanceMonitor');
  auto.title = 'Edge AI Agent';   // the preset name wrapped the banner onto two lines (2026-11-06, the user)
  buildSingleBanner({title: auto.title, perf: perf && perf.name});
  buildBackLink();

  // camera: the main picture, the other VideoOutputs as thumbnails (spec §8.1)
  const video = mainVideo(kioskPlugins, kioskLayout);
  if (video.main) {
    const box = el('div', 'k-slot k-single-camera', stage);
    place(box, video.thumbs.length ? AUTO_RECTS.cameraWithThumbs : AUTO_RECTS.camera);
    buildVideoSlot(box, video.main);
    const hub = byType('Tools_Hub');
    if (hub) { addTrackBoxesHooks(hub.name); watchTracking({tracking: hub.name}); }
  }
  if (video.thumbs.length) {
    const [x, y, w, h] = AUTO_RECTS.thumbs, gap = 8, tw = (w - gap * (video.thumbs.length - 1)) / video.thumbs.length;
    video.thumbs.forEach((name, i) => {
      const box = el('div', 'k-slot k-auto-thumb', stage);
      place(box, [x + i * (tw + gap), y, tw, h]);
      buildVideoSlot(box, name);
    });
  }

  buildPipelinePanel(stage, AUTO_RECTS.pipeline, [{key: 'auto', label: '', names: pipelinePlugins(kioskPlugins).map(p => p.name)}]);
  setInterval(renderFlow, FLOW_TICK_MS);
  showTab('auto');

  // the right column (spec §5, §6)
  const {shown, hidden} = layoutCards(autoCards(kioskPlugins, kioskConnections));
  const chat = shown.find(c => c.kind === 'chat');
  if (chat) {
    const input = byType('UserPrompt');
    buildChatPanel(stage, [1200, 72, 712, 620], {chat: chat.node, input: input && input.name},
                   {placeholder: T.placeholderTyped, listenBubble: false});
    buildSeenPanel(stage, [1200, 700, 712, 372]);
  } else {
    const rects = columnRects(shown.length);
    const bodies = shown.map((card, i) => CARD_BUILDERS[card.kind](stage, rects[i], card.node));
    // inside the last card: the alert frame covers the page's outer 6 px
    if (hidden.length && bodies.length) el('div', 'k-auto-more', bodies[bodies.length - 1]).textContent = T.moreCards(hidden.length);
  }
  setInterval(renderAlarm, 500);
}

function buildBackLink() {
  const bar = document.querySelector('.k-banner'), clock = bar && bar.querySelector('.k-clock');
  if (!bar) return;
  const a = el('a', 'k-auto-back');
  a.href = '/';
  a.textContent = T.backToStudio;
  bar.insertBefore(a, clock);
}

function cardPanel(stage, rect, title, node) {
  const panel = el('div', 'k-panel k-auto-card', stage); place(panel, rect);
  el('div', 'k-panel-title', panel).textContent = `${title} · ${node}`;
  return el('div', 'k-auto-body', panel);
}

// ---- VLM verdict: the newest answer large, the two before it small --------------------------------

function buildVlmCard(stage, rect, node) {
  const body = cardPanel(stage, rect, T.cardVlm, node);
  const now = el('div', 'k-auto-verdict', body), older = el('div', 'k-auto-older', body);
  let list = [];
  const render = () => {
    now.textContent = list[0] || '…';
    older.replaceChildren(...list.slice(1).map(t => { const d = document.createElement('div'); d.textContent = t; return d; }));
  };
  const take = text => { list = vlmHistory(list, text); render(); };
  const plugin = kioskPlugins.find(p => p.name === node);
  if (plugin && plugin.type === 'TextStream') {
    // TextStream sends HTML-escaped text with <br/> as state (text_stream.py); partial / delta chunks skipped
    addStateListener(node, state => {
      if (!state || state.partial || state.delta || typeof state.text !== 'string') return;
      // DOMParser runs nothing (no scripts, no onerror) - it only turns the escaped HTML back into text
      const doc = new DOMParser().parseFromString(state.text.replace(/<br\/>/g, ' '), 'text/html');
      take(doc.body.textContent.trim());
    });
  } else {
    addOutputListener(node, 2, text => take(typeof text === 'string' ? text.trim() : ''));   // OutputFinal
  }
  render();
  return body;
}

// ---- alert: normal / fired, how many times this session; the whole page frame turns red ---------

function buildAlertCard(stage, rect, node) {
  const body = cardPanel(stage, rect, T.cardAlert, node);
  const panel = body.parentElement;
  const status = el('div', 'k-auto-verdict', body), count = el('div', 'k-auto-older', body);
  const render = () => {
    const on = alertActive(auto.alert, Date.now());
    panel.classList.toggle('k-auto-alarm', on);
    status.textContent = on ? `⚠️ ${auto.alert.text}　${alertTime(auto.alert.at)}` : T.alertNormal;
    count.textContent = auto.alert ? T.alertCount(auto.alert.count) : '';
  };
  addOutputListener(node, 0, text => {
    auto.alert = alertState(auto.alert, typeof text === 'string' ? text : String(text), Date.now());
    render();
    renderAlarm();
  });
  setInterval(render, 500);
  render();
  return body;
}

function alertTime(ms) {
  const opts = {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false};
  if (kioskLayout && kioskLayout.timezone) opts.timeZone = kioskLayout.timezone;
  return new Date(ms).toLocaleTimeString(CLOCK_LOCALE, opts);
}

function renderAlarm() {
  const on = alertActive(auto.alert, Date.now());
  document.body.classList.toggle('k-alarm', on);
  const title = document.querySelector('.k-banner .k-brand-title');
  if (title) title.textContent = on ? `⚠️ ${auto.alert.text}　${alertTime(auto.alert.at)}` : auto.title;
}

// ---- RAG: the picture now beside the closest reference, similarity, threshold, tag -------------

function buildRagCard(stage, rect, node) {
  const body = cardPanel(stage, rect, T.cardRag, node);
  const pair = el('div', 'k-auto-pair', body);
  const left = el('figure', '', pair), right = el('figure', '', pair);
  const frame = el('img', 'k-auto-img', left);
  el('figcaption', '', left).textContent = T.ragNow;
  const ref = el('img', 'k-auto-img', right), none = el('div', 'k-auto-none', right);
  none.textContent = T.ragNone;
  el('figcaption', '', right).textContent = T.ragRef;
  const info = el('div', 'k-auto-older', body);
  // tag the current frame into the database: the message Studio's NanoDB widget sends (grid.js tag_onsubmit)
  const form = el('div', 'k-auto-tag', body);
  const input = el('input', '', form);
  input.placeholder = T.ragTagPlaceholder;
  const add = el('button', '', form);
  add.textContent = T.ragAdd;
  const chips = el('div', 'k-auto-chips', body);
  const tag = text => {
    const t = (text || '').trim();
    if (!t) return;
    sendWebsocket({[node]: {tag_image: t}});
    input.value = '';
    info.dataset.note = T.ragAdded(t);
  };
  add.addEventListener('click', () => tag(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tag(input.value); });
  let known = [];
  const plugin = kioskPlugins.find(p => p.name === node) || {};
  const threshold = typeof plugin.rag_threshold === 'number' ? plugin.rag_threshold : 90;

  // NanoDB's preview output: the frame it searched + its results, in one message (rag_preview.py) - the
  // browser's own video arrives later than JSON, so pairing with it showed the reference "ahead" (2026-11-06)
  const loaded = new Set();   // reference images the browser already has: shown together with their frame
  let latest = 0;
  const apply = (image, v, show) => {
    frame.src = image;
    ref.style.display = show ? 'block' : 'none';
    none.style.display = show ? 'none' : 'flex';
    if (show && ref.dataset.path !== v.best.path) { ref.src = ragImageUrl(v.best.path); ref.dataset.path = v.best.path; }
    if (!show) ref.dataset.path = '';
  };
  addOutputListener(node, 2, preview => {
    if (!preview || typeof preview.image !== 'string') return;
    const results = preview.results;
    const v = ragView(results, threshold);
    const show = !!(v.best && v.above);
    const seq = ++latest;
    if (!show || loaded.has(v.best.path)) apply(preview.image, v, show);
    else {   // a reference not loaded yet: wait for it, so the two pictures still change together
      const pre = new Image();
      pre.onload = () => { loaded.add(v.best.path); if (seq === latest) apply(preview.image, v, show); };
      pre.src = ragImageUrl(v.best.path);
    }
    const sim = v.best ? `${(v.best.similarity * 100).toFixed(1)}%` : '—';
    info.textContent = T.ragSim(sim, `${threshold}%`) + (show && v.best.tag ? `　${v.best.tag}` : '')
                       + (info.dataset.note ? `　✓ ${info.dataset.note}` : '');
    const tags = ragKnownTags(results);
    if (tags.join('\n') !== known.join('\n')) {
      known = tags;
      chips.replaceChildren(...tags.map(t => {
        const b = document.createElement('button');
        b.textContent = t;
        b.addEventListener('click', () => tag(t));
        return b;
      }));
    }
  });
  ref.style.display = 'none';
  info.textContent = T.ragSim('—', `${threshold}%`);
  return body;
}

// ---- second batch (spec §5.1) ----------------------------------------------------------------

function rowsOf(list, fmt) {
  return list.map(item => { const d = document.createElement('div'); d.textContent = fmt(item); return d; });
}

// detection: the status the detector speaks, then this frame's objects
function buildDetectCard(stage, rect, node) {
  const body = cardPanel(stage, rect, T.cardDetect, node);
  const status = el('div', 'k-auto-verdict', body), list = el('div', 'k-auto-older', body);
  status.textContent = '…';
  list.textContent = T.noDetections;
  addOutputListener(node, 0, text => { if (typeof text === 'string' && text.trim()) status.textContent = text.trim(); });
  addOutputListener(node, 3, json => {
    const rows = detectView(json);
    if (!rows.length) { list.textContent = T.noDetections; return; }
    list.replaceChildren(...rowsOf(rows, r => `${r.name} × ${r.count}　${Math.round(r.best * 100)}%`));
  });
  return body;
}

// event log: the newest three events, formatted like Studio's EventLog widget (event_log.js cardView)
function buildEventCard(stage, rect, node) {
  const body = cardPanel(stage, rect, T.cardEvent, node);
  const list = el('div', 'k-auto-events', body);
  list.textContent = T.noEvents;
  let key = '';
  addOutputListener(node, 0, state => {
    const events = ((state && state.events) || []).slice(0, 3);
    const k = JSON.stringify(events.map(e => [e.id, e.status, e.summary, e.thumbnail]));
    if (k === key) return;
    key = k;
    if (!events.length) { list.textContent = T.noEvents; return; }
    list.replaceChildren(...events.map(e => {
      const v = cardView(e, T), row = document.createElement('div');
      row.className = 'k-auto-event' + (v.pending ? ' pending' : '');
      const url = assetUrl(e.thumbnail);
      if (url) { const img = document.createElement('img'); img.src = url; row.appendChild(img); }
      const text = document.createElement('div');
      const head = document.createElement('b'); head.textContent = `${v.time}　${v.type}`;
      const sum = document.createElement('div'); sum.textContent = v.summary;
      text.append(head, sum);
      row.appendChild(text);
      return row;
    }));
  });
  return body;
}

// auto-labeling: this frame's labels, the frames so far, "packaged N" once DatasetCollector has zipped them
function buildLabelCard(stage, rect, node) {
  const body = cardPanel(stage, rect, T.cardLabel, node);
  const now = el('div', 'k-auto-verdict', body), total = el('div', 'k-auto-older', body);
  now.textContent = '…';
  let frames = 0, packed = null;
  const renderTotal = () => { total.textContent = T.labelFrames(frames) + (packed !== null ? `　✓ ${T.labelPacked(packed)}` : ''); };
  addOutputListener(node, 1, json => {
    frames += 1;
    const rows = labelView(json);
    now.textContent = rows.length ? rows.map(r => `${r.name} × ${r.count}`).join('　') : T.noDetections;
    renderTotal();
  });
  const download = el('a', 'k-auto-download', body);
  download.textContent = `⬇ ${T.labelDownload}`;
  download.style.display = 'none';
  const collectors = kioskPlugins.filter(p => p.type === 'DatasetCollector');
  for (const p of collectors)
    addStateListener(p.name, state => {
      if (!state || !state.ready || typeof state.count !== 'number') return;
      packed = state.count; renderTotal();
      const url = datasetDownloadUrl(state.job_id);
      if (url) { download.href = url; download.setAttribute('download', `${state.job_id}.zip`); download.style.display = ''; }
    });
  // a folder preset (2026-11-06, the user): pick and label from here, the same calls as Studio's
  // DatasetLoader window (grid.js addDatasetLoaderWidget); camera presets have no DatasetLoader
  const loader = kioskPlugins.find(p => p.type === 'DatasetLoader'), hide = () => { download.style.display = 'none'; };
  if (loader) buildUploadRow(body, loader.name, collectors.map(p => p.name), hide);
  // a camera preset: Studio's DatasetCollector Start / Stop (grid.js addDatasetCollectorControlWidget)
  else if (collectors.length) buildCollectRow(body, collectors[0].name, hide);
  renderTotal();
  return body;
}

function buildCollectRow(body, collector, onStart) {
  const row = el('div', 'k-auto-tag', body);
  const start = el('button', '', row), stop = el('button', '', row);
  start.textContent = T.labelCollect; stop.textContent = T.labelStopPack; stop.disabled = true;
  const status = el('div', 'k-auto-older', body);
  start.addEventListener('click', () => {
    sendWebsocket({[collector]: {start_collecting: {}}});
    status.textContent = T.labelCollecting;
    start.disabled = true; stop.disabled = false;
    onStart();
  });
  stop.addEventListener('click', () => {
    sendWebsocket({[collector]: {stop_and_package: {}}});
    status.textContent = T.labelPacking;
    stop.disabled = true;
  });
  // packaged (the download shows) or failed: either way a new run can start
  addStateListener(collector, state => {
    if (!state) return;
    if (state.error) status.textContent = state.error;
    else if (state.ready) status.textContent = '';
    start.disabled = false; stop.disabled = true;
  });
}

function buildUploadRow(body, loader, collectors, onStart) {
  const row = el('div', 'k-auto-tag k-auto-upload', body);
  const pick = el('label', 'k-auto-pick', row);
  pick.textContent = T.labelPick;
  const input = el('input', '', pick);
  input.type = 'file'; input.multiple = true; input.webkitdirectory = true;
  const start = el('button', '', row);
  start.textContent = T.labelStart; start.disabled = true;
  const status = el('div', 'k-auto-older', body);
  let dir = null;
  input.addEventListener('change', async () => {
    const files = [...input.files];
    if (!files.length) return;
    start.disabled = true; dir = null;
    status.textContent = T.labelUploading(files.length);
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    try {
      const r = await fetch('/upload_dataset', {method: 'POST', body: form});
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      dir = data.dir;
      status.textContent = T.labelUploaded(data.count);      // what the server staged, not what was sent
      start.disabled = !dir;
    } catch (e) {
      status.textContent = `${T.labelUploadFailed}：${e.message || e}`;
    }
    input.value = '';
  });
  start.addEventListener('click', () => {
    if (!dir) return;
    for (const c of collectors) sendWebsocket({[c]: {start_collecting: {}}});
    sendWebsocket({[loader]: {start_batch: dir}});
    status.textContent = T.labelRunning;
    start.disabled = true; dir = null;
    onStart();
  });
  addStateListener(loader, state => { if (state && state.error) status.textContent = state.error; });
}

// video generation: a prompt box sent to the preset's UserPrompt (the video itself plays in the big picture)
function buildGenerateCard(stage, rect, node) {
  const body = cardPanel(stage, rect, T.cardGenerate, node);
  const prompt = kioskPlugins.find(p => p.type === 'UserPrompt');
  const form = el('div', 'k-auto-tag', body);
  const input = el('input', '', form);
  input.placeholder = T.generatePlaceholder;
  const send = el('button', '', form);
  send.textContent = T.generateSend;
  const last = el('div', 'k-auto-older', body);
  const go = () => {
    const t = input.value.trim();
    if (!t || !prompt) return;
    sendWebsocket({[prompt.name]: {input: t}});
    last.textContent = `▶ ${t}`;
    input.value = '';
  };
  send.addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  if (!prompt) { input.disabled = send.disabled = true; }
  const image = imageInputOf(kioskPlugins, kioskConnections, node);
  if (image) buildStartImageRow(body, image);
  return body;
}

// the start image (2026-11-06, the user): the same calls as Studio's Image_Input window (grid.js
// addImageInputWidget) - the image as a MESSAGE_IMAGE, {<node>: {clear_image: null}} to drop it
function buildStartImageRow(body, image) {
  const row = el('div', 'k-auto-tag', body);
  const pick = el('label', 'k-auto-pick', row);
  pick.textContent = T.generateImagePick;
  const file = el('input', '', pick);
  file.type = 'file'; file.accept = 'image/*';
  const clear = el('button', '', row);
  clear.textContent = T.generateImageClear; clear.disabled = true;
  const preview = el('img', 'k-auto-start', body);
  preview.style.display = 'none';
  const mode = el('div', 'k-auto-older', body);
  const show = url => {
    if (preview.src) URL.revokeObjectURL(preview.src);
    if (url) { preview.src = url; preview.style.display = ''; } else { preview.removeAttribute('src'); preview.style.display = 'none'; }
    clear.disabled = !url;
    mode.textContent = url ? T.generateModeVideo : T.generateModeImage;
  };
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    sendWebsocket(await f.arrayBuffer(), MESSAGE_IMAGE, f.name.split('.').pop().toLowerCase());
    show(URL.createObjectURL(f));
    file.value = '';
  });
  clear.addEventListener('click', () => { sendWebsocket({[image]: {clear_image: null}}); show(null); });
  show(null);
}

const CARD_BUILDERS = {vlm: buildVlmCard, alert: buildAlertCard, rag: buildRagCard,
                       event: buildEventCard, detect: buildDetectCard, label: buildLabelCard, generate: buildGenerateCard};
