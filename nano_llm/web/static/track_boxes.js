// Tracking boxes drawn by the browser over the camera views (docs/superpowers/specs/2026-10-04-
// plugin-independence-design.md §3.2). Tools_Hub's tracking module sends {overlay: "tracking",
// camera, node, tracks: [{box (0-1), id, label, distance}]} on its output 2; every VideoOutput
// reports the node feeding it in its stats; the boxes go on each view fed by that node. The server
// no longer draws on the video. Pure functions first (tests/js/track_boxes.test.js).

const PALETTE = ['#00ff64', '#ffaa00', '#00aaff', '#ff3ca0', '#b4ff00', '#a064ff'];
const STALE_SECONDS = 1.5;

function containRect(natW, natH, boxW, boxH) {
  // where an object-fit:contain picture sits inside its box
  if (!natW || !natH || !boxW || !boxH) return null;
  const scale = Math.min(boxW / natW, boxH / natH);
  const w = Math.round(natW * scale), h = Math.round(natH * scale);
  return {x: Math.round((boxW - w) / 2), y: Math.round((boxH - h) / 2), w: w, h: h};
}

function boxToPixels(box, rect) {
  return [rect.x + box[0] * rect.w, rect.y + box[1] * rect.h, rect.x + box[2] * rect.w, rect.y + box[3] * rect.h]
    .map(Math.round);
}

function labelText(t) {
  let text = `#${t.id} ${t.label}`;
  if (typeof t.distance === 'number')
    text += t.distance < 1.0 ? ` ${Math.round(t.distance * 100)}cm` : ` ${t.distance.toFixed(2)}m`;
  return text;
}

function colorFor(label) {
  let h = 5381;
  for (const ch of String(label)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function placeLabel(box, w, h, placed, rect) {
  // where a w x h label goes: above its box, else under it, else stacked higher - never over a
  // label already placed (side-by-side boxes, 2026-10-04) and never outside the picture
  const [x1, y1, , y2] = box;
  const overlaps = c => placed.some(p => c.x < p.x + p.w && p.x < c.x + c.w && c.y < p.y + p.h && p.y < c.y + c.h);
  const inside = c => c.y >= rect.y && c.y + c.h <= rect.y + rect.h;
  const candidates = [y1 - h, y2, y1 - 2 * h, y1 - 3 * h, y2 + h].map(y => ({x: x1, y: y, w: w, h: h}));
  return candidates.find(c => inside(c) && !overlaps(c)) || candidates.find(inside) || candidates[0];
}

function viewsForNode(sources, node) {
  if (!node) return [];
  return Object.keys(sources).filter(name => sources[name] === node);
}

function isStale(lastTime, now, maxAge) {
  return typeof lastTime !== 'number' || now - lastTime > (maxAge || STALE_SECONDS);
}

if (typeof module !== 'undefined')
  module.exports = {PALETTE, containRect, boxToPixels, labelText, colorFor, placeLabel, viewsForNode, isStale};

// ---- browser side -----------------------------------------------------------------------------
var trackBoxesByNode = {};      // node name -> {time (s), tracks}
var trackBoxesSources = {};     // VideoOutput name -> node feeding it (from its stats)
var trackBoxesTimer = null;

function trackBoxesSetSource(viewName, node) {
  trackBoxesSources[viewName] = node;
}

function addTrackBoxesHooks(hubName) {
  if (!(hubName in outputListeners && 2 in outputListeners[hubName]))
    addOutputListener(hubName, 2, function(msg) {
      if (!msg || msg.overlay !== 'tracking') return;
      trackBoxesByNode[msg.node || msg.camera] = {time: performance.now() / 1000, tracks: msg.tracks || []};
      requestAnimationFrame(drawTrackBoxes);
    });
  if (trackBoxesTimer === null)                       // clears boxes nobody refreshes any more
    trackBoxesTimer = setInterval(drawTrackBoxes, 250);
}

function trackCanvas(viewName) {
  const id = `${viewName}_grid`;
  const container = document.getElementById(`${id}_media_container`);
  if (!container) return null;
  let canvas = document.getElementById(`${id}_track_canvas`);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = `${id}_track_canvas`;
    canvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:2;';
    container.appendChild(canvas);
  }
  return {canvas: canvas, container: container, img: document.getElementById(`${id}_mjpeg_stream`)};
}

function drawTrackBoxes() {
  const now = performance.now() / 1000;
  for (const viewName of Object.keys(trackBoxesSources)) {
    const data = trackBoxesByNode[trackBoxesSources[viewName]];
    const view = trackCanvas(viewName);
    if (!view) continue;
    const {canvas, container, img} = view;
    const dpr = window.devicePixelRatio || 1;
    const cw = container.clientWidth, ch = container.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!data || isStale(data.time, now) || !data.tracks.length || !img || img.style.display === 'none') continue;
    const rect = containRect(img.naturalWidth, img.naturalHeight, cw, ch);
    if (!rect) continue;
    const thick = Math.max(2, Math.round(Math.min(rect.w, rect.h) / 250));
    ctx.font = `${Math.max(11, Math.round(Math.min(rect.w, rect.h) / 28))}px sans-serif`;
    ctx.textBaseline = 'bottom';
    const placed = [];
    for (const t of data.tracks) {
      const [x1, y1, x2, y2] = boxToPixels(t.box, rect);
      const color = colorFor(t.label);
      ctx.lineWidth = thick;
      ctx.strokeStyle = color;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const text = labelText(t);
      const tw = ctx.measureText(text).width + 6, th = parseInt(ctx.font) + 4;
      const spot = placeLabel([x1, y1, x2, y2], tw, th, placed, rect);
      placed.push(spot);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(spot.x, spot.y, tw, th);
      ctx.fillStyle = color;
      ctx.fillText(text, spot.x + 3, spot.y + th - 2);
    }
  }
}
