// ObjectTracker panel (docs/superpowers/specs/2026-10-01-object-tracker-design.md §5).
// Pure functions first (tested with node: tests/js/object_tracker.test.js), browser code after.

function trackerRows(state) {
  return ((state && state.cameras) || []).map(c => ({
    source: c.source, enabled: !!c.enabled, objects: (c.objects || []).join(', '),
    fps: (c.enabled && typeof c.fps === 'number') ? `${c.fps.toFixed(1)} fps` : '—',
    count: (c.enabled && typeof c.count === 'number') ? `${c.count}` : '—',
    note: c.note || '', depth: !!c.has_depth, examples: (c.examples || []).join(', ')}));
}

function changeText(state) {
  const c = state && state.last_change;
  if (!c) return '';
  return `Last set by ${c.by === 'agent' ? 'the agent' : 'the panel'} at ${c.time}`;
}

function statusText(state) {
  const s = (state && state.model_status) || 'loading';
  if (s === 'ready') return 'Model: ready';
  if (s === 'loading') return 'Model: loading';
  return `Model: error (${s.replace(/^error:\s*/, '')})`;
}

// The panel belongs to Tools_Hub's tracking tool module (2026-10-04: no ObjectTracker node): its
// state arrives on Tools_Hub output 1 as {panel: "tracking", show, state}, its controls go back
// through Tools_Hub.panel().
function trackingPanelId(name) { return `${name}_tracking_grid`; }

function panelMessage(name, action, args) {
  return {[name]: {panel: Object.assign({module: 'tracking', action: action}, args || {})}};
}

function panelGridOptions(saved, mode) {
  // the panel's saved place for this view (preset globals["<Tools_Hub>_tracking"]), else only a
  // default size; sensor_view.js pickLayout() falls back to layout_grid
  const lg = saved && (typeof pickLayout === 'function' ? pickLayout(saved, mode) : saved.layout_grid);
  if (lg && ['x', 'y', 'w', 'h'].every(k => typeof lg[k] === 'number')) return {x: lg.x, y: lg.y, w: lg.w, h: lg.h};
  return {w: 8, h: 4};
}

if (typeof module !== 'undefined') module.exports = {trackerRows, changeText, statusText, trackingPanelId, panelMessage, panelGridOptions};

// ---- browser side -----------------------------------------------------------------------------
var objectTrackerStates = {};   // Tools_Hub name -> last tracking state
var objectTrackerShown = {};    // Tools_Hub name -> whether the user shows the panel
var objectTrackerPlacing = {};  // Tools_Hub name -> true while its saved place is being fetched

function addObjectTrackerHooks(name) {
  if( !(name in outputListeners && 1 in outputListeners[name]) )
    addOutputListener(name, 1, function(msg) {
      if (!msg || msg.panel !== 'tracking') return;
      objectTrackerStates[name] = msg.state;
      objectTrackerShown[name] = !!msg.show;
      syncTrackingPanel(name);
      renderPanelToggle(name);
      renderObjectTracker(name);
    });
  sendWebsocket(panelMessage(name, 'refresh'));
}

function syncTrackingPanel(name) {
  const id = trackingPanelId(name);
  const el = document.getElementById(id);
  if (objectTrackerShown[name] && !el && !objectTrackerPlacing[name]) {
    // created only after the preset loaded, so it must go to its saved place right away: placed
    // anywhere, GridStack would push (and save) the other widgets out of the way (2026-10-04)
    objectTrackerPlacing[name] = true;
    let done = false;
    const create = saved => {
      if (done) return;
      done = true;
      objectTrackerPlacing[name] = false;
      if (objectTrackerShown[name] && !document.getElementById(id)) {
        // no reply within 1.5 s may only mean a busy Studio (loading a model): show the default size
        // but do not save it over the saved place - the late reply moves the panel there
        // (2026-10-14: the panel's 9x7 was overwritten with 8x4 that way)
        if (!saved && typeof widgetsPlacedFromSave !== 'undefined')
          widgetsPlacedFromSave.add(id.replace('_grid', ''));   // GridStack's id (addGridWidget)
        addObjectTrackerWidget(name, id, 'Object tracking', panelGridOptions(saved, viewMode));
        if (typeof widgetsPlacedFromSave !== 'undefined')
          widgetsPlacedFromSave.delete(id.replace('_grid', ''));
      }
    };
    addStateListener(`${name}_tracking`, create);
    sendWebsocket({'get_state_dict': `${name}_tracking`});
    setTimeout(() => create(undefined), 1500);     // nothing saved: the server sends no reply
  }
  else if (!objectTrackerShown[name] && el) {
    const item = el.closest('.grid-stack-item');
    if (item) grid.removeWidget(item);
  }
}

