// The AgentLoop chat (history, live timeline, status bar) shared by Studio's grid.js and the kiosk
// brain screen (docs/superpowers/specs/2026-10-20-kiosk-display-design.md §2.3). Moved from grid.js
// unchanged, plus mountAgentLoopChat() which builds it in any container.
var manuallyOpenedThinking = new Set();  // msg indices the user has manually expanded, surviving history redraws
var timelineConfirmHandlers = [];  // callbacks(safety_review_name, data) registered by an
                                    // AgentLoop timeline widget to claim OutputConfirmRequest
                                    // events for inline rendering instead of the confirm modal
var TOOL_STATUS_LABELS = {done: '✓ Done', error: '✗ Failed', denied: 'Denied', timeout: 'Timed out'};
// The kiosk's words for the visible labels (its zh / en table; Studio leaves it null and shows English).
var chatViewWords = null;
function chatWord(key, en) { return (chatViewWords && chatViewWords[key]) || en; }
function toolStatusLabel(status) {
  const key = {done: 'toolDone', error: 'toolError', denied: 'toolDenied', timeout: 'toolTimeout'}[status];
  return key ? chatWord(key, TOOL_STATUS_LABELS[status]) : TOOL_STATUS_LABELS[status];
}
                                    // Shared between the live timeline card's renderToolCallResolved()
                                    // and updateChatHistory()'s persistent tool_calls summary badges,
                                    // so the two never drift onto different wording for the same status
                                    // (mirrors AgentLoop._classify_tool_status() being the single
                                    // backend source of truth for this same vocabulary).

// One-line tool summary from a call's arguments, e.g. {source: 'camera1', x: 0.5} -> 'camera1 · 0.5'
// (live timeline cards and the chat history's permanent tool cards). Returns plain text - escape it.
function summarizeToolArgs(args) {
  if (args === null || args === undefined) return '';
  const values = (typeof args === 'object') ? Object.values(args) : [args];
  let text = values.map(v => (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v)).join(' · ');
  return text.length > 40 ? text.slice(0, 39) + '…' : text;
}

// https://stackoverflow.com/a/6234804
function escapeHTML(unsafe) {
  unsafe = String(unsafe);
  return unsafe
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
    .replaceAll('\n', '<br/>');
}

function scrollBottom(container) {  // https://stackoverflow.com/a/21067431
  container.scrollTop = container.scrollHeight - container.clientHeight;
  //console.log(`scrolling to bottom ${container.scrollTop} ${container.scrollHeight} ${container.clientHeight}`);
}

// "Follow the latest output" for a chat history div: while the user is at the bottom, any change
// inside it (new bubble, streamed text, a tool card growing, a thinking block collapsing, a
// confirm button appearing, an image loading) scrolls to the bottom; scrolling up stops that
// until the user scrolls back down or clicks the "↓ Latest" button. One observer on the container
// replaces per-update "was I at the bottom?" checks, which missed every update path that forgot
// to wrap itself (2026-09-29: tool args and status changes did, so following stopped mid-turn).
// Sets container.chatFollow, which updateChatHistory() uses to keep the position while not following.
const CHAT_FOLLOW_SLACK_PX = 40;

function setupChatFollow(history_id) {
  const chc = document.getElementById(history_id);
  if (!chc || chc.chatFollowSetup) return;
  chc.chatFollowSetup = true;
  const jump = document.getElementById(`${history_id}_jump`);

  function setFollow(follow) {
    chc.chatFollow = follow;
    if (jump) jump.style.display = follow ? 'none' : 'block';
  }
  function toBottom() {
    chc.scrollTop = chc.scrollHeight;
  }
  setFollow(true);

  // Only the user's own scrolling can move us out of the bottom band: our own scrolls always land
  // at the bottom, and content growth alone never fires a scroll event.
  chc.addEventListener('scroll', function() {
    setFollow(chc.scrollHeight - chc.clientHeight - chc.scrollTop <= CHAT_FOLLOW_SLACK_PX);
  });
  new MutationObserver(function() {
    if (chc.chatFollow) toBottom();
  }).observe(chc, {childList: true, subtree: true, characterData: true, attributes: true,
                   attributeFilter: ['open', 'class', 'style', 'src']});
  chc.addEventListener('load', function() {   // images change height after they decode
    if (chc.chatFollow) toBottom();
  }, true);
  // the box itself shrinking (the kiosk's listening bubble taking room below it, a widget resize)
  // fires no scroll event either; keep the latest message in view
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function() {
      if (chc.chatFollow) toBottom();
    }).observe(chc);
  }
  if (jump) {
    jump.addEventListener('click', function() {
      setFollow(true);
      toBottom();
    });
  }
}

