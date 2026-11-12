// Pure logic of the kiosk pages (docs/superpowers/specs/2026-10-20-kiosk-display-design.md); the DOM
// lives in kiosk.js. Tested with node (tests/js/kiosk_logic.test.js).
const SENSOR_PIPELINE_TYPES = ['VideoOutput', 'WebVideoIn', 'Image_Input',
                               'VideoSource', 'WebAudioIn'];   // input devices too (seen on the real preset)
const BRIDGE_TYPES = ['FrameCache'];

function partitionNodes(plugins) {
  const main = [], sensor = [];
  for (const p of plugins) {
    if (BRIDGE_TYPES.includes(p.type)) { main.push(p.name); sensor.push(p.name); }
    else if (SENSOR_PIPELINE_TYPES.includes(p.type)) sensor.push(p.name);
    else main.push(p.name);
  }
  return {main, sensor};
}

// allNodes: every node of the preset - a connection to anything else (WebClient, the subscription
// endpoint Studio adds when a browser listens) is neither drawn nor a stub
function edgesForTab(connections, tabNodes, allNodes) {
  const inTab = new Set(tabNodes), known = allNodes ? new Set(allNodes) : null, inside = [], stubs = [];
  for (const c of connections) {
    if (known && !(known.has(c.from) && known.has(c.to))) continue;
    const a = inTab.has(c.from), b = inTab.has(c.to);
    if (a && b) inside.push(c);
    else if (a) stubs.push({node: c.from, other: c.to, dir: 'out'});
    else if (b) stubs.push({node: c.to, other: c.from, dir: 'in'});
  }
  return {inside, stubs};
}

function resolveSlots(layout, pluginNames) {
  const have = new Set(pluginNames);
  return (layout.slots || []).map(s => Object.assign({}, s, {missing: !have.has(s.node)}));
}

function edgeKey(from, output, to) { return `${from}|${output}|${to}`; }

function activityLevels(ticks, now, fadeMs = 1000) {
  const out = {};
  for (const tick of ticks) {
    const fade = 1 - (now - tick.t) / fadeMs;
    if (fade <= 0) continue;
    for (const [from, output, to, n] of tick.counts) {
      const k = edgeKey(from, output, to);
      out[k] = Math.max(out[k] || 0, Math.min(1, Math.log10(1 + n) / 2) * fade);
    }
  }
  return out;
}

class IdleTimer {
  constructor(ms) { this.ms = ms; this.last = 0; this.fired = false; }
  poke(now) { this.last = now; this.fired = false; }
  check(now) {
    if (this.fired || now - this.last < this.ms) return false;
    this.fired = true;
    return true;
  }
}

// What a node does, from its type - its colour on the brain screen (2026-10-20: dark nodes on the
// dark background did not read as a pipeline from afar). Unknown types are 'other'.
const NODE_CATEGORIES = {
  cache: ['FrameCache', 'DepthCache'],
  voice: ['VADFilter', 'WhisperASR', 'WakeWord', 'WakeWordFeedback', 'KokoroTTS', 'PiperTTS', 'WebAudioIn', 'WebAudioOut', 'RateLimit'],
  ai: ['AgentLoop', 'vLLM'],
  tools: ['Tools_Hub', 'Skills_Hub', 'SafetyReview'],
};

function nodeCategory(type) {
  for (const [cat, types] of Object.entries(NODE_CATEGORIES)) if (types.includes(type)) return cat;
  return 'other';
}

// plugin_added also carries {name, global: true} entries (GraphEditor, TerminalPlugin, panels): not nodes
function pipelinePlugins(plugins) {
  return plugins.filter(p => p && p.type && !p.global);
}

// The plugins of one tab, laid out by the kiosk's own saved layout (spec §7): its positions override
// layout_node, its hidden nodes are left out; nodes it never placed keep their Studio position.
function tabPlugins(plugins, names, saved) {
  const pos = (saved && saved.positions) || {}, hidden = new Set((saved && saved.hidden) || []);
  return plugins.filter(p => names.includes(p.name) && !hidden.has(p.name))
                .map(p => (p.name in pos) ? Object.assign({}, p, {layout_node: {x: pos[p.name].x, y: pos[p.name].y}}) : p);
}

// a resent init (every new websocket client triggers one) vs another preset
function hasNewNodes(known, incoming) {
  const have = new Set(known.map(p => p.name));
  return incoming.some(p => !have.has(p.name));
}

// ---- 2026-10-21 polish --------------------------------------------------------------------------

// Ends of a temporary dashed link between two node boxes ({x, y, w, h}): the sides that face each
// other. The cache used to be joined from its right edge, so a cache placed right of Tools_Hub got
// a line cutting through both nodes (2026-10-21).
function linkEnds(a, b) {
  const aLeft = a.x + a.w / 2 <= b.x + b.w / 2;
  return {x0: aLeft ? a.x + a.w : a.x, y0: a.y + a.h / 2, x1: aLeft ? b.x : b.x + b.w, y1: b.y + b.h / 2};
}