function renderPanelToggle(name) {
  // the "show panel" box in Tools_Hub's settings dialog (grid.js addHubDialog), added once
  const list = document.getElementById(`${name}_config_dialog_list`);
  if (!list) return;
  const boxId = `${name}_config_dialog_panel_tracking`;
  let box = document.getElementById(boxId);
  if (!box) {
    const wrap = document.createElement('div');
    wrap.className = 'form-check mt-3 pt-2 border-top';
    wrap.innerHTML = `<input type="checkbox" class="form-check-input" id="${boxId}">
      <label class="form-check-label" for="${boxId}"><strong>Show the object tracking panel</strong></label>`;
    list.parentNode.appendChild(wrap);
    box = document.getElementById(boxId);
    box.addEventListener('change', () =>
      sendWebsocket({[name]: {set_panel: {panel: 'tracking', show: box.checked}}}));
  }
  box.checked = !!objectTrackerShown[name];
}

function addObjectTrackerWidget(name, id, title, grid_options) {
  const html = `
    <div class="track-panel" id="${id}_panel">
      <div class="track-head"><span id="${id}_status">Model: loading</span></div>
      <table class="table table-sm track-table">
        <thead><tr><th>Camera</th><th>Tracking</th><th>Classes (English, comma-separated)</th><th>Detection</th><th>Detected now</th></tr></thead>
        <tbody id="${id}_rows"></tbody></table>
      <div class="track-foot" id="${id}_change"></div>
    </div>`;
  const widget = addGridWidget(id, title, html, null, Object.assign({w: 8, h: 4}, grid_options));
  const panel = document.getElementById(`${id}_panel`);
  for (const ev of ['mousedown', 'pointerdown'])
    panel.addEventListener(ev, e => { if (e.target.closest('input,button')) e.stopPropagation(); });
  panel.addEventListener('click', e => {
    const b = e.target.closest('button[data-source]');
    if (!b) return;
    const input = panel.querySelector(`input[data-source="${CSS.escape(b.dataset.source)}"]`);
    sendWebsocket(panelMessage(name, 'set_tracking', {source: b.dataset.source, objects: input ? input.value : '',
                                                      enabled: b.dataset.on !== '1'}));
  });
  panel.addEventListener('change', e => {
    const input = e.target.closest('input[data-source]');
    if (!input) return;
    const row = trackerRows(objectTrackerStates[name]).find(r => r.source === input.dataset.source);
    sendWebsocket(panelMessage(name, 'set_tracking', {source: input.dataset.source, objects: input.value,
                                                      enabled: !!(row && row.enabled)}));
  });
  renderObjectTracker(name);
  return widget;
}

function renderObjectTracker(name) {
  const id = trackingPanelId(name);
  const body = document.getElementById(`${id}_rows`);
  if (!body) return;
  const state = objectTrackerStates[name] || {};
  document.getElementById(`${id}_status`).textContent = statusText(state);
  document.getElementById(`${id}_change`).textContent = changeText(state);
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.source : null;
  const rows = trackerRows(state);
  const live = new Set(rows.map(r => r.source));
  for (const tr of Array.from(body.querySelectorAll('tr[data-source]')))
    if (!live.has(tr.dataset.source)) tr.remove();      // a camera that left the preset
  for (const r of rows) {
    let tr = body.querySelector(`tr[data-source="${CSS.escape(r.source)}"]`);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.source = r.source;
      tr.innerHTML = `<td class="track-src"></td><td><button type="button" class="btn btn-sm" data-source=""></button></td>
        <td><input type="text" class="form-control form-control-sm" data-source="" placeholder="red cup, person"></td>
        <td class="track-fps"></td><td class="track-count"></td>`;
      tr.querySelector('button').dataset.source = r.source;
      tr.querySelector('input').dataset.source = r.source;
      body.appendChild(tr);
    }
    tr.querySelector('.track-src').textContent = r.source + (r.depth ? ' 📏' : '') +
      (r.examples ? ` · boxed: ${r.examples}` : '') + (r.note ? ` ⚠ ${r.note}` : '');
    const b = tr.querySelector('button');
    b.textContent = r.enabled ? 'On' : 'Off';
    b.dataset.on = r.enabled ? '1' : '0';
    b.className = 'btn btn-sm ' + (r.enabled ? 'btn-success' : 'btn-outline-secondary');
    if (focused !== r.source) tr.querySelector('input').value = r.objects;   // don't clobber typing
    tr.querySelector('.track-fps').textContent = r.fps;
    tr.querySelector('.track-count').textContent = r.count;
  }
}
