// Option lists for the plugin add/config dialogs (grid.js addPluginDialog) - pure functions, tested with
// node (tests/js/dialog_options.test.js). Spec docs/superpowers/specs/2026-11-06-camera-picker-design.md §4.2, §4.4.
//
// An option is a string, or {value, label}: the dialog shows the label and submits the value (a camera
// shows its model; the preset stores its /dev/v4l/by-id path).

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function optionValue(o) {
  return (o !== null && typeof o === 'object') ? o.value : o;
}

function optionLabel(o) {
  return (o !== null && typeof o === 'object') ? (o.label ?? o.value) : o;
}

// <option> list for a <select>. With allowCustom (a free-text 'suggestions' field), a default that is not
// among the options (a typed-in file path, the /dev/video0 placeholder with no camera connected) is added
// first and selected, so the field shows it; a fixed 'options' list keeps choosing only from its options.
function buildOptionsHtml(options, defaultValue, allowCustom = true) {
  const hasDefault = defaultValue !== undefined && defaultValue !== null && defaultValue !== '';
  const values = (options || []).map(o => String(optionValue(o)));
  let html = '';
  if (allowCustom && hasDefault && !values.includes(String(defaultValue))) {
    const v = escapeHtml(defaultValue);
    html += `<option value="${v}" selected="selected">${v}</option>\n`;
  }
  for (const o of (options || [])) {
    const value = String(optionValue(o));
    const selected = (hasDefault && value === String(defaultValue)) ? ' selected="selected"' : '';
    html += `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(optionLabel(o))}</option>\n`;
  }
  return html;
}

// The parameters whose options are re-read when the dialog opens (only these show Detecting…).
function liveFields(parameters) {
  return Object.entries(parameters || {})
    .filter(([name, p]) => !p.hidden && ('options' in p || 'suggestions' in p))
    .map(([name]) => name);
}

// For each parameter with options/suggestions in a fresh /api/type_hints reply: the new <option> list
// and the escaped help text, so an open dialog's selects can be updated in place (§4.4).
function liveSelectUpdates(parameters) {
  const updates = [];
  for (const [param, p] of Object.entries(parameters || {})) {
    if (p.hidden) continue;
    const options = ('options' in p) ? p.options : (('suggestions' in p) ? p.suggestions : null);
    if (options === null) continue;
    updates.push({param, html: buildOptionsHtml(options, p.default, !('options' in p)), help: p.help ? escapeHtml(p.help) : ''});
  }
  return updates;
}

// GET /api/type_hints/<type>; null when it fails or takes longer than timeoutMs.
async function fetchLiveParameters(type, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reply = await fetch(`/api/type_hints/${encodeURIComponent(type)}`, {signal: controller.signal});
    if (!reply.ok) return null;
    return (await reply.json()).parameters || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

if (typeof module !== 'undefined')
  module.exports = {liveFields, escapeHtml, optionValue, optionLabel, buildOptionsHtml, liveSelectUpdates, fetchLiveParameters};