// The tracked boxes per camera ({camera: {t, tracks}}) as one row per kind of object - what a visitor
// reads ("person ×3, nearest 1.2 m") instead of one row per box with a track number.
function groupTracks(byCamera, now, maxAgeMs) {
  const rows = new Map();
  for (const [camera, entry] of Object.entries(byCamera || {})) {
    if (!entry || now - entry.t >= maxAgeMs) continue;
    for (const t of entry.tracks || []) {
      const row = rows.get(t.label) || {label: t.label, count: 0, nearest: null, cameras: []};
      row.count += 1;
      if (typeof t.distance === 'number' && (row.nearest === null || t.distance < row.nearest)) row.nearest = t.distance;
      if (!row.cameras.includes(camera)) row.cameras.push(camera);
      rows.set(t.label, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.count - a.count);   // stable: ties keep first-seen order
}

// What the tracker was asked to find (its panel state): names and boxed examples, per camera that is on.
function trackingTargets(state) {
  return ((state && state.cameras) || []).filter(c => c.enabled).map(c => ({
    source: c.source, targets: [...new Set([...(c.objects || []), ...(c.examples || [])])], fps: c.fps}));
}

// One metrics turn as time segments in order: listening, each model round (first token + decode)
// followed by its tools, then speech.
function turnSegments(turn, lang) {
  if (!turn) return [];
  const T = kioskText(lang), r2 = v => Math.round(v * 100) / 100, out = [];
  if (turn.asr_s > 0) out.push({kind: 'asr', label: T.segAsr, seconds: r2(turn.asr_s)});
  for (const r of turn.rounds || []) {
    const s = (r.ttft_s || 0) + (r.decode_s || 0);
    if (s > 0) out.push({kind: 'model', label: T.segModel, seconds: r2(s)});
    for (const t of r.tools || []) out.push({kind: 'tool', label: t.name, seconds: r2(t.seconds || 0)});
  }
  if (turn.tts_first_audio_s > 0) out.push({kind: 'tts', label: T.segTts, seconds: r2(turn.tts_first_audio_s)});
  return out;
}

// The camera a tool call used: its source argument, else the first camera cache named in its
// result (a tool picks the default camera itself when source is left out).
function cameraOfTool(args, resultText, caches) {
  if (args && caches.includes(args.source)) return args.source;
  for (const name of caches) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`);
    if (re.test(resultText || '')) return name;
  }
  return null;
}

// The banner's wake-word hint for a WakeWord state (its output 3): quiet while asleep, lit with what
// it is doing during a voice conversation (2026-10-21).
function wakeHint(state, lang) {
  const T = kioskText(lang), s = state && state.state;
  if (!s || s === 'sleeping') return {on: false, text: T.wakeIdle};
  return {on: true, text: T.wake[s] || T.wake.other};
}

// Whether this screen plays the spoken answers (WebAudioOut): the brain screen does, the camera screen
// does not - two screens playing would echo. ?audio=0 / ?audio=1 overrides (2026-10-21).
function kioskPlaysAudio(screen, search) {
  const audio = new URLSearchParams(search || '').get('audio');
  if (audio === '0' || audio === '1') return audio === '1';
  return screen === 'brain' || screen === 'auto';   // auto: the only screen (spec 2026-11-06)
}

// Edit mode's ctrl+wheel zoom (2026-10-21): scale the canvas {x, y, z} by `factor` round the pointer
// (mx, my) - the canvas point under it stays under it - clamped to [zmin, zmax].
function zoomAt(view, mx, my, factor, zmin, zmax) {
  const z = Math.min(zmax, Math.max(zmin, view.z * factor)), f = z / view.z;
  return {x: mx - (mx - view.x) * f, y: my - (my - view.y) * f, z};
}

// The tracking list's page at time `nowMs` when only `perPage` rows fit: pages turn every
// `periodMs` and wrap round (2026-10-21: instead of 「還有 N 種物件」 hiding them for good).
function trackPage(rows, perPage, nowMs, periodMs) {
  const per = Math.max(1, perPage), pages = Math.max(1, Math.ceil(rows.length / per));
  const page = pages === 1 ? 1 : Math.floor(nowMs / periodMs) % pages + 1;
  return {rows: rows.slice((page - 1) * per, page * per), page, pages};
}

// The camera screen's slots that show what a camera cache holds, found by wiring - a slot whose node
// is fed by the plugin that feeds the cache (no names in code); of those, the ones marked "track"
// (a camera's main view) when there are any, so reading camera_zed lights the colour view, not the
// depth view (2026-10-22: the two screens link what the AI looked at).
function slotsForCache(cache, connections, slots) {
  const sources = new Set(connections.filter(c => c.to === cache).map(c => c.from));
  const fed = slots.filter(s => !s.missing && connections.some(c => c.to === s.node && sources.has(c.from)));
  const main = fed.filter(s => s.track);
  return (main.length ? main : fed).map(s => s.slot);
}

// The chat's listening bubble (2026-10-21): up while the wake word listens (greeting, listening),
// with Whisper's partial transcript as it grows; gone once the question is asked (thinking).
function listenBubble(wakeState, partial) {
  const s = wakeState && wakeState.state;
  return (s === 'greeting' || s === 'listening') ? {show: true, text: partial || ''} : {show: false, text: ''};
}

// The banner pill's five level bars: 4 dB a bar above the recent noise floor, whatever the gain.
function levelBars(levelDb, floorDb) {
  if (levelDb == null || floorDb == null) return 0;
  return Math.max(0, Math.min(5, Math.floor((levelDb - floorDb) / 4)));
}

function noiseFloor(levels) {
  return levels.length ? Math.min(...levels) : null;
}

// The kiosk's fixed words, by language (?lang=en, the L key; 2026-10-21). Visitor-facing only: the
// edit mode stays in Chinese, and the AI answers in whatever language it was asked.
const KIOSK_TEXT = {
  zh: {bootTitle: '系統啟動中', bootRestart: '系統重新啟動中', bootHint: '大型模型第一次載入約需 2–3 分鐘',
       stepConnect: '連線到 Studio', stepPipeline: '載入 pipeline', stepModel: '載入 AI 模型',
       waitPreset: '等待載入 preset', nodes: n => `${n} 個節點`, queued: '排隊中，等前一個模型載完',
       failed: '載入失敗，系統會自動重試', waited: t => `已等待 ${t}`, minSec: (m, s) => m ? `${m} 分 ${s} 秒` : `${s} 秒`,
       wakeIdle: '說「嘿，小研」開始對話',
       wake: {greeting: '你好！', listening: '聆聽中…', thinking: '思考中…', speaking: '回答中…', other: '對話中…'},
       listening: '聆聽中…',
       segAsr: '聽寫', segModel: '模型', segTts: '語音', secUnit: '秒',
       missing: '未接上', tabMain: '主 pipeline', tabSensor: '感測器 pipeline',
       generating: '生成中', running: t => `執行中：${t}`, reading: '讀取中',
       perf: '效能', response: '回應時間', speed: '生成速度', gpu: 'GPU', power: '模組功耗',
       turnTitle: '上一題花在哪裡', noTurn: '還沒有問答', prefill: v => `讀 prompt ${v} tok/s`,
       cacheHit: p => `快取命中 ${p}%`, memory: g => `記憶體 ${g} GB`,
       tracking: '物件追蹤', lookingFor: '正在找：', notSeen: '還沒看到：', nearest: '最近 ', listSep: '、',
       noTracks: '目前沒有追蹤中的物件', page: (p, n, total) => `第 ${p}／${n} 頁 · 共 ${total} 種物件`,
       chat: '對話', placeholder: '輸入問題，或說「嘿，小研」', send: '送出 ➤', jumpLatest: '↓ 最新',
       seen: 'AI 剛看到的畫面', seenEmpty: 'AI 還沒看過畫面', justNow: '剛剛', secAgo: s => `${s} 秒前`, minAgo: m => `${m} 分鐘前`,
       audioHint: '🔊 點一下畫面開啟聲音', aiLooking: 'AI 正在看',
       sensorWaiting: '等待訊號', sensorLost: '訊號中斷',
       status: {},   // a node's own status text shown as it is (the booth branch names its sensors' here)
       thinking: '思考中...', thought: s => `思考了 ${s} 秒`, toolRunning: '執行中...', toolDone: '✓ 完成', toolError: '✗ 失敗',
       toolDenied: '已拒絕', toolTimeout: '已逾時', toolArgs: '參數', prepareTool: '準備呼叫工具', phaseThinking: '思考中',
       phaseAnswering: '產生回答', phaseRun: n => `執行 ${n}`, phaseConfirm: '等待確認', phaseTool: '執行工具', allowConversation: '本次對話都允許',
       compacting: '正在整理歷史對話...', chatError: '發生錯誤', eventWaitingModel: '等待摘要模型載入…', eventSummarizing: '摘要產生中…',
       // the single-screen page (2026-11-04): typed only, four numbers in the banner, a tag on the camera
       placeholderTyped: '輸入問題…', speedShort: '生成', ttft: '首字', powerShort: '功耗',
       trackTag: {tracking: '追蹤：', lookingFor: '正在找：', sep: '　'}, tryAsking: '試試問我：',
       // the auto page (2026-11-06)
       cardVlm: 'AI 判斷', cardAlert: '警報', cardRag: 'RAG 參考比對', ragNow: '目前畫面', ragRef: '最像的參考圖',
       ragNone: '沒有夠像的參考圖', ragSim: (s, t) => `相似度 ${s} ／ 門檻 ${t}`, alertNormal: '目前正常',
       alertCount: n => `本次 ${n} 次`, moreCards: n => `還有 ${n} 個節點沒有卡片`, backToStudio: '回到 Studio', kioskButton: '展示模式',
       ragTagPlaceholder: '輸入標籤，把目前畫面加進資料庫', ragAdd: '加入', ragAdded: t => `已加入：${t}`,
       cardDetect: '物件偵測', cardEvent: '事件紀錄', cardLabel: '自動標註', cardGenerate: '影片生成',
       noEvents: '還沒有事件', noDetections: '畫面中沒有偵測到物件', labelFrames: n => `本次 ${n} 張`,
       labelPacked: n => `已打包 ${n} 張`, generatePlaceholder: '描述想生成的影片…', generateSend: '生成',
       labelPick: '選擇資料夾', labelStart: '開始標註', labelUploading: n => `上傳中：${n} 個檔案…`,
       labelUploaded: n => `已上傳 ${n} 張，可以開始`, labelRunning: '標註中…', labelDownload: '下載',
       labelUploadFailed: '上傳失敗', generateImagePick: '選擇起始圖片', generateImageClear: '清除圖片',
       generateModeVideo: '圖片＋描述 → 生成影片（約 2–3 分鐘）', generateModeImage: '只有描述 → 生成一張圖片',
       labelCollect: '開始收集', labelStopPack: '停止並打包', labelCollecting: '收集中…', labelPacking: '打包中…',
       micOn: '開啟麥克風', micOff: '關閉麥克風', micDenied: '麥克風無法使用'},
  en: {bootTitle: 'Starting up', bootRestart: 'Restarting', bootHint: 'A large model takes 2–3 minutes to load the first time',
       stepConnect: 'Connect to Studio', stepPipeline: 'Load the pipeline', stepModel: 'Load the AI model',
       waitPreset: 'waiting for a preset', nodes: n => `${n} nodes`, queued: 'queued behind another model',
       failed: 'failed to load, retrying automatically', waited: t => `waiting ${t}`, minSec: (m, s) => m ? `${m} min ${s} s` : `${s} s`,
       wakeIdle: 'Say "Hey, Xiao Yan" to start',
       wake: {greeting: 'Hello!', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Answering…', other: 'In conversation…'},
       listening: 'Listening…',
       segAsr: 'Speech', segModel: 'Model', segTts: 'Voice', secUnit: 's',
       missing: 'Not connected', tabMain: 'Main pipeline', tabSensor: 'Sensor pipeline',
       generating: 'Generating', running: t => `Running: ${t}`, reading: 'Reading',
       perf: 'Performance', response: 'Response time', speed: 'Generation speed', gpu: 'GPU', power: 'Module power',
       turnTitle: "Where the last answer's time went", noTurn: 'No questions yet', prefill: v => `prompt read ${v} tok/s`,
       cacheHit: p => `cache hit ${p}%`, memory: g => `memory ${g} GB`,
       tracking: 'Object tracking', lookingFor: 'Looking for: ', notSeen: 'Not seen yet: ', nearest: 'nearest ', listSep: ', ',
       noTracks: 'Nothing is being tracked', page: (p, n, total) => `Page ${p}/${n} · ${total} kinds of objects`,
       chat: 'Conversation', placeholder: 'Type a question, or say "Hey, Xiao Yan"', send: 'Send ➤', jumpLatest: '↓ Latest',
       seen: 'What the AI just saw', seenEmpty: 'The AI has not looked yet', justNow: 'just now', secAgo: s => `${s} s ago`, minAgo: m => `${m} min ago`,
       audioHint: '🔊 Click anywhere to turn the sound on', aiLooking: 'AI is looking',
       sensorWaiting: 'Waiting for signal', sensorLost: 'Signal lost',
       status: {},
       thinking: 'Thinking...', thought: s => `Thought for ${s} s`, toolRunning: 'Running...', toolDone: '✓ Done', toolError: '✗ Failed',
       toolDenied: 'Denied', toolTimeout: 'Timed out', toolArgs: 'Arguments', prepareTool: 'Preparing a tool call', phaseThinking: 'Thinking',
       phaseAnswering: 'Writing the answer', phaseRun: n => `Running ${n}`, phaseConfirm: 'Waiting for confirmation', phaseTool: 'Running the tool', allowConversation: 'Allow for this conversation',
       compacting: 'Tidying up the conversation history...', chatError: 'Something went wrong', eventWaitingModel: 'Waiting for the summary model…', eventSummarizing: 'Writing the summary…',
       placeholderTyped: 'Type a question…', speedShort: 'Speed', ttft: 'First token', powerShort: 'Power',
       trackTag: {tracking: 'Tracking: ', lookingFor: 'Looking for: ', sep: '   '}, tryAsking: 'Try asking: ',
       cardVlm: 'AI verdict', cardAlert: 'Alert', cardRag: 'RAG reference match', ragNow: 'Now', ragRef: 'Closest reference',
       ragNone: 'No close reference', ragSim: (s, t) => `Similarity ${s} / threshold ${t}`, alertNormal: 'All clear',
       alertCount: n => `${n} this session`, moreCards: n => `${n} more nodes without a card`, backToStudio: 'Back to Studio', kioskButton: 'Display mode',
       ragTagPlaceholder: 'Type a tag to add the current frame', ragAdd: 'Add', ragAdded: t => `Added: ${t}`,
       cardDetect: 'Object detection', cardEvent: 'Event log', cardLabel: 'Auto-labeling', cardGenerate: 'Video generation',
       noEvents: 'No events yet', noDetections: 'Nothing detected in view', labelFrames: n => `${n} frames this session`,
       labelPacked: n => `Packaged ${n} images`, generatePlaceholder: 'Describe the video to generate…', generateSend: 'Generate',
       labelPick: 'Choose folder', labelStart: 'Start labeling', labelUploading: n => `Uploading ${n} file(s)…`,
       labelUploaded: n => `${n} image(s) uploaded, ready`, labelRunning: 'Labeling…', labelDownload: 'Download',
       labelUploadFailed: 'Upload failed', generateImagePick: 'Choose start image', generateImageClear: 'Clear image',
       generateModeVideo: 'Image + prompt → video (about 2–3 min)', generateModeImage: 'Prompt only → one image',
       labelCollect: 'Start collecting', labelStopPack: 'Stop and package', labelCollecting: 'Collecting…', labelPacking: 'Packaging…',
       micOn: 'Turn mic on', micOff: 'Turn mic off', micDenied: 'Microphone unavailable'},
};

function kioskText(lang) {
  return KIOSK_TEXT[lang] || KIOSK_TEXT.zh;
}

// The startup screen (2026-10-21): connected to Studio, the pipeline's nodes arrived, every model
// GET /api/startup lists has loaded. state = {connected, restarting, nodes, preset, startup}.
function bootView(state, lang) {
  const T = kioskText(lang), st = state.startup;
  const step = (label, status, detail = '') => ({label, status, detail});
  const pipelineDone = state.connected && state.nodes > 0;
  const connect = step(T.stepConnect, state.connected ? 'done' : 'active');
  const pipeline = !state.connected ? step(T.stepPipeline, 'todo')
    : pipelineDone ? step(T.stepPipeline, 'done', [state.preset, T.nodes(state.nodes)].filter(Boolean).join(' · '))
    : step(T.stepPipeline, 'active', T.waitPreset);
  let model = step(T.stepModel, 'todo');
  if (pipelineDone && st) {
    const slow = (st.loading || [])[0];
    if (st.ready) model = step(T.stepModel, 'done');
    else if (slow && slow.phase === 'failed') model = step(T.stepModel, 'failed', `${slow.what} · ${T.failed}`);
    else if (slow && slow.phase === 'waiting') model = step(T.stepModel, 'active', `${slow.what} · ${T.queued}`);
    else if (slow) {
      const sec = Math.max(0, Math.floor(slow.seconds || 0));
      model = step(T.stepModel, 'active', `${slow.what} · ${T.waited(T.minSec(Math.floor(sec / 60), sec % 60))}`);
    }
  }
  return {ready: pipelineDone && !!st && !!st.ready, title: state.restarting ? T.bootRestart : T.bootTitle,
          hint: T.bootHint, steps: [connect, pipeline, model]};
}

// ---- the single-screen page (docs/superpowers/specs/2026-11-04-orin-single-screen-kiosk-design.md) ----

// One pipeline picture with every node (the user, 2026-11-04): partitionNodes() would put the camera's
// always-moving VideoSource -> VideoOutput / FrameCache links on a second tab.
function singleNodes(plugins) {
  return [...new Set((plugins || []).map(p => p.name))];
}

// The small tag on the camera: what is tracked ("person ×2") and what is asked for but not seen yet.
function trackingTag(state, byCamera, now, maxAgeMs, lang) {
  const T = kioskText(lang), tt = T.trackTag;
  const rows = groupTracks(byCamera, now, maxAgeMs), seen = new Set(rows.map(r => r.label));
  const wanted = [...new Set(trackingTargets(state).flatMap(t => t.targets))].filter(x => !seen.has(x));
  const parts = [];
  if (rows.length) parts.push(tt.tracking + rows.map(r => `${r.label} ×${r.count}`).join(T.listSep));
  if (wanted.length) parts.push(tt.lookingFor + wanted.join(T.listSep));
  return {show: parts.length > 0, text: parts.join(tt.sep)};
}

// The banner's four numbers, from a PerformanceMonitor state (perf_monitor.js keeps compactView() for
// the other pages; it has no time to first token).
function bannerKpis(perfState, lang) {
  const T = kioskText(lang), s = perfState || {}, turns = s.turns || [];
  const last = turns.length ? turns[turns.length - 1] : {}, sys = s.system || {};
  const fmt = (v, digits, unit) => (typeof v === 'number' && isFinite(v)) ? `${v.toFixed(digits)} ${unit}` : '—';
  return [{key: 'speed', label: T.speedShort, value: fmt(last.tok_s, 1, 'tok/s')},
          {key: 'ttft', label: T.ttft, value: fmt(last.ttft_s, 1, T.secUnit)},
          {key: 'gpu', label: T.gpu, value: fmt(sys.gpu, 0, '%')},
          {key: 'power', label: T.powerShort, value: fmt(sys.power_w && sys.power_w.total, 0, 'W')}];
}

// One page's edited tab laid over the preset's saved kiosk layout: the brain screen's main / sensor
// and the single page's own tab share one file, and saving one page must not drop the other's.
// Wire bend points (2026-11-06): drawn in the kiosk's edit mode, saved per wire as canvas coordinates.
// The key names both ends with their ports, so two wires between the same nodes stay apart.
const MAX_ROUTE_POINTS = 20;
function routeKey(c) { return `${c.from}:${c.output}>${c.to}:${c.input}`; }

// only wires that are on the tab, each point [x, y] rounded, empty routes dropped
function cleanRoutes(routes, keys) {
  const out = {};
  if (!routes || typeof routes !== 'object') return out;
  for (const k of keys) {
    if (!Array.isArray(routes[k])) continue;
    const pts = routes[k].filter(p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && isFinite(v)))
                         .slice(0, MAX_ROUTE_POINTS).map(p => [Math.round(p[0]), Math.round(p[1])]);
    if (pts.length) out[k] = pts;
  }
  return out;
}

// One curve from the output through every bend point to the input (Catmull-Rom as cubic Beziers): it
// leaves the output and enters the input level, like an unbent wire, and does not kink at a point.
// No points: null, Drawflow's own curve stays.
function smoothRoutePath(start, points, end) {
  if (!points || !points.length) return null;
  const P = [start, ...points, end], n = P.length - 1;
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const T = P.map((p, i) => i === 0 ? [dist(P[0], P[1]), 0]
                          : i === n ? [dist(P[n - 1], P[n]), 0]
                          : [(P[i + 1][0] - P[i - 1][0]) / 2, (P[i + 1][1] - P[i - 1][1]) / 2]);
  const f = v => String(+v.toFixed(1));
  let d = `M ${f(P[0][0])} ${f(P[0][1])}`;
  for (let i = 0; i < n; i++)
    d += ` C ${f(P[i][0] + T[i][0] / 3)} ${f(P[i][1] + T[i][1] / 3)} ${f(P[i + 1][0] - T[i + 1][0] / 3)}` +
         ` ${f(P[i + 1][1] - T[i + 1][1] / 3)} ${f(P[i + 1][0])} ${f(P[i + 1][1])}`;
  return d;
}

// a point added on a wire goes into the stretch where it lengthens the wire least; returns a new list
function insertRoutePoint(start, points, end, p) {
  const P = [start, ...points, end], dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  let best = 0, cost = Infinity;
  for (let i = 0; i < P.length - 1; i++) {
    const c = dist(P[i], p) + dist(p, P[i + 1]) - dist(P[i], P[i + 1]);
    if (c < cost) { cost = c; best = i; }
  }
  const out = points.slice();
  out.splice(best, 0, p);
  return out;
}

// where Drawflow's path for a wire starts and ends (its first and last coordinates)
function pathEnds(d) {
  const n = (d || '').match(/-?\d+(\.\d+)?(e-?\d+)?/g);
  if (!n || n.length < 4) return null;
  return {start: [+n[0], +n[1]], end: [+n[n.length - 2], +n[n.length - 1]]};
}

function mergeSavedLayout(saved, key, tab) {
  return Object.assign({}, saved || {}, {[key]: tab});
}

// "試試問我" (2026-11-04, the user): a few example questions under the chat, one at a time; a click asks it.
// From kiosk_layout.json "examples" {zh: [...], en: [...]} - English falls back to Chinese.
function exampleQuestions(conf, lang) {
  const ex = (conf && conf.examples) || {};
  return (ex[lang] && ex[lang].length ? ex[lang] : ex.zh) || [];
}

function exampleAt(list, nowMs, periodMs) {
  return list.length ? list[Math.floor(nowMs / periodMs) % list.length] : null;
}

// The AgentLoop has no turn-end event: an example click counts as answering for ASK_MS (the first token
// can take ~10 s on the Orin), and any timeline event within EVENT_MS keeps it so.
const EXAMPLE_ASK_MS = 15000, EXAMPLE_EVENT_MS = 4000;
// a model segment or a tool call as it happens; not turn_snapshot, which every newly connected page
// receives (a click right after the page loaded was ignored, 2026-11-04)
function isAnswerEvent(data) {
  return !!(data && typeof data.event === 'string' && /^(segment_|tool_call_|compaction_)/.test(data.event));
}

function agentBusy(state, nowMs) {
  return (state.clickedAt > 0 && nowMs - state.clickedAt < EXAMPLE_ASK_MS) ||
         (state.lastEventAt > 0 && nowMs - state.lastEventAt < EXAMPLE_EVENT_MS);
}

// Which tools Tools_Hub is running, for its glow on the pipeline (2026-11-05). By call id: two tools
// at once stay lit until both end. A tool shows for at least minMs (read_camera_frame takes ~50 ms:
// on, off within one frame, never seen). clear() at the end of an answer drops any whose end never
// arrived (a stuck "執行中：read_camera_frame" until the page was reloaded) and returns their names.
class ToolRunState {
  constructor(minMs) { this.minMs = minMs; this.calls = new Map(); this.lingerUntil = 0; this.lastName = ''; }
  start(id, name, now) { this.calls.set(id, {name, at: now}); }
  end(id, now) {
    const c = this.calls.get(id);
    if (!c) return;
    this.calls.delete(id);
    if (c.at + this.minMs > this.lingerUntil) { this.lingerUntil = c.at + this.minMs; this.lastName = c.name; }
  }
  clear() {
    const names = [...this.calls.values()].map(c => c.name);
    this.calls.clear();
    this.lingerUntil = 0;
    return names;
  }
  view(now) {
    if (this.calls.size) return {running: true, name: [...this.calls.values()].pop().name};
    if (now < this.lingerUntil) return {running: true, name: this.lastName};
    return {running: false, name: ''};
  }
}

// ---- the auto page: cards chosen by node type (spec 2026-11-06-generic-kiosk-display) ---------------

const CARD_ORDER = ['chat', 'alert', 'event', 'rag', 'detect', 'label', 'generate', 'vlm'];   // spec §5, §5.1
const CARD_OF_TYPE = {AgentLoop: 'chat', One_Step_Alert: 'alert', Two_Steps_Alert: 'alert', EventLog: 'event',
                      NanoDB_Fashion: 'rag', OpenWord_detector: 'detect', AutoLabeler: 'label', VLMLabelParser: 'label',
                      Cosmos3Generator: 'generate', NanoLLM_ICL: 'vlm', vLLM: 'vlm'};

// The right column's cards, in CARD_ORDER: a vLLM fed by an AgentLoop is the chat's backend (no card of
// its own); a TextStream only shows a model's text, so it is a card only when no model has one.
function autoCards(plugins, connections) {
  const loops = new Set(plugins.filter(p => p.type === 'AgentLoop').map(p => p.name));
  const behindLoop = new Set((connections || []).filter(c => loops.has(c.from)).map(c => c.to));
  const cards = [];
  for (const p of plugins) {
    const kind = CARD_OF_TYPE[p.type];
    if (!kind || (p.type === 'vLLM' && behindLoop.has(p.name))) continue;
    cards.push({kind, node: p.name});
  }
  if (!cards.some(c => c.kind === 'vlm'))
    for (const p of plugins) if (p.type === 'TextStream') cards.push({kind: 'vlm', node: p.name});
  return CARD_ORDER.flatMap(k => cards.filter(c => c.kind === k));
}

// The big picture: the first VideoOutput the camera screen does not claim as a sensor view (spec §8.1)
function mainVideo(plugins, layout) {
  const sensors = new Set(((layout && layout.camera && layout.camera.slots) || []).map(s => s.node));
  const videos = plugins.filter(p => p.type === 'VideoOutput').map(p => p.name);
  if (!videos.length) return {main: null, thumbs: []};
  const main = videos.find(n => !sensors.has(n)) || videos[0];
  return {main, thumbs: videos.filter(n => n !== main).slice(0, 4)};
}

// The chat fills the column on its own; otherwise the first maxCards cards (spec §6)
function layoutCards(cards, maxCards = 3) {
  const chat = cards.find(c => c.kind === 'chat');
  if (chat) return {shown: [chat], hidden: cards.filter(c => c !== chat)};
  return {shown: cards.slice(0, maxCards), hidden: cards.slice(maxCards)};
}

function columnRects(n, top = 72, height = 1000, gap = 8, x = 1200, w = 712) {
  if (n <= 0) return [];
  const h = (height - gap * (n - 1)) / n;
  return Array.from({length: n}, (_, i) => [x, top + i * (h + gap), w, h]);
}

// VLM card (spec §8 / Review Focus 4): a vLLM OutputFinal grows over several messages; one that starts
// with the newest entry replaces it, anything else is a new answer on top
function vlmHistory(list, text, max = 3) {
  if (typeof text !== 'string' || !text.trim()) return list;
  if (list.length && text.startsWith(list[0])) return [text, ...list.slice(1)];
  return [text, ...list].slice(0, max);
}

// Alert card: alert nodes only send when they fire, so "active" is the last one within holdMs (spec §9)
function alertState(state, text, nowMs) {
  return {count: (state ? state.count : 0) + 1, text, at: nowMs};
}

function alertActive(state, nowMs, holdMs = 8000) {
  return !!state && nowMs - state.at <= holdMs;
}

// RAG card: NanoDB_Fashion's search results (index, similarity, metadata{path, tag}); [] = nothing found
function ragView(results, thresholdPct) {
  if (!Array.isArray(results) || !results.length) return {best: null, above: false};
  const r = results.reduce((a, b) => (b.similarity > a.similarity ? b : a));
  const meta = r.metadata || {};
  return {best: {path: meta.path, tag: meta.tag || '', similarity: r.similarity}, above: r.similarity >= thresholdPct / 100};
}

// NanoDB metadata paths are absolute (/data/nanodb/...): '/' + path would be '//data/...', which a browser
// reads as a protocol-relative URL to the host "data" (found on the Orin, 2026-11-06); file names have spaces
function ragImageUrl(path) {
  if (!path) return '';
  return '/' + String(path).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}

// RAG card: the tags already in the database, as one-click buttons for tagging the current frame
function ragKnownTags(results) {
  const tags = [];
  for (const r of Array.isArray(results) ? results : []) {
    const t = r && r.metadata && r.metadata.tag;
    if (t && !tags.includes(t)) tags.push(t);
  }
  return tags;
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

function countedDesc(map) {
  return [...map.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

// Detection card: OpenWord_detector's AllDetRes, a JSON string [names, boxes, confidences] (openword_detector.py)
function detectView(json) {
  const d = parseJson(json);
  if (!Array.isArray(d) || !Array.isArray(d[0])) return [];
  const by = new Map();
  d[0].forEach((name, i) => {
    const conf = Array.isArray(d[2]) && typeof d[2][i] === 'number' ? d[2][i] : 0;
    const e = by.get(name) || {name, count: 0, best: 0};
    e.count += 1; e.best = Math.max(e.best, conf);
    by.set(name, e);
  });
  return countedDesc(by);
}

// Auto-label card: AutoLabeler / VLMLabelParser output 1, a JSON string [{label, bbox, ...}]
function labelView(json) {
  const d = parseJson(json);
  if (!Array.isArray(d)) return [];
  const by = new Map();
  for (const det of d) {
    if (!det || !det.label) continue;
    const e = by.get(det.label) || {name: det.label, count: 0};
    e.count += 1;
    by.set(det.label, e);
  }
  return countedDesc(by);
}

// "嘿，小研" in the banner: the booth screens as before, never the typed-only Orin page, and on the
// auto page only when the preset has a WakeWord (2026-11-06, the user)
function kioskShowsWakeCall(screen, plugins) {
  if (screen === 'single') return false;
  if (screen === 'auto') return (plugins || []).some(p => p.type === 'WakeWord');
  return true;
}

// a preset that hears through the browser (WebAudioIn, the Orin voice preset): the page has to send
// the microphone itself (2026-11-06); the camera screen has no controls
function kioskNeedsBrowserMic(screen, plugins) {
  return screen !== 'camera' && (plugins || []).some(p => p.type === 'WebAudioIn');
}

// DatasetCollector's zip (server.py /download_dataset/<job_id>); its job ids are uuid4 hex
function datasetDownloadUrl(jobId) {
  return typeof jobId === 'string' && /^[0-9a-f]{32}$/.test(jobId) ? `/download_dataset/${jobId}` : null;
}

// the Image_Input wired into a generator: with an image held, the generator makes a video from it
function imageInputOf(plugins, connections, node) {
  const c = (connections || []).find(c => c.to === node &&
    (plugins || []).some(p => p.name === c.from && p.type === 'Image_Input'));
  return c ? c.from : null;
}

const AUTO_RECTS = {camera: [8, 72, 1184, 620], cameraWithThumbs: [8, 72, 1184, 520],
                    thumbs: [8, 600, 1184, 92], pipeline: [8, 700, 1184, 372]};

if (typeof module !== 'undefined')
  module.exports = {autoCards, mainVideo, layoutCards, columnRects, AUTO_RECTS,
                    vlmHistory, alertState, alertActive, ragView, ragImageUrl, ragKnownTags, detectView, labelView, datasetDownloadUrl, imageInputOf, kioskShowsWakeCall, kioskNeedsBrowserMic,
                    SENSOR_PIPELINE_TYPES, BRIDGE_TYPES, partitionNodes, edgesForTab, resolveSlots,
                    edgeKey, activityLevels, IdleTimer, hasNewNodes, pipelinePlugins, tabPlugins, nodeCategory,
                    linkEnds, groupTracks, trackingTargets, turnSegments, cameraOfTool, wakeHint, kioskPlaysAudio, zoomAt, trackPage,
                    KIOSK_TEXT, kioskText, bootView, listenBubble, levelBars, noiseFloor, slotsForCache,
                    singleNodes, trackingTag, bannerKpis, mergeSavedLayout, routeKey, cleanRoutes,
                    smoothRoutePath, insertRoutePoint, pathEnds,
                    exampleQuestions, exampleAt, agentBusy, isAnswerEvent, ToolRunState};
