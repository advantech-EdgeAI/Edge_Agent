// PerformanceMonitor widget (docs/superpowers/specs/2026-10-01-performance-dashboard-design.md).
// Pure formatting functions (tested with node) + the DOM wiring grid.js calls.
const DASH = '—';

function _num(v, digits) { return (typeof v === 'number' && isFinite(v)) ? v.toFixed(digits) : null; }

function compactView(state, secUnit = 's') {
  const s = state || {};
  const turns = s.turns || [];
  const last = turns.length ? turns[turns.length - 1] : {};
  const sys = s.system || {};
  const r = _num(last.response_s, 1), sp = _num(last.tok_s, 0);
  const g = _num(sys.gpu, 0), p = _num(sys.power_w && sys.power_w.total, 0);
  return {model: s.model || DASH, response: r ? `${r} ${secUnit}` : DASH, speed: sp ? `${sp} tok/s` : DASH,
          gpu: g !== null ? `${g} %` : DASH, power: p !== null ? `${p} W` : DASH};
}

function turnRows(state, n) {
  const turns = ((state || {}).turns || []).slice(-n).reverse();
  const cell = (v, d) => _num(v, d) ?? DASH;
  return turns.map(t => {
    const rounds = t.rounds || [];
    const prompt = rounds.reduce((a, r) => a + (r.prompt_tok || 0), 0);
    const out = rounds.reduce((a, r) => a + (r.out_tok || 0), 0);
    const tools = rounds.flatMap(r => (r.tools || []).map(x => x.name));
    return [(t.start || '').slice(11, 19), t.input || '', cell(t.asr_s, 1), cell(t.ttft_s, 1),
            rounds.length ? `${prompt}/${out}` : DASH, cell(t.prefill_tok_s, 0), cell(t.tok_s, 1),
            tools.length ? tools.join(' ') : DASH,
            cell(t.tts_first_audio_s, 1), cell(t.response_s, 1), cell(t.total_s, 1)];
  });
}

function sparkPoints(values, width, height) {
  const vals = values || [];
  const finite = vals.filter(v => typeof v === 'number' && isFinite(v));
  if (!finite.length) return '';
  const max = Math.max(...finite, 1e-9), step = vals.length > 1 ? width / (vals.length - 1) : 0;
  const pts = [];
  vals.forEach((v, i) => {
    if (typeof v === 'number' && isFinite(v))
      pts.push(`${Math.round(i * step)},${Math.round(height - (v / max) * height)}`);
  });
  return pts.join(' ');
}

if (typeof module !== 'undefined') module.exports = {compactView, turnRows, sparkPoints, mergeState};

// ---- browser side -----------------------------------------------------------------------------
var perfMonitorStates = {};   // plugin name -> last snapshot
var perfMonitorTabs = {};     // plugin name -> 'compact' | 'detail'

// between turns the node sends only {delta, system, history_tail}; merge it into the last full
// snapshot (history keeps the collector's 600 s window)
function mergeState(prev, state) {
  if (!state || !state.delta) return state;
  const s = prev || {};
  s.system = state.system;
  const hist = s.history || (s.history = []);
  const tail = state.history_tail;
  if (tail && (!hist.length || tail[0] > hist[hist.length - 1][0])) {
    hist.push(tail);
    while (hist.length && tail[0] - hist[0][0] > 600) hist.shift();
  }
  return s;
}

function addPerformanceMonitorHooks(name) {
  if( !(name in outputListeners && 0 in outputListeners[name]) )
    addOutputListener(name, 0, function(state) {
      perfMonitorStates[name] = mergeState(perfMonitorStates[name], state);
      renderPerformanceMonitor(name);
    });
}

