// Sensor view (docs/superpowers/specs/2026-10-13-sensor-view-design.md): the booth screen's view
// mode, which widgets it shows, and the "waiting / signal lost" overlay. Loaded by studio.html
// before studio.js (studio.js needs normalizeViewMode while it is still being parsed). The pure
// functions are tested with node (tests/js/sensor_view.test.js).
const SENSOR_WIDGET_TYPES = ['VideoOutput', 'WebVideoIn', 'Image_Input'];
const SIGNAL_STALE_MS = 3000;
const SIGNAL_CHECK_MS = 500;

function normalizeViewMode(raw) {
  if (raw === 'sensor' || raw === 'camera') return 'sensor';   // camera: the 2026-09-19 name, kept for bookmarks
  if (raw === 'pipeline') return 'pipeline';
  return null;                                                   // everything, fully interactive
}

function isSensorWidget(type) { return SENSOR_WIDGET_TYPES.includes(type); }

function signalState(lastSeenMs, nowMs, staleMs) {
  if (lastSeenMs === null || lastSeenMs === undefined) return 'waiting';
  return nowMs - lastSeenMs <= staleMs ? 'live' : 'lost';
}

// words: the kiosk's {waiting, lost, status: {node status: translation}} (its zh / en table); Studio
// leaves it null and shows English; an unknown status is shown as the node sent it
var sensorViewWords = null;
function overlayText(state, statusText, words = sensorViewWords) {
  if (state === 'live') return null;
  if (statusText)                             // a node's own status says more than "Signal lost"
    return (words && words.status && words.status[statusText]) || statusText;
  if (words) return state === 'waiting' ? words.waiting : words.lost;
  return state === 'waiting' ? 'Waiting for signal' : 'Signal lost';
}

// Per-view widget positions (2026-10-14): the sensor and pipeline views are arranged separately and
// share coordinates (their widgets never overlap within a view), but the no-param page shows both
// sets and used to push them apart and save that. Each view keeps its own copy; null = layout_grid.
function layoutKey(mode) {
  return mode ? `layout_grid_${mode}` : 'layout_grid';
}

function pickLayout(state, mode) {
  const own = mode ? state[layoutKey(mode)] : undefined;
  if (own !== undefined && own !== null) return own;
  return state.layout_grid || {};
}

// A widget created at a saved position (x and y given) must not be saved again by GridStack's
// 'added' event: if something pushed it, that would store the pushed place. Only a widget placed
// automatically (just a size) is new and gets saved.
function placedFromSave(options) {
  return !!options && typeof options.x === 'number' && typeof options.y === 'number';
}

// ---- DOM (browser only) -------------------------------------------------------------------

const sensorSignals = {};    // plugin name -> [{el, overlay}] (the kiosk shows one sensor in several boxes)
const sensorLastSeen = {};   // plugin name -> Date.now() of the last frame or sample
const sensorStatus = {};     // plugin name -> status text from the plugin's stats, or null

let signalClock = () => Date.now();
function _setClock(fn) { signalClock = fn; }          // tests only

function sensorSignalRender(name) {
  const boxes = (sensorSignals[name] || []).filter(s => document.body.contains(s.el));
  if (!boxes.length) { delete sensorSignals[name]; return; }
  sensorSignals[name] = boxes;
  const state = signalState(sensorLastSeen[name] ?? null, signalClock(), SIGNAL_STALE_MS);
  const text = overlayText(state, sensorStatus[name] || null);
  for (const s of boxes) {
    s.overlay.textContent = text || '';
    s.overlay.style.display = text ? 'flex' : 'none';
  }
}

// el must be position:relative (VideoOutput's media container, the IMU box)
function sensorSignalRegister(name, el) {
  // a double-click on a node whose widget is already open builds the widget again
  let overlay = el.querySelector(':scope > .sensor-signal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sensor-signal-overlay';
    el.appendChild(overlay);
  }
  const boxes = (sensorSignals[name] || []).filter(s => s.el !== el);
  boxes.push({el, overlay});
  sensorSignals[name] = boxes;
  sensorSignalRender(name);
}

function sensorSignalSeen(name) { sensorLastSeen[name] = signalClock(); }

function sensorSignalStatus(name, text) { sensorStatus[name] = text || null; }

function sensorSignalWatched() { return Object.keys(sensorSignals); }

function startSensorSignalWatch() {
  setInterval(() => sensorSignalWatched().forEach(sensorSignalRender), SIGNAL_CHECK_MS);
}

if (typeof module !== 'undefined')
  module.exports = {SENSOR_WIDGET_TYPES, SIGNAL_STALE_MS, normalizeViewMode, isSensorWidget, signalState, overlayText,
                    layoutKey, pickLayout, placedFromSave,
                    sensorSignalRegister, sensorSignalSeen, sensorSignalStatus, sensorSignalRender,
                    sensorSignalWatched, _setClock};