function updateChatHistory(id, history) {
    let chj = $(`#${id}`);
    let chc = document.getElementById(id);
    let isScrolledToBottom = chc.scrollHeight - chc.clientHeight <= chc.scrollTop + 1;
    const follow = chc.chatFollow;       // set by setupChatFollow(); undefined for other chat widgets
    const previousScrollTop = chc.scrollTop;

    chj.empty(); // clear because server may remove partial/rejected ASR prompts
    
    for( let n=0; n < history.length; n++ ) {
      const role = history[n]['role'];

      /*if( role == 'system' )
        continue;*/

      // Persistent tool-call record: AgentLoop._display_turns_since_reset() inserts one of
      // these as its own independent history entry per tool call, between the user's message
      // and the bot's answer (matching real execution order) - real user feedback 2026-09-13,
      // revised from an earlier version that merged this into the bot's answer bubble, which
      // looked visually inconsistent with the live timeline where each tool call is already
      // its own separate card. Reuses that same .timeline-card visual language (not a new
      // style) so the live card visually "shrinks into" this permanent one once the turn ends,
      // rather than the two looking unrelated. No interactive elements (no confirm/deny, no
      // streaming args body) - just the resolved name + status, same as what a live card looks
      // like right after it resolves.
      if( role === 'tool' ) {
        const status = history[n]['status'];
        // status is backend-controlled today (always one of AgentLoop._classify_tool_status()'s
        // fixed values) but constrained to a known-safe token here anyway before use in a class
        // attribute, matching the same defensive treatment applied elsewhere in this file.
        const safeStatus = /^[a-z_]+$/.test(status) ? status : 'unknown';
        const label = toolStatusLabel(status) || escapeHTML(status);
        const summary = summarizeToolArgs(history[n]['args']);
        chj.append(
          `<div id="msg_${n}" class="timeline-card timeline-card-tool_call timeline-card-done timeline-card-${safeStatus} mb-3">` +
          `<div class="timeline-card-header">🔧 <span class="timeline-tool-name">${escapeHTML(history[n]['name'])}</span>` +
          (summary ? `<span class="timeline-tool-summary"> · ${escapeHTML(summary)}</span>` : '') +
          `<span class="timeline-tool-meta"> · ${label}</span></div>` +
          `</div><br/>`);
        continue;
      }

      let contents = '';
      var hasImage = 'image' in history[n];
      
      if( hasImage ) {
        contents += `<img src=${history[n]['image']} width="100%">`;
        imageAtBottom = true;
      }

      // Collapsible "thinking" panel: expanded live while the model is still inside its
      // thinking span (no thinking_time yet), auto-collapses once thinking_time appears,
      // unless the user has manually re-expanded this message (tracked in manuallyOpenedThinking).
      let thinkingHtml = '';
      if( 'thinking' in history[n] && history[n]['thinking'].length > 0 ) {
        const thinkingTime = history[n]['thinking_time'];
        const stillThinking = (thinkingTime === undefined || thinkingTime === null);
        const shouldOpen = stillThinking || manuallyOpenedThinking.has(n);
        const label = stillThinking ? chatWord('thinking', 'Thinking...') : chatWord('thought', s => `Thought for ${s} s`)(thinkingTime.toFixed(1));
        thinkingHtml = `<details class="thinking-block" data-msg-id="${n}"${shouldOpen ? ' open' : ''}><summary>${label}</summary><div class="thinking-content">${history[n]['thinking']}</div></details>`;
      }

      // Bot answers are rendered as Markdown (bold, lists, line breaks...); history text is
      // already HTML-escaped by the server, which is what renderMarkdown() requires.
      if( 'text' in history[n] )
        contents += (role === 'bot' && typeof renderMarkdown === 'function')
          ? renderMarkdown(history[n]['text']) : history[n]['text'];

      // thinkingHtml alone (before any final text exists yet) must still render, so the
      // panel appears the instant the model starts thinking, not only once it answers.
      if( thinkingHtml.length > 0 || contents.length > 0 )
        chj.append(`<div id="msg_${n}" class="chat-message-${role} mb-3">${thinkingHtml}${contents}</div><br/>`);
    }

    // Re-attach toggle listeners after every rebuild (elements above were just recreated,
    // so any listener from the previous render is gone with them) to keep
    // manuallyOpenedThinking in sync with what the user has clicked open/closed.
    document.querySelectorAll('.thinking-block').forEach(function(details) {
      details.addEventListener('toggle', function() {
        const msgId = parseInt(details.dataset.msgId, 10);
        if( details.open )
          manuallyOpenedThinking.add(msgId);
        else
          manuallyOpenedThinking.delete(msgId);
      });
    });

    if( follow !== undefined ) {
      // setupChatFollow()'s observer already scrolls when following; otherwise keep the user's
      // place instead of letting the empty()+rebuild move it
      if( !follow )
        chc.scrollTop = previousScrollTop;
    } else if( isScrolledToBottom ) { // autoscroll unless the user has scrolled up
      if( hasImage )
        setTimeout(scrollBottom, 50, chc);  // wait for images to load to get right height
      else
        scrollBottom(chc);
    }
}

