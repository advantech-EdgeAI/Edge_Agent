// EventLog widget (docs/superpowers/specs/2026-10-07-event-log-design.md §6).
// Pure formatting functions (tested with node) + the DOM wiring grid.js calls.

const CARD_WORDS = {secUnit: 's', eventWaitingModel: 'Waiting for the summary model…', eventSummarizing: 'Writing the summary…'};
// words: the kiosk's table (secUnit, eventWaitingModel, eventSummarizing); Studio shows English
function cardView(ev, words) {
  const e = ev || {}, w = k => (words && words[k]) || CARD_WORDS[k];
  const pending = e.status === 'summarizing' || e.status === 'waiting_model';
  const d = (typeof e.duration === 'number' && isFinite(e.duration)) ? `${Math.round(e.duration)} ${w('secUnit')}` : '';
  return {time: (e.start || '').slice(11, 19), type: e.type || '', duration: d,
          summary: e.status === 'waiting_model' ? w('eventWaitingModel') : pending ? w('eventSummarizing') : (e.summary || ''), pending,
          failed: e.status === 'failed', truncated: !!(e.truncated || e.interrupted)};   // ⚠ on the card
}

function assetUrl(rel) {
  return rel ? '/events/' + rel.split('/').map(encodeURIComponent).join('/') : null;
}

function detailHTML(ev, esc) {
  const e = ev || {};
  const url = assetUrl(e.clip);
  const player = url ? `<video class="event-log-video" controls preload="metadata" src="${esc(url)}"></video>`
                     : `<div class="event-log-warn">Could not save the clip${(e.clip_error || e.error) ? ': ' + esc(e.clip_error || e.error) : ''}</div>`;
  // max_seconds, not duration: the clip also holds pre_seconds before the alert
  const trunc = e.interrupted ? `<div class="event-log-warn">⚠ Recording interrupted (it stopped before the event ended)</div>`
              : e.truncated ? `<div class="event-log-warn">⚠ Truncated (longer than ${esc(Math.round(e.max_seconds || e.duration || 0))} s)</div>` : '';
  const steps = (e.steps || []).map(s => `<li>${esc(s)}</li>`).join('');
  return `${player}${trunc}` +
         (steps ? `<div class="event-log-label">Steps</div><ul class="event-log-steps">${steps}</ul>` : '') +
         (e.result ? `<div class="event-log-label">Result</div><div>${esc(e.result)}</div>` : '');
}

function clearConfirmText(n) {
  return `Delete all ${n} events?\nEvery event's summary, clip and thumbnail is deleted from the disk. This cannot be undone.`;
}

// the node re-sends the whole list every 10 s; re-render only when something shown would change
function renderKey(events, open) {
  return JSON.stringify([open || null, events || []]);
}

if (typeof module !== 'undefined') module.exports = {cardView, assetUrl, detailHTML, renderKey, clearConfirmText};

// ---- browser side -----------------------------------------------------------------------------
var eventLogStates = {};     // plugin name -> [events], newest first
var eventLogOpen = {};       // plugin name -> id of the expanded event
var eventLogKeys = {};       // plugin name -> renderKey() of what is on screen

function addEventLogHooks(name) {
  if( !(name in outputListeners && 0 in outputListeners[name]) )
    addOutputListener(name, 0, function(state) {
      eventLogStates[name] = (state && state.events) || [];
      renderEventLog(name);
    });
}

function addEventLogWidget(name, id, title, grid_options) {
  const html = `<div class="event-log-wrap">
      <div class="event-log-bar"><button type="button" class="btn btn-sm btn-outline-danger" id="${id}_clear">Clear all events</button></div>
      <div class="event-log" id="${id}_list"><div class="event-log-empty">No events yet</div></div></div>`;
  const widget = addGridWidget(id, title, html, null, Object.assign({w: 12, h: 9}, grid_options));
  const clear = document.getElementById(`${id}_clear`);
  clear.addEventListener('mousedown', e => e.stopPropagation());
  clear.addEventListener('pointerdown', e => e.stopPropagation());
  clear.addEventListener('click', () => {
    const n = (eventLogStates[name] || []).length;
    if (n && window.confirm(clearConfirmText(n)))
      sendWebsocket({[name]: {clear_events: {}}});
  });
  const list = document.getElementById(`${id}_list`);
  list.addEventListener('mousedown', e => e.stopPropagation());
  list.addEventListener('pointerdown', e => e.stopPropagation());
  list.addEventListener('click', e => {
    const card = e.target.closest('.event-log-card');
    if (!card || e.target.closest('video')) return;
    eventLogOpen[name] = eventLogOpen[name] === card.dataset.id ? null : card.dataset.id;
    renderEventLog(name);
  });
  eventLogKeys[name] = null;   // a reopened widget starts empty: draw it even if nothing changed
  renderEventLog(name);
  return widget;
}

function renderEventLog(name) {
  const list = document.getElementById(`${name}_grid_list`);
  if (!list) return;
  const events = eventLogStates[name] || [];
  const open = eventLogOpen[name];
  const key = renderKey(events, open);
  if (eventLogKeys[name] === key) return;
  eventLogKeys[name] = key;
  if (!events.length) { list.innerHTML = '<div class="event-log-empty">No events yet</div>'; return; }
  // keep the open card's player (playing or paused) so a re-render does not rewind it
  const player = list.querySelector('.event-log-detail video');
  const keep = player && player.closest('.event-log-card').dataset.id === open ? player : null;
  list.innerHTML = events.map(ev => {
    const v = cardView(ev);
    const thumb = assetUrl(ev.thumbnail);
    const cls = `event-log-card${v.pending ? ' pending' : ''}${v.failed ? ' failed' : ''}`;
    return `<div class="${cls}" data-id="${escapeHTML(ev.id)}">
      ${thumb ? `<img class="event-log-thumb" src="${escapeHTML(thumb)}">` : ''}
      <div class="event-log-text">
        <div class="event-log-head"><span>${escapeHTML(v.time)}</span><span>${escapeHTML(v.type)}</span>
          <span>${escapeHTML(v.duration)}</span>${v.truncated ? '<span>⚠</span>' : ''}</div>
        <div class="event-log-summary">${escapeHTML(v.summary)}</div>
      </div>
      ${ev.id === open ? `<div class="event-log-detail">${detailHTML(ev, escapeHTML)}</div>` : ''}
    </div>`;
  }).join('');
  if (keep) {
    const slot = list.querySelector('.event-log-detail video');
    if (slot) slot.replaceWith(keep);
  }
}
