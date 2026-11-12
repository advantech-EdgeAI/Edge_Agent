// Output and state subscriptions from the websocket (send_output / state_dict), shared by Studio's
// grid.js and the kiosk pages (docs/superpowers/specs/2026-10-20-kiosk-display-design.md §2.3).
// Moved from grid.js unchanged.
var stateListeners = {};
var outputListeners = {};

function addOutputListener(name, channel, listener) {
  // outputListeners[name] is keyed by channel (not a flat listener array) so that a single
  // plugin name broadcasting on more than one channel to the same browser session - e.g.
  // AgentLoop's 'history' (channel 3, consumed by addChatWidget_no_input_history3) and
  // 'timeline' (channel 6, consumed by addAgentLoopTimeline(), added 2026-09-12) - gets a
  // send_client_output subscription message PER CHANNEL, and sendOutput() below dispatches
  // each incoming message only to the listeners registered for its own channel. Before this,
  // a second addOutputListener() call for an already-seen `name` (regardless of channel) took
  // the else-branch and silently skipped sending 'send_client_output' for the new channel -
  // every single existing call site only ever used one channel per name so this never
  // surfaced, but it meant AgentLoop's channel-6 subscription was never actually requested,
  // AND (once it were) channel-3 history payloads would misroute into the channel-6 listener
  // and vice versa - a timeline event object landing in updateChatHistory(id, history) as
  // `history` has `history.length === undefined`, so `for (let n=0; n < history.length; n++)`
  // never runs, but `chj.empty()` above that loop still fires - it would silently blank the
  // chat bubble area on every live timeline event during generation.
  if( ! (name in outputListeners) )
    outputListeners[name] = {};

  const isNewChannel = ! (channel in outputListeners[name]);

  if( isNewChannel )
    outputListeners[name][channel] = [];

  outputListeners[name][channel].push(listener);

  if( isNewChannel ) {
    msg = {};
    msg[name] = {'send_client_output': channel};
    sendWebsocket(msg);
  }
}

function sendOutput(output) {
  const plugin_name = output['name'];
  const channel = output['channel'];
  // each listener on its own: one that throws must not hide the event from the rest (2026-11-05: the
  // kiosk's Tools_Hub stayed "running" in Firefox, its tool_call_resolved never reached onAgentEvent)
  if( plugin_name in outputListeners && channel in outputListeners[plugin_name] )
    outputListeners[plugin_name][channel].forEach((listener) => {
      try {
        listener(output['data']);
      } catch (e) {
        console.error(`output listener for ${plugin_name} channel ${channel} failed:`, e);
      }
    });
}

function addStateListener(name, listener) {
  if( name == undefined )
    name = 'all';
    
  if( ! (name in stateListeners) )
    stateListeners[name] = [listener];
  else
    stateListeners[name].push(listener);
}

if (typeof module !== 'undefined')
  module.exports = {addOutputListener, sendOutput, addStateListener};