function addAgentLoopTimeline(name, history_id, type) {
  // Idempotency guard, mirroring addSafetyReviewWidget()'s/addHubDialog()'s
  // `if (!(name in outputListeners)) {...}` convention for the exact same remove-then-
  // re-add / close-then-reopen pitfall: addChatWidget_no_input_history3() calls this
  // function every time it runs for an AgentLoop-typed widget, which can happen more than
  // once for the same plugin `name` in one page session (e.g. the node's grid widget panel
  // is closed and reopened without the underlying plugin node itself being removed, so
  // outputListeners[name] is never cleared by removePlugins() in between). Without this
  // guard, a second call would build a SECOND, independent cardsByTurnRound/pendingCardQueue
  // closure, push a SECOND handleConfirmRequest closure onto the global
  // timelineConfirmHandlers array, and push a SECOND timeline_listener onto
  // outputListeners[name][6] (addOutputListener() itself only dedupes the send_client_output
  // subscription MESSAGE per channel, not the listener registration) - so every future
  // timeline event would be processed twice against two unrelated card registries, and
  // every future SafetyReview confirm request would be routed to two inline handlers,
  // risking a duplicate confirm/deny websocket send or a UI update applied to a stale,
  // detached card from the first closure's now-orphaned cardsByTurnRound.
  //
  // Checking channel 6 specifically - not just `name in outputListeners` the way
  // addSafetyReviewWidget() checks its own name - matters here because `name` is ALREADY a
  // key in outputListeners by the time this function ever runs (addChatWidget_no_input_
  // history3() unconditionally registers this same `name`'s channel-3 history listener
  // first, on every call): a bare `!(name in outputListeners)` check would incorrectly
  // skip registration on the very first call too.
  if (name in outputListeners && 6 in outputListeners[name])
    return;

  // Live per-turn timeline: renders directly inside the chat history div, appended after
  // updateChatHistory()'s own rebuild for that turn's user message (updateChatHistory() only
  // ever rebuilds from the durable OutputHistory record, which lags behind live streaming by
  // design - see docs/superpowers/specs/2026-09-12-agent-loop-live-streaming-timeline-design.md -
  // so this widget owns its own DOM nodes under a stable container, independent of
  // updateChatHistory()'s full-rebuild-on-every-broadcast behavior).
  const container_id = `${history_id}_timeline`;

  // cardsByTurnRound is keyed by a MINTED composite key `${turn_id}:${round}:${kind}:${seq}`
  // (see mintCardKey()), not just `${turn_id}:${round}` - final whole-branch review (I2) found
  // that a bare turn:round key collides whenever a single round emits more than one non-text
  // segment (e.g. <think>...</think> some text <tool_call>...) - the second segment_start
  // would silently overwrite the first segment's map entry. tool_call_pending/tool_call_resolved
  // carry only turn_id/round (no kind/seq of their own - see _emit_timeline() in agent_loop.py),
  // so they're correlated via lastToolCallKeyByRound instead of a direct key lookup.
  let cardsByTurnRound = {};       // composite key -> {el, bodyEl, kind, startTime}
  let segmentSeqByRound = {};      // `${turn_id}:${round}` -> next seq to mint for a new card
  let openCardKeyByRound = {};     // `${turn_id}:${round}` -> composite key of the segment
                                    // currently open (segment_start'd, not yet segment_end'd)
                                    // in that round - segment_delta/segment_end target this.
                                    // Safe because StreamSegmenter only ever has one active tag
                                    // per round (text streams in linearly, never interleaved),
                                    // so "most recently started, not yet ended" is unambiguous.
  let lastToolCallKeyByRound = {};  // `${turn_id}:${round}` -> composite key of the most recent
                                     // 'tool_call'-kind card in that round - this project's
                                     // backend only ever attempts one tool call per round today
                                     // (see _run_turn()'s single '<tool_call' check), so this is
                                     // an unambiguous target for tool_call_pending/_resolved.
  let pendingCardQueue = [];   // FIFO of {turn_id, round, el, statusEl} awaiting a SafetyReview correlation
  let unmatchedConfirmRequests = [];  // FIFO of {safety_review_name, data} - see handleConfirmRequest()'s
                                       // comment: a confirm request that arrives before its correlated
                                       // tool_call_pending card exists yet waits here instead of being
                                       // dropped, and renderToolCallPending() drains it on card creation.
  let streamingTextEl = null;   // the live-streaming 'text' (final answer) node - see
  let streamingTurnId = null;   // handleTextSegment()/I1's design note below.

  function ensureContainer() {
    let el = document.getElementById(container_id);
    if (el == null) {
      const history_el = document.getElementById(history_id);
      el = document.createElement('div');
      el.id = container_id;
      history_el.appendChild(el);
    }
    return el;
  }

  const cardsByCallId = {};      // harness: call_id -> tool card
  const unmatchedByCallId = {};  // harness: confirm requests whose card has not arrived yet

  function roundKey(data) {
    return `${data['turn_id']}:${data['round']}`;
  }

  // Scrolling is handled by setupChatFollow()'s observer on #${history_id} for every change, so
  // call sites just mutate (the wrapper stays so the mutation points remain easy to find).
  function withAutoScroll(mutate) {
    mutate();
  }

  function segmentLabel(kind) {
    if (kind === 'tool_call') return chatWord('prepareTool', 'Preparing a tool call');
    return '';
  }

  // Status bar under the chat (outside the scroll area): what the turn is doing and for how long.
  // Started/stopped from the history broadcast (last entry 'user' = a turn is running), phase
  // updated from timeline events.
  let statusTimer = null, statusStart = 0, statusPhase = '';
  function setStatusPhase(phase) {
    statusPhase = phase;
    if (statusTimer) renderStatus();
  }
  function renderStatus() {
    const el = document.getElementById(`${history_id}_status`);
    if (!el) return;
    el.innerHTML = `<span class="agentloop-status-dot"></span>${escapeHTML(statusPhase)}… ` +
                   `<span class="agentloop-status-time">${((Date.now() - statusStart) / 1000).toFixed(1)}s</span>`;
  }
  function startStatus() {
    if (statusTimer) return;
    statusStart = Date.now();
    statusPhase = chatWord('phaseThinking', 'Thinking');
    const el = document.getElementById(`${history_id}_status`);
    if (el) el.style.display = 'flex';
    renderStatus();
    statusTimer = setInterval(renderStatus, 200);
  }
  function stopStatus() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    const el = document.getElementById(`${history_id}_status`);
    if (el) el.style.display = 'none';
  }

  const summarizeArgs = summarizeToolArgs;
  let replaying = false;   // turn_snapshot replay: no real timing, so no durations

  // I1 (final whole-branch review): the final answer's 'text' segments now stream live too,
  // directly into the chat area (#${history_id} itself, a sibling of the timeline container
  // and the real chat bubbles) rather than as a bordered timeline card - with a blinking
  // cursor so it visually reads as "still generating". It is deliberately NOT keyed into
  // cardsByTurnRound/the turn:round:kind:seq scheme above: a turn's answer can be split
  // across multiple 'text' segments (interleaved with <think>/<tool_call> blocks) and they
  // all belong to ONE growing bubble for the turn, not one card per segment.
  //
  // Removal: updateChatHistory()'s OWN channel-3 listener (registered first, in
  // addChatWidget_no_input_history3(), so it runs first within the same synchronous
  // sendOutput() dispatch - see addOutputListener()'s per-channel listener array) does
  // `$(#${history_id}).empty()` as the first thing it does on every real OutputHistory
  // broadcast. Since streamingTextEl is a plain child of that same #${history_id} div, that
  // empty() call already removes it - and the very next lines in the same jQuery call render
  // the authoritative final bubble - so there is never a synchronous gap where both could
  // paint, and no leftover DOM node afterward. The second channel-3 listener registered
  // further down (this function's own) only needs to reset the JS-side bookkeeping
  // (streamingTextEl/streamingTurnId, and the cardsByTurnRound family) so it doesn't keep
  // referencing those now-detached nodes.
  function handleTextSegment(data) {
    if (data['event'] === 'segment_start') {
      if (streamingTextEl && streamingTurnId !== data['turn_id'])
        // An orphaned node from a previous turn that, for whatever reason (e.g. an error
        // path that skipped a clean OutputHistory broadcast), never got cleared below -
        // drop it before starting the new turn's node fresh.
        clearStreamingText();
      if (!streamingTextEl) {
        withAutoScroll(function() {
          streamingTextEl = document.createElement('div');
          streamingTextEl.className = 'chat-message-bot mb-3 timeline-streaming-text';
          streamingTextEl.innerHTML =
            '<span class="timeline-streaming-content"></span><span class="timeline-cursor">▊</span>';
          streamingTextEl.rawText = '';
          document.getElementById(history_id).appendChild(streamingTextEl);
        });
        streamingTurnId = data['turn_id'];
      }
      setStatusPhase(chatWord('phaseAnswering', 'Writing the answer'));
      return;
    }
    if (!streamingTextEl) return;
    if (data['event'] === 'segment_delta') {
      withAutoScroll(function() {
        // re-rendered as Markdown on every delta (escaped first - see markdown.js), so bold,
        // lists and line breaks look the same while streaming as in the final bubble
        streamingTextEl.rawText += data['text_delta'];
        streamingTextEl.querySelector('.timeline-streaming-content').innerHTML =
          renderMarkdown(escapeHTML(streamingTextEl.rawText));
      });
    }
    // segment_end for 'text': deliberately a no-op - a turn can have more 'text' segments
    // after this one (text -> tool_call -> more text), so one text segment ending does not
    // mean the turn's answer is finished. The node stays visible, cursor still blinking,
    // until the real OutputHistory broadcast lands and clearStreamingText() below runs.
  }

  function clearStreamingText() {
    if (streamingTextEl && streamingTextEl.parentNode)
      streamingTextEl.parentNode.removeChild(streamingTextEl);
    streamingTextEl = null;
    streamingTurnId = null;
  }

  function renderSegmentEvent(data) {
    if (data['kind'] === 'text') {
      handleTextSegment(data);
      return;
    }
    const rk = roundKey(data);
    if (data['event'] === 'segment_start') {
      const seq = segmentSeqByRound[rk] || 0;
      segmentSeqByRound[rk] = seq + 1;
      const key = `${rk}:${data['kind']}:${seq}`;
      let el, bodyEl;
      if (data['kind'] === 'thinking') {
        // I6 (final whole-branch review): reuse the exact collapsible look of the existing,
        // working NanoLLM_ICL thinking-panel convention (chat.css's .thinking-block/
        // .thinking-content, rendered by updateChatHistory() elsewhere in this file) - only
        // its VISUAL treatment, not its transport (that panel is built from a durable
        // OutputHistory 'thinking'/'thinking_time' field; this one is built live from
        // segment_start/delta/end with no equivalent duration field, so elapsed time is
        // tracked client-side below via Date.now()).
        el = document.createElement('details');
        el.className = 'thinking-block timeline-card-thinking';
        el.open = true;
        el.innerHTML = `<summary>${chatWord('thinking', 'Thinking...')}</summary><div class="thinking-content"></div>`;
        bodyEl = el.querySelector('.thinking-content');
        setStatusPhase(chatWord('phaseThinking', 'Thinking'));
      } else {
        el = document.createElement('div');
        el.className = `timeline-card timeline-card-${data['kind']}`;
        el.innerHTML = `<div class="timeline-card-header">${segmentLabel(data['kind'])}</div><div class="timeline-card-body"></div>`;
        bodyEl = el.querySelector('.timeline-card-body');
      }
      withAutoScroll(function() { ensureContainer().appendChild(el); });
      cardsByTurnRound[key] = {el: el, bodyEl: bodyEl, kind: data['kind'], startTime: Date.now()};
      openCardKeyByRound[rk] = key;
      if (data['kind'] === 'tool_call') {
        lastToolCallKeyByRound[rk] = key;
        if (data['call_id'])
          cardsByCallId[data['call_id']] = cardsByTurnRound[key];
      }
      return;
    }
    const openKey = openCardKeyByRound[rk];
    const card = openKey ? cardsByTurnRound[openKey] : null;
    if (!card) return;
    if (data['event'] === 'segment_delta') {
      withAutoScroll(function() { card.bodyEl.textContent += data['text_delta']; });
    } else if (data['event'] === 'segment_end') {
      card.el.classList.add('timeline-card-done');
      if (card.kind === 'thinking') {
        const elapsedSec = (Date.now() - card.startTime) / 1000;
        const summaryEl = card.el.querySelector('summary');
        if (summaryEl)
          summaryEl.textContent = chatWord('thought', s => `Thought for ${s} s`)(elapsedSec.toFixed(1));
        card.el.open = false;  // auto-collapse once done, matching the existing thinking-panel convention
      }
      delete openCardKeyByRound[rk];
    }
  }

  function renderToolCallPending(data) {
    const rk = roundKey(data);
    const key = lastToolCallKeyByRound[rk];
    const card = data['call_id'] ? cardsByCallId[data['call_id']] : (key ? cardsByTurnRound[key] : null);
    if (!card) return;
    // One-line header (🔧 name · argument summary · time/status), full arguments collapsed below.
    const summary = summarizeArgs(data['args']);
    card.el.querySelector('.timeline-card-header').innerHTML =
      `🔧 <span class="timeline-tool-name">${escapeHTML(data['name'])}</span>` +
      (summary ? `<span class="timeline-tool-summary"> · ${escapeHTML(summary)}</span>` : '') +
      `<span class="timeline-tool-meta"></span>`;
    card.bodyEl.innerHTML =
      `<details class="timeline-tool-args-wrap"><summary>${chatWord('toolArgs', 'Arguments')}</summary>` +
      `<pre class="timeline-tool-args">${escapeHTML(JSON.stringify(data['args'], null, 2))}</pre></details>` +
      `<div class="timeline-tool-status">${chatWord('toolRunning', 'Running...')}</div>`;
    card.pendingTime = replaying ? null : Date.now();
    setStatusPhase(chatWord('phaseRun', n => `Running ${n}`)(data['name']));
    const statusEl = card.el.querySelector('.timeline-tool-status');
    if (data['call_id']) {
      // harness: SafetyReview confirm requests carry call_id - match by id, never by order.
      card.statusEl = statusEl;
      const waiting = unmatchedByCallId[data['call_id']];
      if (waiting) {
        delete unmatchedByCallId[data['call_id']];
        applyConfirmUI(statusEl, waiting.safety_review_name, waiting.data);
      }
      return;
    }
    // Real e2e testing against a live model (2 independent turns, both reproduced) showed
    // SafetyReview's OutputConfirmRequest can physically arrive at the browser BEFORE this
    // very tool_call_pending event, despite being logically emitted after it server-side -
    // see handleConfirmRequest()'s comment for why (two independently-forwarded output
    // channels, no cross-channel ordering guarantee). If that already happened, the request
    // is sitting in unmatchedConfirmRequests waiting for exactly this card - match it here
    // immediately instead of queuing this card to wait for a confirm request that already
    // came and went.
    if (unmatchedConfirmRequests.length > 0) {
      const unmatched = unmatchedConfirmRequests.shift();
      applyConfirmUI(statusEl, unmatched.safety_review_name, unmatched.data);
      return;
    }
    pendingCardQueue.push({turn_id: data['turn_id'], round: data['round'], el: card.el, statusEl: statusEl});
  }

  function renderToolCallResolved(data) {
    const rk = roundKey(data);
    const key = lastToolCallKeyByRound[rk];
    const card = data['call_id'] ? cardsByCallId[data['call_id']] : (key ? cardsByTurnRound[key] : null);
    if (!card) return;
    pendingCardQueue = pendingCardQueue.filter(function(p) { return p.el !== card.el; });
    if (data['call_id']) {
      delete cardsByCallId[data['call_id']];
      delete unmatchedByCallId[data['call_id']];
    }
    // Result goes into the header ("· 0.8 s · Done"); the status line was only there for
    // "Running..." and the confirm buttons.
    const label = toolStatusLabel(data['status']) || data['status'];
    const seconds = card.pendingTime ? ` · ${((Date.now() - card.pendingTime) / 1000).toFixed(1)} ${chatWord('secUnit', 's')}` : '';
    const metaEl = card.el.querySelector('.timeline-tool-meta');
    const statusEl = card.el.querySelector('.timeline-tool-status');
    if (metaEl) {
      metaEl.textContent = `${seconds} · ${label}`;
      if (statusEl) statusEl.remove();
    } else if (statusEl) {
      statusEl.textContent = label;
    }
    card.el.classList.add('timeline-card-done', `timeline-card-${data['status']}`);
    setStatusPhase(chatWord('phaseThinking', 'Thinking'));
  }

  // Shared by handleConfirmRequest() (confirm request arrives after its card already exists)
  // and renderToolCallPending() (card is created after its confirm request already arrived) -
  // whichever of the two happens second is the one that calls this, against the same statusEl.
  function applyConfirmUI(statusEl, safety_review_name, data) {
    if (!statusEl) return;
    setStatusPhase(chatWord('phaseConfirm', 'Waiting for confirmation'));
    statusEl.innerHTML =
      `<button class="btn btn-sm btn-danger timeline-confirm-btn">Confirm</button> ` +
      `<button class="btn btn-sm btn-secondary timeline-deny-btn">Deny</button>` +
      (data['call_id'] && data['allow_conversation'] !== false ? ` <button class="btn btn-sm btn-warning timeline-allow-btn">${chatWord('allowConversation', 'Allow for this conversation')}</button>` : '');
    statusEl.querySelector('.timeline-confirm-btn').addEventListener('click', function() {
      sendWebsocket({[safety_review_name]: {'confirm': {'request_id': data['request_id']}}});
      statusEl.textContent = chatWord('toolRunning', 'Running...'); setStatusPhase(chatWord('phaseTool', 'Running the tool'));
    });
    statusEl.querySelector('.timeline-deny-btn').addEventListener('click', function() {
      sendWebsocket({[safety_review_name]: {'deny': {'request_id': data['request_id']}}});
      statusEl.textContent = chatWord('toolRunning', 'Running...'); setStatusPhase(chatWord('phaseTool', 'Running the tool'));
    });
    const allowBtn = statusEl.querySelector('.timeline-allow-btn');
    if (allowBtn) {
      allowBtn.addEventListener('click', function() {
        sendWebsocket({[safety_review_name]: {'allow_conversation': {'request_id': data['request_id']}}});
        statusEl.textContent = chatWord('toolRunning', 'Running...'); setStatusPhase(chatWord('phaseTool', 'Running the tool'));
      });
    }
  }

  function handleConfirmRequest(safety_review_name, data) {
    // C1 (final whole-branch review): refuse to claim once this widget's own DOM is gone
    // (closed grid panel or a fully removed AgentLoop node) - timelineConfirmHandlers never
    // de-registers this closure (see addAgentLoopTimeline()'s own idempotency-guard comment
    // for why removal isn't tracked the same way outputListeners is), so without this check
    // a dead handler would keep "claiming" every future confirm request into
    // unmatchedConfirmRequests forever, permanently starving addSafetyReviewWidget()'s modal
    // fallback even though nothing could ever render this handler's queued entries again.
    if (document.getElementById(history_id) == null)
      return false;
    if (data['call_id'] && type !== 'AgentLoop')
      return false;  // a SafetyReview request: only an AgentLoop widget can show its card
    if (data['call_id']) {
      // harness: claim it and pair by id. Not gated on having seen this turn's timeline
      // events: the confirm request travels on another channel and often arrives first.
      const card = cardsByCallId[data['call_id']];
      if (card && card.statusEl)
        applyConfirmUI(card.statusEl, safety_review_name, data);
      else
        unmatchedByCallId[data['call_id']] = {safety_review_name: safety_review_name, data: data};
      return true;
    }
    const pending = pendingCardQueue.shift();
    if (!pending) {
      // Real e2e testing against a live model (2 independent turns, both reproduced)
      // proved this is the NORMAL arrival order, not a rare edge case: SafetyReview's
      // OutputConfirmRequest (channel 1) and AgentLoop's tool_call_pending (channel 6) are
      // forwarded to the browser via two independently-attached WebClient instances, each
      // with its own send path - nothing guarantees they arrive in the same order they were
      // logically emitted server-side, and observed reality is the confirm request often
      // arrives FIRST. Queue it here instead of dropping it; renderToolCallPending() checks
      // this queue the instant it creates the correlated card and matches immediately if an
      // entry is waiting. Left uncapped: this project's harness only ever gates one tool
      // call at a time (sequential round-trips), so in practice this holds at most one
      // entry for the few-hundred-ms window between the two events - a real TTL/cleanup
      // isn't warranted unless that assumption changes.
      unmatchedConfirmRequests.push({safety_review_name: safety_review_name, data: data});
      return true;  // claimed - this live widget WILL render it once the card arrives
    }
    applyConfirmUI(pending.statusEl, safety_review_name, data);
    return true;
  }

  timelineConfirmHandlers.push(handleConfirmRequest);

  addOutputListener(name, 6, function(data) {
    // compaction_start/compaction_end (agent_loop.py's _trim_history_to_budget(), broadcast
    // directly via self.output() rather than _emit_timeline() - see that call site's own
    // comment: it runs in process(), before _run_turn() exists or has a turn_id/round to tag
    // this with) - deliberately handled here, standalone, rather than folded into the
    // turn_id/round-keyed cardsByTurnRound system the rest of this listener uses, since this
    // event has neither. Always paired (compaction_end fires even on a summarization failure,
    // see _trim_history_to_budget()'s own finally block), and always completes before this
    // same turn's OutputHistory broadcast empties #${history_id} (compaction runs synchronously
    // inside process() before _broadcast_turn_result()) - so there is no race with the chat
    // history's own DOM rebuild.
    if (data['event'] === 'compaction_start') {
      const indicator_id = `${history_id}_compaction_indicator`;
      if (!document.getElementById(indicator_id)) {
        withAutoScroll(function() {
          const el = document.createElement('div');
          el.id = indicator_id;
          el.className = 'chat-message-bot mb-3 compaction-indicator';
          el.textContent = chatWord('compacting', 'Tidying up the conversation history...');
          document.getElementById(history_id).appendChild(el);
        });
      }
      return;
    }
    if (data['event'] === 'compaction_end') {
      const el = document.getElementById(`${history_id}_compaction_indicator`);
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    if (data['event'] === 'turn_snapshot') {
      ensureContainer().innerHTML = '';
      clearStreamingText();
      cardsByTurnRound = {};
      segmentSeqByRound = {};
      openCardKeyByRound = {};
      lastToolCallKeyByRound = {};
      pendingCardQueue = [];
      unmatchedConfirmRequests = [];
      replaying = true;
      try {
        data['events'].forEach(function(ev) {
          if (ev['event'] === 'tool_call_pending') renderToolCallPending(ev);
          else if (ev['event'] === 'tool_call_resolved') renderToolCallResolved(ev);
          else renderSegmentEvent(ev);
        });
      } finally {
        replaying = false;
      }
      return;
    }
    if (data['event'] === 'turn_error') {
      stopStatus();
      // I3 (final whole-branch review): previously only added timeline-card-error, which the
      // CSS only visually distinguished when COMBINED with timeline-card-done (see chat.css's
      // .timeline-card-done.timeline-card-error) - an interrupted, still-running card got no
      // visible change at all, and data['message'] was never shown anywhere. Now
      // .timeline-card-error alone has its own rule (see chat.css), and the message is
      // written into each affected card so the interruption is actually explained.
      Object.values(cardsByTurnRound).forEach(function(c) {
        c.el.classList.add('timeline-card-error');
        if (!c.el.querySelector('.timeline-error-message')) {
          const errEl = document.createElement('div');
          errEl.className = 'timeline-error-message';
          errEl.textContent = data['message'] || chatWord('chatError', 'Something went wrong');
          c.el.appendChild(errEl);
        }
      });
      return;
    }
    if (data['event'] === 'segment_discard') {
      // harness: a failed generation is being retried - drop that round's cards and the
      // streamed text so the failed attempt doesn't stay on screen next to the retry.
      const rk = roundKey(data);
      Object.keys(cardsByTurnRound).forEach(function(key) {
        if (key.startsWith(rk + ':')) {
          const c = cardsByTurnRound[key];
          if (c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el);
          delete cardsByTurnRound[key];
        }
      });
      delete segmentSeqByRound[rk];
      delete openCardKeyByRound[rk];
      delete lastToolCallKeyByRound[rk];
      clearStreamingText();
      return;
    }
    if (data['event'] === 'tool_call_pending') renderToolCallPending(data);
    else if (data['event'] === 'tool_call_resolved') renderToolCallResolved(data);
    else renderSegmentEvent(data);
  });

  // A second listener on the SAME plugin name's channel 3 (in addition to the one
  // addChatWidget_no_input_history3() already registered for updateChatHistory() - both live
  // in outputListeners[name][3]'s array and both run, in push order, whenever AgentLoop
  // broadcasts OutputHistory - see addOutputListener()'s per-channel array). By the time this
  // one runs, updateChatHistory()'s own listener (registered first) has already emptied and
  // rebuilt #${history_id} - see handleTextSegment()'s comment above for why that alone
  // already removes our timeline container and any live streaming-text node from the DOM.
  // This just resets the JS-side bookkeeping so it doesn't keep referencing those now-
  // detached nodes into the next turn.
  addOutputListener(name, 3, function(history) {
    // AgentLoop broadcasts history when a turn starts (last entry = the user's message) and
    // when it ends (answer or error appended) - drives the status bar.
    const last = (history && history.length) ? history[history.length - 1] : null;
    if (last && last['role'] === 'user') startStatus();
    else stopStatus();
    cardsByTurnRound = {};
    segmentSeqByRound = {};
    openCardKeyByRound = {};
    lastToolCallKeyByRound = {};
    pendingCardQueue = [];
    unmatchedConfirmRequests = [];
    streamingTextEl = null;
    streamingTurnId = null;
  });

  msg = {};
  msg[name] = {'request_timeline_snapshot': {}};
  sendWebsocket(msg);
}

