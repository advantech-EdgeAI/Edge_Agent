
// https://www.geeksforgeeks.org/how-to-include-a-javascript-file-in-another-javascript-file/
function include(file) {
    let script = document.createElement('script');
    
    script.src = file;
    script.type = 'text/javascript';
    script.defer = true;
 
    document.getElementsByTagName('head').item(0).appendChild(script);
}

// include('https://cdnjs.cloudflare.com/ajax/libs/gridstack.js/10.1.2/gridstack-all.min.js');
// include('https://cdn.jsdelivr.net/gh/jerosoler/Drawflow/dist/drawflow.min.js');
include('/static/gridstack-all.min.js');
include('/static/drawflow.min.js');


// include('/static/jquery-3.6.3.min.js');
// include('/static/bootstrap.bundle.min.js');
// include('/static/select2.min.js');
        
include('/static/webrtc.js');
include('/static/websocket.js');
include('/static/debounce.js');
include('/static/dialog_options.js');
include('/static/audio.js');
include('/static/markdown.js');
include('/static/perf_monitor.js');
include('/static/event_log.js');
include('/static/object_tracker.js');
include('/static/track_boxes.js');
include('/static/output_bus.js');
include('/static/chat_view.js');
include('/static/grid.js');
include('/static/menu.js');
include('/static/alert.js');

// Dual-screen exhibition display (2026-09-19): ?view=sensor (old name ?view=camera) shows only the widgets
// that render a live picture; ?view=pipeline shows everything else (node graph,
// chat, controls). No 'view' param (the everyday single-screen dev URL) leaves
// viewMode null, and every view-mode check below treats that as "show everything,
// stay fully interactive" - today's existing behavior, completely unchanged. See
// docs/superpowers/specs/2026-09-19-dual-screen-exhibition-display-design.md.
// Sensor view: docs/superpowers/specs/2026-10-13-sensor-view-design.md.
var _viewParams = new URLSearchParams(window.location.search);
var viewMode = normalizeViewMode(_viewParams.get('view'));   // sensor_view.js (?view=camera -> 'sensor')
var viewEditUnlocked = (_viewParams.get('edit') === '1');


function loadStudio(config) {
  connectWebsocket(onWebsocketMsg, port=config.ws_port);
        
  enumerateAudioDevices();
  openAudioDevices();
  enumerateVideoDevices();

  addGrid();

  // the booth screen shows only the logo; &edit=1 brings the menus back with drag/resize
  if( viewMode === 'sensor' && !viewEditUnlocked )
    document.body.classList.add('sensor-locked');
  if( viewMode !== 'pipeline' )
    startSensorSignalWatch();   // sensor_view.js

  //setTimeout( ()=>{ debugger }, 5000);
}

function onWebsocketMsg(payload, type, metadata) {
  // Route JPEG video frames before JSON handling (binary fast path)
  if( type == MESSAGE_VIDEO_FRAME ) {
    if( typeof onVideoFrameReceived === 'function' )
      onVideoFrameReceived(payload, metadata);
    return;
  }

  if( type == MESSAGE_JSON ) {
    if( 'modules' in payload ) {
      addModules(payload['modules']);
    }
    
    if( 'plugin_types' in payload ) {
      addPluginTypes(payload['plugin_types']);
    }
    
    if( 'plugin_added' in payload ) {
      addPlugins(payload['plugin_added']);
    }
    
    if( 'plugin_connected' in payload ) {
      connectPlugins(payload['plugin_connected']);
    }
    
    if( 'plugin_removed' in payload ) {
      removePlugins(payload['plugin_removed']);
    }
    
    if( 'send_output' in payload ) {
      sendOutput(payload['send_output']);
    }
    
    if( 'state_dict' in payload ) {
      setStateDict(payload['state_dict']);
    }
    
    if( 'stats' in payload ) {
      setStats(payload['stats']);
    }
    
    if( 'presets' in payload ) {
      setPresets(payload['presets']);
    }

    if( 'current_preset' in payload ) {
      setCurrentPreset(payload['current_preset']);
    }

    if( 'alert' in payload ) {
      addAlert(payload['alert']);
    }
  }
  else if( type == MESSAGE_AUDIO ) {
    onAudioOutput(payload);
  }
}

function removeAll(name) {
  // Restart into an empty pipeline instead of removing every plugin in place, which hung
  // the whole process on 2026-10-15 (docs/superpowers/specs/2026-10-15-studio-self-recovery-design.md sec. 5).
  sendWebsocket({'restart_empty': {}});
  showReloadMessage();
  pollForReload();
}

function clearCache(name) {
  sendWebsocket({'clear_cache': {}});
}

function savePreset(name) {
  sendWebsocket({'save': name});
}

function setCurrentPreset(name) {
  // Default the Save dialogs to overwriting the preset that's actually loaded,
  // instead of always offering the hardcoded "MyAgent" placeholder. Leave the
  // fields alone when nothing is loaded (a fresh/discarded pipeline) so they
  // keep their existing value rather than showing a blank or stale name.
  if( !name )
    return;

  const saveAgentName = document.getElementById('saveAgentName');
  if( saveAgentName )
    saveAgentName.value = name;

  const saveasAgentName = document.getElementById('saveasAgentName');
  if( saveasAgentName )
    saveasAgentName.value = name;
}

function loadPreset(name) {
  // Full pipeline replacement restarts the whole process (like New -> Discard)
  // instead of hot-swapping in place, then auto-loads this preset once the
  // fresh process comes back up. See dynamic_agent.py restart_and_load() for why.
  // (showReloadMessage/pollForReload are defined in studio.html)
  sendWebsocket({'restart_and_load': name});
  showReloadMessage();
  pollForReload();
}

function insertPreset(name, context=true) {
  if( context ) {
    sendWebsocket({
      'insert': {
        'path': name, 
        'layout_node': nodeLayoutInsertPos()
      }
    });
  }
  else {
    sendWebsocket({'insert': name});
  }
}

function setPresets(presets) {
  console.log('setting presets list', presets);
  
  let load_menu = $('#navbarLoadAgentMenu');
  let insert_menu = $('#navbarInsertAgentMenu');
  let context_menu = $('#plugin_context_menu_presets');
  
  load_menu.empty();
  insert_menu.empty();
  context_menu.empty();
  
  presets.forEach((preset) => {
    load_menu.append(`<li><a class="dropdown-item" href="#" onclick="loadPreset('${preset}')">${preset}</a></li>`);
    insert_menu.append(`<li><a class="dropdown-item" href="#" onclick="insertPreset('${preset}')">${preset}</a></li>`);
    context_menu.append(`<li><a class="dropdown-item" href="#" onclick="insertPreset('${preset}', true)">${preset}</a></li>`);
  });
}