function addPerformanceMonitorWidget(name, id, title, grid_options) {
  const head = ['Time', 'Question', 'ASR', 'First token', 'prompt/output', 'prefill tok/s', 'decode tok/s (1/TPOT)',
                'Tools', 'TTS', 'Response', 'Total'];
  const html = `
    <div class="perf-monitor">
      <div class="perf-tabs">
        <button type="button" class="btn btn-sm btn-primary" id="${id}_tab_compact">Summary</button>
        <button type="button" class="btn btn-sm btn-outline-primary" id="${id}_tab_detail">Details</button>
      </div>
      <div id="${id}_compact" class="perf-compact">
        <div class="perf-head"><span id="${id}_model" class="perf-model">—</span>
          <span class="perf-badge">🔒 100% on-device · no cloud</span></div>
        <div class="perf-cards">
          <div class="perf-card"><div class="perf-label">Response time</div><div class="perf-value" id="${id}_response">—</div></div>
          <div class="perf-card"><div class="perf-label">Generation speed</div><div class="perf-value" id="${id}_speed">—</div></div>
          <div class="perf-card"><div class="perf-label">GPU</div><div class="perf-value" id="${id}_gpu">—</div></div>
          <div class="perf-card"><div class="perf-label">Module power</div><div class="perf-value" id="${id}_power">—</div></div>
        </div>
      </div>
      <div id="${id}_detail" class="perf-detail" style="display:none">
        <div class="perf-sparks">
          <div><div class="perf-label">GPU %</div><svg viewBox="0 0 300 60" preserveAspectRatio="none"><polyline id="${id}_spark_gpu"/></svg></div>
          <div><div class="perf-label">Power W</div><svg viewBox="0 0 300 60" preserveAspectRatio="none"><polyline id="${id}_spark_power"/></svg></div>
          <div><div class="perf-label">Memory GB</div><svg viewBox="0 0 300 60" preserveAspectRatio="none"><polyline id="${id}_spark_mem"/></svg></div>
        </div>
        <table class="table table-sm perf-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
          <tbody id="${id}_rows"></tbody></table>
      </div>
    </div>`;
  const widget = addGridWidget(id, title, html, null, Object.assign({w: 8, h: 6}, grid_options));
  for (const tab of ['compact', 'detail']) {
    const b = document.getElementById(`${id}_tab_${tab}`);
    b.addEventListener('click', () => { perfMonitorTabs[name] = tab; renderPerformanceMonitor(name); });
    b.addEventListener('mousedown', e => e.stopPropagation());
    b.addEventListener('pointerdown', e => e.stopPropagation());
  }
  renderPerformanceMonitor(name);
  return widget;
}

// The four headline numbers in any container (the kiosk brain screen, spec 2026-10-20-kiosk-display
// §4.2); fed by the same output-0 listener as the Studio widget.
const perfMonitorMounts = {};   // name -> [element]

function mountPerformanceMonitor(name, container) {
  container.innerHTML = `
    <div class="perf-cards perf-kiosk">
      <div class="perf-card"><div class="perf-label">Response time</div><div class="perf-value" data-k="response">—</div></div>
      <div class="perf-card"><div class="perf-label">Generation speed</div><div class="perf-value" data-k="speed">—</div></div>
      <div class="perf-card"><div class="perf-label">GPU</div><div class="perf-value" data-k="gpu">—</div></div>
      <div class="perf-card"><div class="perf-label">Module power</div><div class="perf-value" data-k="power">—</div></div>
    </div>`;
  (perfMonitorMounts[name] = perfMonitorMounts[name] || []).push(container);
  addPerformanceMonitorHooks(name);
  renderPerformanceMonitor(name);
  return container;
}

function renderPerfMounts(name) {
  const mounts = (perfMonitorMounts[name] || []).filter(el => document.body.contains(el));
  perfMonitorMounts[name] = mounts;
  if (!mounts.length) return;
  const v = compactView(perfMonitorStates[name] || {});
  for (const el of mounts)
    for (const cell of el.querySelectorAll('[data-k]')) cell.textContent = v[cell.dataset.k];
}

function renderPerformanceMonitor(name) {
  renderPerfMounts(name);
  const id = `${name}_grid`;
  if (!document.getElementById(`${id}_compact`)) return;
  const state = perfMonitorStates[name] || {};
  const tab = perfMonitorTabs[name] || 'compact';
  document.getElementById(`${id}_compact`).style.display = tab === 'compact' ? '' : 'none';
  document.getElementById(`${id}_detail`).style.display = tab === 'detail' ? '' : 'none';
  document.getElementById(`${id}_tab_compact`).className = `btn btn-sm ${tab === 'compact' ? 'btn-primary' : 'btn-outline-primary'}`;
  document.getElementById(`${id}_tab_detail`).className = `btn btn-sm ${tab === 'detail' ? 'btn-primary' : 'btn-outline-primary'}`;
  const v = compactView(state);
  for (const k of ['model', 'response', 'speed', 'gpu', 'power'])
    document.getElementById(`${id}_${k}`).textContent = v[k];
  if (tab !== 'detail') return;
  const hist = state.history || [];
  document.getElementById(`${id}_spark_gpu`).setAttribute('points', sparkPoints(hist.map(p => p[1]), 300, 60));
  document.getElementById(`${id}_spark_power`).setAttribute('points', sparkPoints(hist.map(p => p[2]), 300, 60));
  document.getElementById(`${id}_spark_mem`).setAttribute('points', sparkPoints(hist.map(p => p[3]), 300, 60));
  document.getElementById(`${id}_rows`).innerHTML = turnRows(state, 50)
    .map(r => `<tr>${r.map(c => `<td>${escapeHTML(String(c))}</td>`).join('')}</tr>`).join('');
}