// The AgentLoop chat (history on output 3, live timeline on output 6, status bar) in any container;
// grid.js's addChatWidget_no_input_history3() and the kiosk both use it (spec 2026-10-20-kiosk-display §2.3).
function mountAgentLoopChat(container, name, id, type, opts = {}) {
  const history_id = `${id}_history`;
  const agentLoop = (type === 'AgentLoop');
  container.innerHTML = `
    <div class="chat-history-wrap mb-2">
      <div id="${history_id}" class="bg-medium-gray p-2 chat-history${agentLoop ? ' agentloop-chat' : ''}" style="font-size: 100%; overflow-y: scroll;"></div>
      <button id="${history_id}_jump" type="button" class="chat-jump-latest" style="display: none;">${chatWord('jumpLatest', '↓ Latest')}</button>
      ${agentLoop ? `<div id="${history_id}_status" class="agentloop-status" style="display: none;"></div>` : ''}
    </div>` + (opts.input ? `
    <div class="input-group chat-input">
      <textarea id="${id}_input" class="form-control" rows="1" placeholder="${opts.placeholder || 'Type a question, Enter to send'}"></textarea>
      <button id="${id}_submit" type="button" class="chat-send">${chatWord('send', 'Send ➤')}</button>
    </div>` : '');
  setupChatFollow(history_id);
  addOutputListener(name, 3, function(history) { updateChatHistory(history_id, history); });
  sendWebsocket({[name]: {'input': []}});
  if (agentLoop) addAgentLoopTimeline(name, history_id, type);
  if (opts.input) {
    const input = document.getElementById(`${id}_input`);
    const send = () => { if (input.value.trim()) sendWebsocket({[opts.input]: {'input': input.value}}); input.value = ''; };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { if (!e.repeat) send(); e.preventDefault(); } });
    document.getElementById(`${id}_submit`).addEventListener('click', send);
  }
  return history_id;
}

if (typeof module !== 'undefined')
  module.exports = {summarizeToolArgs, TOOL_STATUS_LABELS, escapeHTML, chatWord};
