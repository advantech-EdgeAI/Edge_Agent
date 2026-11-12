
var grid;
var drawflow;

// Which widgets the sensor view (the old ?view=camera) shows: SENSOR_WIDGET_TYPES and
// isSensorWidget() in sensor_view.js (docs/superpowers/specs/2026-10-13-sensor-view-design.md §2.2).

var pluginTypes;
var moduleTypes;
var nodeIdToName = {};
var videoFrameListeners = {};  // plugin_name -> callback(ArrayBuffer)
var suppressGridAdded = false;   // suppress 'added' events during batch plugin init
var widgetsPlacedFromSave = new Set();   // ids being added at a saved position (see addGridWidget)
var suppressGridRemoved = false; // suppress 'removed' events during programmatic plugin removal
var webVideoInPlugins = new Set();  // names of WebVideoIn plugins currently on the graph (see audio.js setWebVideoInCount())


// Called by studio.js onWebsocketMsg when a MESSAGE_VIDEO_FRAME arrives.
// metadata = first 8 chars of plugin name (null-padded ASCII from server).
function onVideoFrameReceived(frameData, metadata) {
  for (const [pluginName, listener] of Object.entries(videoFrameListeners)) {
    // Match on prefix: server encodes up to 8 chars of the plugin name
    if (!metadata || pluginName.startsWith(metadata) || metadata.startsWith(pluginName.substring(0, 8))) {
      listener(frameData);
      sensorSignalSeen(pluginName);   // sensor_view.js: clears "Signal lost"
      return;
    }
  }
  // Fallback: single registered listener
  const keys = Object.keys(videoFrameListeners);
  if (keys.length === 1) {
    videoFrameListeners[keys[0]](frameData);
    sensorSignalSeen(keys[0]);
  }
}
var ignoreGraphEvents=false;

function customizeNode(plugin_name, color = '#add8e6', label = 'Advantech', labelWidth = '60px', labelHeight = '20px', fontSize = '10px') {
  // Find the node with the specified plugin_name
  const targetNode = document.querySelector(`.${plugin_name}`);
  if (targetNode) {
    // Change the node's background color
    targetNode.style.backgroundColor = color; 
    
    // Create a small node at the top-left corner
    const labelNode = document.createElement('div');
    labelNode.innerHTML = label; // Set the label content
    labelNode.style.position = 'absolute'; // Use absolute positioning
    labelNode.style.top = '-20px'; // Position relative to the parent node
    labelNode.style.left = '0px';  // Align to the top-left corner
    labelNode.style.width = labelWidth; // Set the small node's width
    labelNode.style.height = labelHeight; // Set the small node's height
    labelNode.style.backgroundColor = '#000'; // Set the small node's background color to black
    labelNode.style.color = '#fff'; // Set the text color to white
    labelNode.style.fontSize = fontSize; // Set the font size
    labelNode.style.padding = '2px 4px'; // Add padding inside the label
    labelNode.style.borderRadius = '3px'; // Add rounded corners
    labelNode.style.display = 'flex'; // Use flexbox to center the text
    labelNode.style.alignItems = 'center'; // Vertically center the text
    labelNode.style.justifyContent = 'center'; // Horizontally center the text
    targetNode.appendChild(labelNode); // Append the small node to the main node
  }
}


function addGrid() {
  grid = GridStack.init({'column': 12, 'cellHeight': 50, 'float': true});

  // Dual-screen exhibition display (2026-09-19): the camera-only kiosk screen is
  // locked against drag/resize by default so booth visitors can't rearrange it -
  // use ?view=camera&edit=1 during setup to unlock it temporarily, then drop
  // &edit=1 again before the show. ?view=pipeline and the everyday no-param URL
  // stay fully interactive, exactly like today.
  if( viewMode === 'sensor' && !viewEditUnlocked ) {
    grid.enableMove(false);
    grid.enableResize(false);
  }

  grid.on('added', function(event, items) {
    // Suppress during batch load: server-saved positions (restored via get_state_dict)
    // are authoritative. Letting GridStack's auto-placement overwrite them causes
    // position drift every container restart.
    if (!items || suppressGridAdded) return;
    items.forEach((item) => {
      if (widgetsPlacedFromSave.has(item.id))
        return;                                         // placed from a saved position: nothing new
      console.log(`grid widget ${item.id} was added`, item);
      sendWebsocket({
        'config_plugin': {
          'name': item.id,
          [layoutKey(viewMode)]: {'x': item.x, 'y': item.y, 'w': item.w, 'h': item.h}   // sensor_view.js
      }});
    });
  });

  // Only a drag or resize by the user saves positions. GridStack also fires 'change' when it pushes
  // widgets out of an overlap - e.g. the no-param page shows the sensor view's and the pipeline
  // view's widgets together, and those two layouts share coordinates on purpose - and those pushed
  // positions used to overwrite the saved ones (2026-10-14).
  let userLayoutEdits = 0;
  grid.on('dragstart resizestart', function() { userLayoutEdits++; });
  grid.on('dragstop resizestop', function() {
    setTimeout(() => { userLayoutEdits = Math.max(0, userLayoutEdits - 1); }, 0);   // after 'change'
  });

  grid.on('change', function(event, items) {
    if (!items) return;  // guard against bubbled DOM events (e.g. <select> change)
    if (userLayoutEdits === 0) {
      console.log('grid layout changed without a user drag/resize (overlap, late update) - not saved');
      return;
    }
    // in a view, every widget on it is saved (not just the moved ones): the first edit snapshots the
    // whole view, so it no longer follows layout_grid / the no-param page
    const changed = viewMode ? grid.engine.nodes : items;
    changed.forEach((item) => {
      console.log(`grid widget ${item.id} changed position/size`, item);
      sendWebsocket({
        'config_plugin': {
          'name': item.id,
          [layoutKey(viewMode)]: {'x': item.x, 'y': item.y, 'w': item.w, 'h': item.h}
      }});
    });
  });

  grid.on('removed', function(event, items) {
    if (!items || suppressGridRemoved) return;
    items.forEach((item) => {
      console.log(`grid widget ${item.id} has been removed`, item);
      sendWebsocket({
        'config_plugin': {
          'name': item.id,
          [layoutKey(viewMode)]: {}             // closed on this view only
      }});
    });
  });
  
  
  /*grid.on('resize', function(event, el) {
    fitGridWidgetContents(el);
  });*/

  /*addGraphEditor();

  drawflow = new Drawflow(document.getElementById("drawflow"));
  drawflow.start();
  
  drawflow.on('connectionCreated', onNodeConnectionCreated);
  drawflow.on('connectionRemoved', onNodeConnectionRemoved);*/
}

function addGridWidget(id, title, html, titlebar_html, grid_options) {
  const plugin = id.includes('_grid') ? id.replace('_grid', '') : id;

  if( document.getElementById(id) ) {
    console.log(`grid widget ${id} already exists, skipping duplicate`);
    return document.querySelector(`.grid-stack-item[gs-id="${plugin}"]`);
  }

  if( grid_options == undefined )
      grid_options = {w: 3, h: 3};

  if( titlebar_html != undefined )
      titlebar_html = `<span class="float-top">${titlebar_html}</span>`;
   
  let title_html = '';
  
  if( title != undefined || titlebar_html != undefined ) {
    title_html += `<span class="mb-2">`;
    
    if( title != undefined )
      title_html += `<h5 class="d-inline">${title}</h5>`;

    title_html += `<button id="${id}_close" type="button" class="btn-close float-end float-top ms-2" aria-label="Close"></button>`;
    
    if( document.getElementById(`${title}_config_dialog`) != null )
      title_html += `<i id="${id}_show_config" class="fa fa-cog float-end gear-button" aria-hidden="true"></i>`;
    
    if( titlebar_html != undefined )
      title_html += titlebar_html;

    title_html += `</span>`;
  }    
  //  position: absolute; right: 15px;
  /*let card_html = `
  <div class="card ms-1 mt-1">
    <div class="card-body d-flex flex-column h-100">
      <div class="card-title" data-bs-toggle="collapse" href="${id}" role="button">
        <h5 class="d-inline">${title}</h5>
        <span class="float-end float-top fa fa-chevron-circle-down fa-lg mt-1 ms-1 me-1" data-bs-toggle="collapse" href="#${id}" id="${id}_collapse_btn" title="Minimize"></span>
        ${titlebar_html}
      </div>
      <div class="collapse show d-flex flex-column h-100" id="${id}">
          ${html}
      </div>
    </div>
  </div>
  `;*/

  let card_html = `
  <div class="card" id="${id}">
    <div class="card-body d-inline-flex flex-column h-100">
      ${title_html}
      ${html}
    </div>
  </div>
  `;
  
  if( ! ('id' in grid_options) )
    grid_options['id'] = plugin;

  // created at its saved place: GridStack's 'added' (fired inside addWidget) must not save it again
  if( placedFromSave(grid_options) )
    widgetsPlacedFromSave.add(grid_options['id']);
  const widget = grid.addWidget(card_html, grid_options);
  widgetsPlacedFromSave.delete(grid_options['id']);
  
  console.log(`created grid widget id=${id} title=${title}`, widget);
  
  let btn_close = document.getElementById(`${id}_close`);
  
  if( btn_close != undefined ) {
      btn_close.addEventListener('click', function(e) {
      grid.removeWidget(widget);
    });
  }
  
  let btn_config = document.getElementById(`${id}_show_config`);
  
  if( btn_config != undefined ) {
      btn_config.addEventListener('click', function(e) {
        sendWebsocket({'get_state_dict': title});
        const config_modal = new bootstrap.Modal(`#${title}_config_dialog`);
        config_modal.show();
    });
  }
  
  addStateListener(plugin, function(state_dict) {
    const lg = pickLayout(state_dict, viewMode);    // this view's own position, else layout_grid
    // A delayed state_dict response (e.g. a redundant plugin_added resend
    // triggered by another client reconnecting - see CLAUDE.md on the multi-
    // client broadcast) can arrive after this widget was already removed from
    // the grid (camera view removes GraphEditor's widget right after creating
    // it). grid.update() on a detached widget still re-registers it with
    // GridStack's layout engine at its saved position, which can then collide
    // with and displace whatever real widget now occupies that space - found
    // live 2026-09-22 as the cause of camera-view video widgets "falling"
    // whenever the pipeline-view page reloaded. Only apply the update if the
    // widget is still actually attached to the page.
    if( lg && Object.keys(lg).length > 0 && document.body.contains(widget) ) {
      console.log(`updating ${plugin} grid widget`, lg);
      grid.update(widget, lg);
    }
  });
  
  sendWebsocket({'get_state_dict': plugin});
  return widget;
} 

function addTextInputWidget(name, id, title, grid_options) {
  const input_id = `${id}_input`;
  const submit_id = `${id}_submit`;
  
  const html = `
    <div class="input-group">
      <textarea id="${input_id}" class="form-control" rows="2" placeholder="Enter to send (Shift+Enter for newline)"></textarea>
      <span id="${submit_id}" class="input-group-text bg-light-gray bi bi-arrow-return-left" style="color: #eeeeee;"></span>
    </div>
  `;
  
  let widget = addGridWidget(id, null, html, null, Object.assign({w: 4, h: 2}, grid_options));

  let onsubmit = function() {
    const input = document.getElementById(input_id);
    console.log('submitting text input', input.value);
    msg = {}
    msg[name] = {'input': input.value};
    sendWebsocket(msg);
    input.value = "";
  }
  
  let onkeydown = function(event) {
    // https://stackoverflow.com/a/49389811
    if( event.which === 13 && !event.shiftKey ) {
      if( !event.repeat )
        onsubmit();
      event.preventDefault(); // prevents the addition of a new line in the text field
    }
  }

  document.getElementById(input_id).addEventListener('keydown', onkeydown);
  document.getElementById(submit_id).addEventListener('click', onsubmit);

  return widget;
}


// Global object to track listeners
const stateListenerRegistry = {};

// Modified addTextStreamWidget function
function addTextStreamWidget(name, id, title, grid_options) {
 const history_id = `${id}_history`;
 const html = `
   <div id="${history_id}" class="bg-medium-gray p-2 mb-2" style="font-family: monospace, monospace; font-size: 100%; overflow-y: scroll; flex-grow: 1;"</div>
 `;
 
 // Clear old listeners if they exist
 if (stateListenerRegistry[name]) {
   // Assuming there is a removeStateListener function
   // If not, you need to implement it or modify addStateListener logic
   removeStateListener(name, stateListenerRegistry[name]);
   delete stateListenerRegistry[name];
   console.log(`Cleared old listener for ${name}`);
 }
 
 let widget = addGridWidget(id, title, html, null, Object.assign({w: 4, h: 6}, grid_options));
 
 // Create new listener and save reference
 const listener = function(state_dict) {
   if (!('text' in state_dict))
     return;
   
   let el_type = 'p';  
   
   if ('delta' in state_dict)
     el_type = 'span';
   let chc = document.getElementById(history_id);
   if (!chc) {
     console.log(`Element ${history_id} doesn't exist, might have been deleted`);
     return;
   }
   
   let isScrolledToBottom = chc.scrollHeight - chc.clientHeight <= chc.scrollTop + 1;

   // appendChild (not innerHTML +=) - a growing innerHTML += re-serializes and
   // re-parses the ENTIRE accumulated history on every single update, which is
   // fine for occasional chat-style bursts but becomes O(n^2) and eventually
   // freezes the tab against a continuous high-rate source (e.g. AutoLabeler
   // pushing 20-30 detection messages/sec) - see docs/superpowers/specs/
   // 2026-08-27-auto-labeling-pipeline-design.md.
   const el = document.createElement(el_type);
   el.style.color = state_dict['color'];
   // innerHTML here is on a single new (small) element, not the accumulating
   // history container - state_dict['text'] arrives pre-escaped from
   // TextStream.process() (nano_llm/plugins/llm/text_stream.py) with '\n'
   // deliberately converted to a literal '<br/>' tag for rendering,
   // so this must stay innerHTML, not textContent, or multi-line messages
   // would show a literal "<br/>" instead of a line break.
   el.innerHTML = state_dict['text'];
   chc.appendChild(el);

   // Cap retained history so long-running continuous streams (auto-labeling,
   // any future high-rate TextStream consumer) don't grow the DOM without
   // bound even with appendChild - drop the oldest entries once there are
   // too many to keep rendering/scroll performance bounded.
   const MAX_HISTORY_ENTRIES = 300;
   while (chc.childNodes.length > MAX_HISTORY_ENTRIES) {
     chc.removeChild(chc.firstChild);
   }

   if (isScrolledToBottom) { // Auto-scroll unless user has scrolled up
     scrollBottom(chc);
   }
 };
 
 // Register listener and save reference
 addStateListener(name, listener);
 stateListenerRegistry[name] = listener;
 
 // Clear listener when widget is removed
 widget.onRemove = function() {
   if (stateListenerRegistry[name]) {
     removeStateListener(name, stateListenerRegistry[name]);
     delete stateListenerRegistry[name];
     console.log(`Cleared listener for ${name} when widget ${id} was removed`);
   }
 };
 
 return widget;
}

function addDatasetCollectorControlWidget(name, id, title, grid_options) {
  const status_id = `${id}_status`;
  const html = `
    <div class="p-2">
      <button id="${id}_start" class="btn btn-success btn-sm me-2">Start</button>
      <button id="${id}_stop" class="btn btn-danger btn-sm">Stop</button>
      <p id="${status_id}" class="mt-2 mb-0 text-muted"></p>
    </div>
  `;
  let widget = addGridWidget(id, title, html, null, Object.assign({w: 3, h: 3}, grid_options));

  $(`#${id}_start`).on('click', function() {
    sendWebsocket({[name]: {'start_collecting': {}}});
    document.getElementById(status_id).textContent = 'Collecting...';
  });

  $(`#${id}_stop`).on('click', function() {
    sendWebsocket({[name]: {'stop_and_package': {}}});
    document.getElementById(status_id).textContent = 'Packaging...';
  });

  return widget;
}

function addDatasetLoaderWidget(name, id, title, grid_options) {
  const status_id = `${id}_status`;
  const html = `
    <div class="p-2">
      <input type="file" id="${id}_picker" webkitdirectory multiple class="form-control form-control-sm mb-2">
      <button id="${id}_start" class="btn btn-primary btn-sm" disabled>Start Labeling</button>
      <p id="${status_id}" class="mt-2 mb-0 text-muted"></p>
    </div>
  `;
  let widget = addGridWidget(id, title, html, null, Object.assign({w: 3, h: 3}, grid_options));

  let uploaded_dir = null;

  $(`#${id}_picker`).on('change', async function(evt) {
    const files = evt.target.files;
    const status = document.getElementById(status_id);
    status.textContent = `Uploading ${files.length} file(s)...`;
    $(`#${id}_start`).prop('disabled', true);

    const form = new FormData();
    for (const f of files)
      form.append('files', f, f.name);

    try {
      const resp = await fetch('/upload_dataset', {method: 'POST', body: form});
      const data = await resp.json();
      uploaded_dir = data.dir;
      // data.count is what the server actually staged to disk - not files.length
      // (what the browser sent) - so a collision-driven rename (or any other reason
      // a file didn't end up staged 1:1) never silently misreports the count.
      status.textContent = `${data.count} file(s) uploaded. Ready to start.`;
      $(`#${id}_start`).prop('disabled', false);
    } catch (err) {
      status.textContent = `Upload failed: ${err}`;
      console.error('dataset upload failed', err);
    }
  });

  $(`#${id}_start`).on('click', function() {
    if (!uploaded_dir)
      return;
    sendWebsocket({'DatasetCollector': {'start_collecting': {}}});
    sendWebsocket({[name]: {'start_batch': uploaded_dir}});
    document.getElementById(status_id).textContent = 'Labeling in progress...';
    $(`#${id}_start`).prop('disabled', true);
  });

  return widget;
}

// If you don't have a removeStateListener function, you can implement it like this
function removeStateListener(name, listener) {
 // Implementation depends on how your addStateListener works
 // This is just an example
 if (typeof window.stateListeners === 'undefined') {
   window.stateListeners = {};
 }
 
 if (window.stateListeners[name]) {
   const index = window.stateListeners[name].indexOf(listener);
   if (index !== -1) {
     window.stateListeners[name].splice(index, 1);
     console.log(`Removed listener from ${name}`);
   }
 }
}
function terminalTextColor(level) {
    if( level == 'success' ) return 'limegreen';
    else if( level == 'error' ) return 'red';
    else if( level == 'warning' ) return 'orange';
    else if( level == 'info' ) return 'rgb(225,225,225)'
    else return 'rgb(180,180,180)';
}
        
function addTerminalWidget(name, id, title, grid_options) {
  const history_id = `${id}_history`;

  const html = `
    <div style="display:flex; justify-content:flex-end; margin-bottom:4px;">
      <button onclick="(function(){
        var txt = document.getElementById('${history_id}').innerText;
        navigator.clipboard.writeText(txt).then(function(){
          var btn = document.querySelector('#${history_id}').previousElementSibling.querySelector('button');
          var orig = btn.textContent; btn.textContent='Copied!';
          setTimeout(function(){btn.textContent=orig;}, 1500);
        });
      })()" style="font-size:12px; padding:2px 8px; cursor:pointer;">Copy</button>
    </div>
    <div id="${history_id}" class="bg-medium-gray p-2 mb-2" style="font-family: monospace, monospace; font-size: 100%; overflow: scroll; text-wrap: nowrap; flex-grow: 1; user-select: text !important;"></div>
  `;

  let widget = addGridWidget(id, 'Terminal', html, null, Object.assign({x: 0, y: 11, w: 8, h: 6}, grid_options));

  addOutputListener(name, 0, function(log_entry) {
    let chc = document.getElementById(history_id);
    let isScrolledToBottom = chc.scrollHeight - chc.clientHeight <= chc.scrollTop + 1;
    
    const level = log_entry['level'];
    const msg = log_entry['message'];

    const html = `<p class="m-0 p-0" style="color: ${terminalTextColor(level)}">${escapeHTML(msg)}</p>`;
    
    if( chc.innerHTML.length < 10000 )
      chc.innerHTML += html;
    else
      chc.innerHTML = html;

    if( isScrolledToBottom ) { // autoscroll unless the user has scrolled up
      scrollBottom(chc);
    }
  });
  
  return widget;
}


function updateNanoDB(name, gallery_id, search_results) {
  const contextMenuId = `contextMenu_${gallery_id}`;

  // Don't re-render while context menu is open (would destroy it)
  if ($(`#${contextMenuId}`).is(':visible')) return;

  let obj = $(`#${gallery_id}`);
  let contents = '';

  // Create context menu with preview
  const contextMenuHTML = `
    <div id="${contextMenuId}" class="custom-context-menu" 
         style="display: none; position: absolute; background: white; border: 1px solid #ccc; box-shadow: 2px 2px 5px rgba(0,0,0,0.2); z-index: 1000; min-width: 200px;">
      <div class="menu-preview" style="padding: 8px; text-align: center; border-bottom: 1px solid #eee;">
        <img id="${contextMenuId}_preview" src="" style="max-width: 150px; max-height: 150px; object-fit: contain;">
      </div>
      <div class="menu-item update-item" style="padding: 8px 12px; cursor: pointer; color: #2196F3; border-bottom: 1px solid #eee;">
        Update Tag
      </div>
      <div class="menu-item delete-item" style="padding: 8px 12px; cursor: pointer; color: red;">
        Delete Image
      </div>
    </div>
  `;
  
  // First remove existing context menu if any
  $(`#${contextMenuId}`).remove();
  
  // Clear the gallery content
  obj.empty();
  
  // Generate image gallery
  for(let n=0; n < search_results.length; n++) {
    const result = search_results[n];
    const imageId = `img_${gallery_id}_${n}`;
    contents += `
    <div class="image-container me-1" style="position: relative; display: inline-block; width: 75%; aspect-ratio: 1.47; color: white;">
      <img id="${imageId}"
           src="${window.location.origin + '/' + result['metadata']['path']}" 
           style="width: 100%; height: 100%; object-fit: contain;" 
           title="&quot;METADATA&quot; : ${escapeHTML(JSON.stringify(result['metadata'], null, 2))}"
           data-path="${result['metadata']['path']}"
           data-tag="${result['metadata']['tag'] || ''}">
      <div class="ps-1 pe-1" 
           style="position: absolute; top: 0; right: 0; background-color: rgba(0,0,0,0.5); padding: 0.5em; font-size: 0.8em;">
        ${(search_results[n]['similarity'] * 100).toFixed(2)}%
      </div>
    </div>`;   
  }
  
  // Append gallery content
  obj.append(contents);
  
  // Add context menu to the gallery container
  obj.append(contextMenuHTML);
  
  // Bind right-click event
  obj.find('img').on('contextmenu', function(e) {
    e.preventDefault();
    const $contextMenu = $(`#${contextMenuId}`);
    const $preview = $(`#${contextMenuId}_preview`);
    const $imgContainer = $(this).closest('.image-container');
    
    // Save current image path and update preview
    $contextMenu.data('imagePath', $(this).data('path'));
    $contextMenu.data('currentTag', $(this).data('tag'));
    $preview.attr('src', $(this).attr('src'));
    
    // Calculate position relative to the image container
    const containerOffset = $imgContainer.offset();
    const galleryOffset = obj.offset();
    const containerWidth = $imgContainer.outerWidth();
    const menuWidth = 200; // Set a default width since menu might not be visible yet
    
    // Calculate position relative to the gallery
    let left = e.pageX - galleryOffset.left;
    let top = e.pageY - galleryOffset.top;
    
    // Adjust position if menu would overflow
    if (left + menuWidth > obj.width()) {
      left = left - menuWidth;
    }
    if (left < 0) {
      left = 0;
    }
    
    // Position and show the menu
    $contextMenu.css({
      top: top + 'px',
      left: left + 'px',
      display: 'block'
    });
    
    // Ensure menu is visible
    $contextMenu.show();
  });
  
  // Handle update action
  $(`#${contextMenuId} .update-item`).off('click').on('click', function() {
    const imagePath = $(`#${contextMenuId}`).data('imagePath');
    const currentTag = $(`#${contextMenuId}`).data('currentTag');
    
    const newTag = prompt('Enter new tag:', currentTag);
    if (newTag !== null && newTag !== currentTag) {
      // Send update command via websocket
      msg = {};
      msg[name] = {
        'update_tag': {
          'path': imagePath,
          'new_tag': newTag
        }
      };
      sendWebsocket(msg);
      
      // Update the tag in the UI
      obj.find(`img[data-path="${imagePath}"]`).data('tag', newTag);
    }
    $(`#${contextMenuId}`).hide();
  });
  
  // Handle delete action
  $(`#${contextMenuId} .delete-item`).off('click').on('click', function() {
    const imagePath = $(`#${contextMenuId}`).data('imagePath');
    if (confirm('Are you sure you want to delete this image?')) {
      // Find the image container you want to delete
      const $imageToDelete = obj.find(`img[data-path="${imagePath}"]`).closest('.image-container');
      
      // Immediately remove the image from the interface
      $imageToDelete.fadeOut(300, function() {
        $(this).remove();
      });
    
      // Send delete command via websocket
      msg = {};
      msg[name] = {'delete_image': imagePath};
      sendWebsocket(msg);
    }
    $(`#${contextMenuId}`).hide();
  });
  
  // Close context menu when clicking elsewhere
  $(document).off('click.contextMenu').on('click.contextMenu', function(e) {
    if (!$(e.target).closest('.custom-context-menu').length) {
      $(`#${contextMenuId}`).hide();
    }
  });
}

function addNanoDBWidget(name, id, title, grid_options) {
  const gallery_id = `${id}_results`;
  const input_id = `${id}_input`;
  const submit_id = `${id}_submit`;
  const nanodb_image_tags_input_id = `nanodb_image_tags_${id}_input`;
  const nanodb_image_tags_submit_id = `nanodb_image_tags_${id}_submit`;
  const tag_search_input_id = `${id}_tag_search`;
  const tag_search_submit_id = `${id}_tag_search_submit`;
  const clear_all_id = `${id}_clear_all`;

  const html = `
    <div style="margin-bottom: 15px;">
      <label for="${nanodb_image_tags_input_id}" style="display: block; margin-bottom: 5px; font-weight: bold; color: #eeeeee;">
        Insert
      </label>
      <div class="input-group">
        <input id="${nanodb_image_tags_input_id}" class="form-control" placeholder="Tag incoming feed"
          title="Enter description of the incoming image to tag and add to vector database"></input>
        <span id="${nanodb_image_tags_submit_id}" class="input-group-text bg-light-gray" style="color: #eeeeee;">Add</span>
      </div>
    </div>

    <div style="margin-bottom: 15px;">
      <label for="${input_id}" style="display: block; margin-bottom: 5px; font-weight: bold; color: #eeeeee;">
        Search by vision
      </label>
      <div class="input-group">
        <input id="${input_id}" class="form-control" placeholder="Enter a search query"></input>
        <span id="${submit_id}" class="input-group-text bg-light-gray bi bi-arrow-return-left" style="color: #eeeeee;"></span>
      </div>
    </div>

    <div style="margin-bottom: 15px;">
      <label for="${tag_search_input_id}" style="display: block; margin-bottom: 5px; font-weight: bold; color: #eeeeee;">
        Search by Tag
      </label>
      <div class="input-group">
        <input id="${tag_search_input_id}" class="form-control" placeholder="Enter tag to search"></input>
        <span id="${tag_search_submit_id}" class="input-group-text bg-light-gray" style="color: #eeeeee;">Search</span>
      </div>
    </div>

    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
      <label style="font-weight: bold; color: #eeeeee; margin: 0;">Results</label>
      <span id="${clear_all_id}" style="color: #ff6b6b; cursor: pointer; font-size: 0.8em; padding: 2px 8px; border: 1px solid #ff6b6b; border-radius: 4px;">Clear All</span>
    </div>
    <div id="${gallery_id}" class="bg-medium-gray p-2" style="font-size: 100%; overflow-y: scroll; flex-grow: 1;"
      ondrop="onFileDrop(event)" ondragover="onFileDrag(event)"></div>
  `;

  let widget = addGridWidget(id, title, html, null, Object.assign({w: 4, h: 10}, grid_options));

  // Tag submission function
  let tag_onsubmit = function() {
    const input = document.getElementById(nanodb_image_tags_input_id);
    const tagValue = input.value.trim();
    if (!tagValue) {
      alert("Please enter a tag before submitting!");
      return; 
    }
    console.log('submitting image and tag to NanoDB:', tagValue);
    msg = {};
    msg[name] = {'tag_image': tagValue};
    sendWebsocket(msg);
  }

  // Original search submit function
  let onsubmit = function() {
    const input = document.getElementById(input_id);
    console.log('submitting to NanoDB:', input.value);
    msg = {};
    msg[name] = {'input': input.value};
    sendWebsocket(msg);
  }

  // Tag search submit function
  let onTagSearch = function() {
    const input = document.getElementById(tag_search_input_id);
    const searchTag = input.value.trim();
    if (!searchTag) {
      alert("Please enter a tag to search!");
      return;
    }
    console.log('searching by tag:', searchTag);
    msg = {};
    msg[name] = {'search_tag': searchTag};
    sendWebsocket(msg);
  }
  
  let onkeydown = debounce(function(event) {
    if (!event.repeat) onsubmit();
  }, 100);

  // Add event listeners
  document.getElementById(input_id).addEventListener('keydown', onkeydown);
  document.getElementById(submit_id).addEventListener('click', onsubmit);
  document.getElementById(nanodb_image_tags_submit_id).addEventListener('click', tag_onsubmit);
  document.getElementById(tag_search_submit_id).addEventListener('click', onTagSearch);

  document.getElementById(clear_all_id).addEventListener('click', function() {
    if (confirm('Clear all images from this database? This cannot be undone.')) {
      msg = {};
      msg[name] = {'clear_all': true};
      sendWebsocket(msg);
    }
  });

  addOutputListener(name, 0, function(search_results) {
    updateNanoDB(name, gallery_id, search_results);
  });

  // Initial search
  msg = {};
  msg[name] = {'input': 'a polar bear swimming in the water'};
  sendWebsocket(msg);
  
  return widget;
}


function addChatWidget(name, id, title, grid_options) {
  const history_id = `${id}_history`;
  const input_id = `${id}_input`;
  const submit_id = `${id}_submit`;
  
  const html = `
    <div id="${history_id}" class="bg-medium-gray p-2 mb-2" style="font-size: 100%; overflow-y: scroll; flex-grow: 1;" ondrop="onFileDrop(event)" ondragover="onFileDrag(event)"></div>
    <div class="input-group">
      <textarea id="${input_id}" class="form-control" rows="1" placeholder="Enter to send (Shift+Enter for newline) &nbsp;&nbsp;&nbsp; [Commands: &nbsp; /reset /refresh]"></textarea>
      <span id="${submit_id}" class="input-group-text bg-light-gray bi bi-arrow-return-left" style="color: #eeeeee;"></span>
    </div>
  `;
  
  let widget = addGridWidget(id, title, html, null, Object.assign({w: 4, h: 14}, grid_options));

  let onsubmit = function() {
    const input = document.getElementById(input_id);
    console.log('submitting chat message:', input.value);
    msg = {};
    msg[name] = {'input': input.value};
    sendWebsocket(msg);
    input.value = "";
  }
  
  let onkeydown = function(event) {
    // https://stackoverflow.com/a/49389811
    if( event.which === 13 && !event.shiftKey ) {
      if( !event.repeat )
        onsubmit();
      event.preventDefault(); // prevents the addition of a new line in the text field
    }
  }

  document.getElementById(input_id).addEventListener('keydown', onkeydown);
  document.getElementById(submit_id).addEventListener('click', onsubmit);

  addOutputListener(name, 4, function(history) {
    updateChatHistory(history_id, history);
  });
  
  msg = {};
  msg[name] = {'input': '/refresh'};
  sendWebsocket(msg);

  return widget;
}

function addChatWidget_no_input(name, id, title, grid_options) {
  const history_id = `${id}_history`;

  // Only retain the chat history display area
  const html = `
    <div id="${history_id}" class="bg-medium-gray p-2 mb-2" style="font-size: 100%; overflow-y: scroll; flex-grow: 1;" ondrop="onFileDrop(event)" ondragover="onFileDrag(event)"></div>
  `;
  
  // Add the widget to the grid layout with specified options
  let widget = addGridWidget(id, title, html, null, Object.assign({w: 4, h: 14}, grid_options));

  // Update chat history when new messages arrive
  addOutputListener(name, 4, function(history) {
    updateChatHistory(history_id, history);
  });

  // Send an initial /refresh command to update the chat
  msg = {};
  msg[name] = {'input': '/refresh'};
  sendWebsocket(msg);

  return widget;
}

function addChatWidget_no_input_history3(name, id, title, grid_options, type) {
  // Backend-agnostic: used for both the 'vLLM' node (single-shot detection-preset path) and
  // the 'AgentLoop' node (harness path) - both broadcast their chat history on output 3.
  // The chat itself is built by mountAgentLoopChat() (chat_view.js), which the kiosk brain screen
  // shares (docs/superpowers/specs/2026-10-20-kiosk-display-design.md §2.3). It asks the backend to
  // re-broadcast its history with an empty input list (never a real turn - see the 2026-09
  // 'Hello!' note in git history) and, for AgentLoop, subscribes the live timeline on channel 6.
  let widget = addGridWidget(id, title, `<div id="${id}_chat_mount" class="d-flex flex-column flex-grow-1" style="min-height: 0;"></div>`,
                             null, Object.assign({w: 4, h: 14}, grid_options));
  const mount = document.getElementById(`${id}_chat_mount`);
  const history_id = mountAgentLoopChat(mount, name, id, type);
  const history_el = document.getElementById(history_id);
  history_el.setAttribute('ondrop', 'onFileDrop(event)');
  history_el.setAttribute('ondragover', 'onFileDrag(event)');
  return widget;
}

function addSafetyReviewWidget(name, channel = 1, allowConversation = false) {
  // Called unconditionally from addPlugin() whenever a SafetyReview node exists on
  // the graph (see the call site there for why this must NOT be gated behind
  // addPluginGridWidget()'s layout_grid/double-click-only dispatch). Ensures the
  // confirm dialog DOM exists and the OutputConfirmRequest (channel 1) listener is
  // subscribed - both guarded to be idempotent, safe to call more than once, and -
  // critically - each guarded INDEPENDENTLY of the other. A remove-then-re-add of
  // this node clears outputListeners[name] but does NOT remove the dialog's DOM
  // (removePlugins doesn't clean it up), so on re-add the DOM-creation guard below
  // is false while the listener-subscription guard still needs to fire. Do not nest
  // the latter inside the former - that was tried once and silently broke listener
  // re-subscription after remove/re-add (dialog stops receiving broadcasts forever).
  const dialog_id = `${name}_confirm_dialog`;

  // The pending-request queue lives on the dialog element itself (dialog_el.svQueue),
  // not in a closure, for the same reason: the DOM element is what survives a
  // remove-then-re-add, a closure created by one invocation of this function does
  // not. showRequest() therefore takes dialog_el as a parameter rather than closing
  // over one, so it behaves identically no matter which call's closure invokes it.
  function showRequest(dialog_el, data) {
    dialog_el.dataset.requestId = data['request_id'];
    document.getElementById(`${dialog_id}_body`).innerHTML =
      `<p>Tool: <strong>${escapeHTML(data['tool_name'])}</strong> &nbsp; (risk: ${escapeHTML(data['risk'])})</p>` +
      `<pre>${escapeHTML(JSON.stringify(data['args'], null, 2))}</pre>`;
    // SafetyReview: general-purpose tools (run_command) can't be allowed for the whole conversation.
    const allowBtn = document.getElementById(`${dialog_id}_allow`);
    if (allowBtn)
      allowBtn.style.display = (data['allow_conversation'] !== false) ? '' : 'none';
    bootstrap.Modal.getOrCreateInstance(dialog_el).show();
  }

  if (document.getElementById(dialog_id) == null) {
    $('body').append(`
      <div class="modal fade" id="${dialog_id}" tabindex="-1" aria-labelledby="${dialog_id}_label" aria-hidden="true">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="${dialog_id}_label">Confirm Action</h5>
            </div>
            <div class="modal-body" id="${dialog_id}_body"></div>
            <div class="modal-footer">
              <button id="${dialog_id}_deny" type="button" class="btn btn-secondary" data-bs-dismiss="modal">Deny</button>
              ${allowConversation ? `<button id="${dialog_id}_allow" type="button" class="btn btn-warning" data-bs-dismiss="modal">Allow for this conversation</button>` : ''}
              <button id="${dialog_id}_confirm" type="button" class="btn btn-danger" data-bs-dismiss="modal">Confirm</button>
            </div>
          </div>
        </div>
      </div>
    `);

    $(`#${dialog_id}_confirm`).on('click', function() {
      const dialog_el = document.getElementById(dialog_id);
      const request_id = dialog_el.dataset.requestId;
      if (!request_id)
        return;
      sendWebsocket({[name]: {'confirm': {'request_id': request_id}}});
      delete dialog_el.dataset.requestId;
    });

    $(`#${dialog_id}_allow`).on('click', function() {
      const dialog_el = document.getElementById(dialog_id);
      const request_id = dialog_el.dataset.requestId;
      if (!request_id)
        return;
      sendWebsocket({[name]: {'allow_conversation': {'request_id': request_id}}});
      delete dialog_el.dataset.requestId;
    });

    $(`#${dialog_id}_deny`).on('click', function() {
      const dialog_el = document.getElementById(dialog_id);
      const request_id = dialog_el.dataset.requestId;
      if (!request_id)
        return;
      sendWebsocket({[name]: {'deny': {'request_id': request_id}}});
      delete dialog_el.dataset.requestId;
    });

    // Bootstrap fires 'hidden.bs.modal' no matter how the modal closed - Confirm button,
    // Deny button, ESC, or a backdrop click. This is the single point where "this request
    // is done" is handled: if dataset.requestId is still set here, neither button handler
    // above already cleared it, meaning the user dismissed some other way - treat that as an
    // implicit deny instead of silently leaving the backend to expire it via its own 60s
    // timeout. Then, regardless of cause, show the next queued request if any.
    $(`#${dialog_id}`).on('hidden.bs.modal', function() {
      const dialog_el = document.getElementById(dialog_id);
      const leftover_request_id = dialog_el.dataset.requestId;
      if (leftover_request_id) {
        sendWebsocket({[name]: {'deny': {'request_id': leftover_request_id}}});
        delete dialog_el.dataset.requestId;
      }
      const queue = dialog_el.svQueue = dialog_el.svQueue || [];
      if (queue.length > 0)
        showRequest(dialog_el, queue.shift());
    });
  }

  if (!(name in outputListeners)) {
    addOutputListener(name, channel, function(data) {
      if (timelineConfirmHandlers.length > 0) {
        // An AgentLoop timeline widget MAY be present and want to render this confirmation
        // inline on its own card instead of the modal below - see addChatWidget_no_input_
        // history3()'s AgentLoop branch. Still routed through this SAME listener (not a
        // second independent subscription) so there is exactly one place, not two, deciding
        // what happens to a given OutputConfirmRequest.
        //
        // C1 (final whole-branch review): timelineConfirmHandlers is never de-registered
        // (closing the widget's grid panel or removing the AgentLoop node entirely leaves the
        // closure sitting in this array forever - see handleConfirmRequest()'s own comment),
        // so "the array is non-empty" does NOT mean "something will actually handle this
        // request" - it might contain only dead handlers whose widget DOM is gone. Every
        // handler is called (not short-circuited) so any genuinely live widget among possibly
        // several still gets a chance to claim it; only fall through to the modal below if
        // NONE of them did.
        let claimed = false;
        timelineConfirmHandlers.forEach(function(handler) {
          if (handler(name, data)) claimed = true;
        });
        if (claimed) return;
      }
      const dialog_el = document.getElementById(dialog_id);
      const queue = dialog_el.svQueue = dialog_el.svQueue || [];
      if (dialog_el.dataset.requestId)
        queue.push(data);  // one already showing - queue this one instead of overwriting it
      else
        showRequest(dialog_el, data);
    });
  }
}


function addDatasetCollectorReadyModal(name) {
  // Called unconditionally from addPlugin() whenever a DatasetCollector node exists
  // on the graph - see the call site there and addSafetyReviewWidget() above for why
  // this must NOT be gated behind addPluginGridWidget()'s layout_grid/double-click-only
  // dispatch: a dataset can finish packaging while this node's grid widget isn't open,
  // and a node added live via the graph editor always starts with an empty layout_grid.
  // Mirrors addSafetyReviewWidget()'s two independently-idempotent guards below: DOM
  // creation and listener subscription must each be safe to call more than once, and
  // guarded INDEPENDENTLY of each other, because a remove-then-re-add of this node
  // clears stateListeners[name] (see removePlugins()) but does NOT remove the dialog's
  // DOM - so on re-add the DOM-creation guard is false while the listener-subscription
  // guard still needs to fire.
  const dialog_id = `${name}_ready_dialog`;

  if (document.getElementById(dialog_id) == null) {
    $('body').append(`
      <div class="modal fade" id="${dialog_id}" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Dataset Ready</h5>
            </div>
            <div class="modal-body" id="${dialog_id}_body"></div>
            <div class="modal-footer">
              <a id="${dialog_id}_download" class="btn btn-primary" href="#">Download</a>
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  // NOTE: this listens via addStateListener() (the state-broadcast registry,
  // stateListeners) rather than addOutputListener() (the output-channel registry,
  // outputListeners) that addSafetyReviewWidget() above uses - a different registry,
  // so the idempotency guard here must check stateListeners, not outputListeners.
  if (!(name in stateListeners)) {
    addStateListener(name, function(state_dict) {
      const link = document.getElementById(`${dialog_id}_download`);
      // Without this branch, the three silent dead-ends this modal exists to close
      // (zero images after extension filtering, a nonexistent/unreadable upload
      // folder, any packaging failure) would leave the operator staring at
      // "Labeling in progress..." forever with zero feedback - DatasetLoader and
      // DatasetCollector both broadcast {'ready': false, 'error': '<message>'} on
      // these paths now (see dataset_loader.py/dataset_collector.py), so surface it
      // here rather than falling through to the silent `!ready` return below.
      if (state_dict['error']) {
        document.getElementById(`${dialog_id}_body`).textContent =
          `Error: ${state_dict['error']}`;
        link.style.display = 'none';
        bootstrap.Modal.getOrCreateInstance(document.getElementById(dialog_id)).show();
        return;
      }
      if (!state_dict['ready'])
        return;
      document.getElementById(`${dialog_id}_body`).textContent =
        `${state_dict['count']} labeled image(s) packaged.`;
      link.style.display = '';
      // Fetched as a blob and saved via a synthetic link instead of letting the
      // browser's own download manager pull `download_url` directly: Chrome (and
      // other Chromium browsers) validate a forced download's TLS cert through a
      // stricter path than a normal page navigation, and silently fail against
      // this project's self-signed cert with a generic "check your connection"
      // error instead of the usual click-through warning. Routing the fetch
      // through the page's own already-trusted connection avoids that path.
      const download_url = `/download_dataset/${state_dict['job_id']}`;
      link.href = download_url;
      link.onclick = function(e) {
        e.preventDefault();
        fetch(download_url)
          .then(resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.blob();
          })
          .then(blob => {
            const blob_url = URL.createObjectURL(blob);
            const temp_link = document.createElement('a');
            temp_link.href = blob_url;
            temp_link.download = `${state_dict['job_id']}.zip`;
            document.body.appendChild(temp_link);
            temp_link.click();
            document.body.removeChild(temp_link);
            URL.revokeObjectURL(blob_url);
          })
          .catch(err => {
            document.getElementById(`${dialog_id}_body`).textContent =
              `Download failed: ${err.message}`;
          });
      };
      bootstrap.Modal.getOrCreateInstance(document.getElementById(dialog_id)).show();
    });
  }
}


// Wake word 「嘿，小研」 (WakeWord plugin, docs/superpowers/specs/2026-09-30-wake-word-design.md).
// State arrives on output 3; the button and the wake key send {'wake': {}}. Hooks are registered in
// addPlugin() so the key works even while the node's widget is closed (and for nodes added live).
const WAKE_WORD_STATE_LABELS = {
  sleeping: '💤 Say "Hey, Xiao Yan" to wake me', greeting: '👋 Greeting', listening: '🎙 Listening',
  thinking: '💭 Thinking', speaking: '🔊 Answering'};
const WAKE_WORD_DECISION_LABELS = {wake: 'Wake', question: 'Question', ignored: 'Ignored', echo: 'Echo, filtered out'};
var wakeWordStates = {};      // plugin name -> last state dict (+ listenDeadline, ms)
var wakeWordKeys = {};        // plugin name -> KeyboardEvent.key that wakes it
var wakeWordKeyHandlerInstalled = false;
var wakeWordCountdownTimer = null;

function addWakeWordHooks(name, wakeKey) {
  wakeWordKeys[name] = wakeKey || 'PageDown';
  if( !(name in outputListeners && 3 in outputListeners[name]) ) {
    addOutputListener(name, 3, function(state) {
      if( state['state'] === 'listening' && state['remaining'] != null )
        state['listenDeadline'] = Date.now() + state['remaining'] * 1000;
      wakeWordStates[name] = state;
      renderWakeWordWidget(name);
    });
  }
  if( !wakeWordKeyHandlerInstalled ) {
    wakeWordKeyHandlerInstalled = true;
    document.addEventListener('keydown', function(e) {
      const t = e.target;
      if( t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) )
        return;   // typing (e.g. in the chat box) must not wake it
      for( const [pluginName, key] of Object.entries(wakeWordKeys) ) {
        if( e.key === key ) {
          e.preventDefault();
          sendWebsocket({[pluginName]: {'wake': {}}});
        }
      }
    });
  }
  if( !wakeWordCountdownTimer )
    wakeWordCountdownTimer = setInterval(function() {
      for( const n of Object.keys(wakeWordStates) )
        if( wakeWordStates[n]['state'] === 'listening' ) renderWakeWordWidget(n);
    }, 250);
}

function addWakeWordWidget(name, id, title, grid_options) {
  const html = `
    <div class="wake-word-widget">
      <div id="${id}_state" class="wake-word-state"></div>
      <button id="${id}_wake" type="button" class="btn btn-primary wake-word-button">🎙 Wake Xiao Yan</button>
      <div id="${id}_last" class="wake-word-last"></div>
    </div>
  `;
  const widget = addGridWidget(id, title, html, null, Object.assign({w: 3, h: 4}, grid_options));
  const button = document.getElementById(`${id}_wake`);
  button.addEventListener('click', function() { sendWebsocket({[name]: {'wake': {}}}); });
  button.addEventListener('mousedown', e => e.stopPropagation());    // not a GridStack drag
  button.addEventListener('pointerdown', e => e.stopPropagation());
  renderWakeWordWidget(name);
  return widget;
}

function renderWakeWordWidget(name) {
  const stateEl = document.getElementById(`${name}_grid_state`);
  if( !stateEl ) return;
  const s = wakeWordStates[name] || {state: 'sleeping'};
  let label = WAKE_WORD_STATE_LABELS[s['state']] || s['state'];
  if( s['state'] === 'listening' && s['listenDeadline'] )
    label += ` ${Math.max(0, Math.ceil((s['listenDeadline'] - Date.now()) / 1000))}s`;
  stateEl.textContent = label;
  stateEl.className = `wake-word-state wake-word-${s['state']}`;
  const lastEl = document.getElementById(`${name}_grid_last`);
  if( lastEl )
    lastEl.textContent = s['text']
      ? `${WAKE_WORD_DECISION_LABELS[s['decision']] || s['decision']}: ${s['text']}` : '';
}

function addHubDialog(name, title) {
  // harness Tools_Hub / Skills_Hub: enable checkboxes only (state on output 0).
  const dialog_id = `${name}_config_dialog`;
  const list_id = `${dialog_id}_list`;
  if (document.getElementById(dialog_id) == null) {
    addDialog(dialog_id, title, `<div id="${list_id}" class="p-2" style="max-height: 60vh; overflow-y: scroll;"></div>`, false);
    $(`#${dialog_id}`).on('show.bs.modal', function() {
      sendWebsocket({[name]: {'refresh': {}}});
    });
  }
  if (!(name in outputListeners)) {
    addOutputListener(name, 0, function(state) {
      const list = document.getElementById(list_id);
      list.innerHTML = state.map(item => `
        <div class="form-check mb-2">
          <input type="checkbox" class="form-check-input" id="${dialog_id}_${item.name}_enabled" ${item.enabled ? 'checked' : ''}>
          <label class="form-check-label" for="${dialog_id}_${item.name}_enabled">
            <strong>${escapeHTML(item.name)}</strong>${item.risk ? ` (risk: ${escapeHTML(item.risk)})` : ''}
          </label>
          <div><small>${escapeHTML(item.description)}</small></div>
        </div>`).join('');
      state.forEach(item => {
        $(`#${dialog_id}_${item.name}_enabled`).on('change', function() {
          sendWebsocket({[name]: {'set_enabled': {'name': item.name, 'enabled': this.checked}}});
        });
      });
    });
  }
}


function addWebVideoInWidget(name, id, title, grid_options) {
  // 純本地攝影機預覽面板：只顯示 getUserMedia 抓到的畫面，不涉及任何網路串流邏輯。
  // 這裡的 <video> 元素同時也是 audio.js captureAndSendCameraFrame() 擷取畫面的來源，
  // 用 data-role 屬性讓 audio.js 找得到，不需要知道 plugin 實例名稱。
  const video_id = `${id}_video`;
  const status_id = `${id}_status`;
  const html = `
    <div style="display:flex; flex-direction:column; flex:1; min-height:0;">
      <div style="flex:1; min-height:0; position:relative; background:#111; border-radius:6px; overflow:hidden;">
        <video id="${video_id}" data-role="web-video-in" autoplay muted playsinline
          style="display:none; width:100%; height:100%; object-fit:cover; position:absolute; top:0; left:0;">
          Your browser does not support video
        </video>
        <div id="${status_id}" style="display:flex; align-items:center; justify-content:center;
          width:100%; height:100%; color:#666; font-size:13px; position:absolute; top:0; left:0;">
          Waiting for camera permission…
        </div>
      </div>
    </div>
  `;
  return addGridWidget(id, title, html, null, Object.assign({ w: 4, h: 4 }, grid_options));
}

function addImageInputWidget(name, id, title, grid_options) {
  const file_id = `${id}_file`;
  const preview_id = `${id}_preview`;
  const status_id = `${id}_status`;
  const html = `
    <div style="display:flex; flex-direction:column; flex:1; min-height:0; gap:6px;">
      <div style="flex-shrink:0; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <input id="${file_id}" type="file" accept="image/*" style="font-size:13px;">
        <button id="${id}_clear_btn" class="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600" style="font-size:13px;">Clear</button>
      </div>
      <div style="flex:1; min-height:0; position:relative; background:#111; border-radius:6px; overflow:hidden;">
        <img id="${preview_id}" style="display:none; width:100%; height:100%; object-fit:contain; position:absolute; top:0; left:0;">
        <div id="${status_id}" style="display:flex; align-items:center; justify-content:center;
          width:100%; height:100%; color:#666; font-size:13px; position:absolute; top:0; left:0;">
          No image loaded
        </div>
      </div>
    </div>
  `;

  const widget = addGridWidget(id, title, html, null, Object.assign({ w: 4, h: 4 }, grid_options));

  document.getElementById(file_id).addEventListener('change', (ev) => {
    if (!ev.target.files || ev.target.files.length === 0)
      return;

    const file = ev.target.files[0];
    const ext = file.name.split('.').pop().toLowerCase();
    file.arrayBuffer().then((fileBuffer) => {
      sendWebsocket(fileBuffer, type=MESSAGE_IMAGE, metadata=ext);
    });

    const preview = document.getElementById(preview_id);
    const status = document.getElementById(status_id);
    preview.src = URL.createObjectURL(file);
    preview.style.display = 'block';
    status.style.display = 'none';
  });

  document.getElementById(`${id}_clear_btn`).addEventListener('click', () => {
    const msg = {};
    msg[name] = { 'clear_image': null };
    sendWebsocket(msg);

    const preview = document.getElementById(preview_id);
    const status = document.getElementById(status_id);
    preview.style.display = 'none';
    status.style.display = 'flex';
    document.getElementById(file_id).value = '';
  });

  return widget;
}

window.MJPEG_STREAMS = window.MJPEG_STREAMS || {};

function addVideoOutputWidget(name, id, title, grid_options) {

  if (window.MJPEG_STREAMS[name] && window.MJPEG_STREAMS[name].img) {
    console.log(`Stopping previous MJPEG stream for name: ${name}`);
    window.MJPEG_STREAMS[name].img.src = '';  // Stop the old MJPEG stream
    delete window.MJPEG_STREAMS[name];        // clear record
  }

  // Send WebSocket message to create MJPEG stream port
  const msg = {};
  msg[name] = { 'create_mjpeg_stream_port': name };
  sendWebsocket(msg);

  // Port starts as placeholder; Python will send actual port via send_stats "mjpeg_port:XXXX"
  let port = 10000;
  const host = window.location.hostname;

  const video_id = `${id}_video_player`;
  const select_id = `${id}_stream_select`;
  const mjpeg_id = `${id}_mjpeg_stream`;
  const error_id = `${id}_error`;
  const html = `
    <div style="display:flex; flex-direction:column; flex:1; min-height:0; gap:6px;">
      <div style="flex-shrink:0; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <label for="${select_id}" style="margin:0; font-size:13px;">Stream:</label>
        <select id="${select_id}" style="font-size:13px;">
          <option value="mjpeg" selected>WebSocket JPEG</option>
        </select>
        <button id="${id}_stop_btn" class="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600" style="font-size:13px;">Stop</button>
      </div>
      <div id="${id}_media_container" style="flex:1; min-height:0; position:relative; background:#111; border-radius:6px; overflow:hidden; contain:layout paint;">
        <video id="${video_id}" autoplay controls playsinline muted
          style="display:none; width:100%; height:100%; object-fit:contain; position:absolute; top:0; left:0;">
          Your browser does not support video
        </video>
        <img id="${mjpeg_id}" src="" alt="MJPEG Video Stream"
          style="display:none; width:100%; height:100%; object-fit:contain; position:absolute; top:0; left:0;">
        <div id="${id}_status" style="display:flex; align-items:center; justify-content:center;
          width:100%; height:100%; color:#666; font-size:13px; position:absolute; top:0; left:0;">
          No signal
        </div>
      </div>
      <div id="${error_id}" style="flex-shrink:0; color:#f66; font-size:12px; min-height:16px;"></div>
    </div>
  `;

  // Adding widgets to the grid
  let widget = addGridWidget(id, title, html, null, Object.assign({ w: 5, h: 5 }, grid_options));
  let video = document.getElementById(video_id);
  let mjpegImg = document.getElementById(mjpeg_id);
  let stopBtn = document.getElementById(`${id}_stop_btn`);
  let streamSelect = document.getElementById(select_id);
  let errorDiv = document.getElementById(error_id);
  let statusDiv = document.getElementById(`${id}_status`);
  sensorSignalRegister(name, document.getElementById(`${id}_media_container`));   // sensor_view.js

  function setStatus(msg, color) {
    if (!statusDiv) return;
    statusDiv.textContent = msg;
    statusDiv.style.color = color || '#666';
    statusDiv.style.display = (msg && msg.length > 0) ? 'flex' : 'none';
  }

  // Check network connectivity by testing Google
  async function checkNetworkConnectivity() {
    try {
      // Try to fetch Google favicon with 3 second timeout
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Network timeout')), 3000)
      );
      
      const fetchPromise = fetch('https://www.google.com/favicon.ico', { 
        method: 'HEAD', 
        mode: 'no-cors',
        cache: 'no-cache'
      });
      
      await Promise.race([fetchPromise, timeout]);
      return true;
    } catch (error) {
      console.warn('Network connectivity check failed:', error);
      return false;
    }
  }

  // Show error message
  function showError(message) {
    errorDiv.textContent = message;
    console.error(message);
  }

  // WS JPEG: receives MESSAGE_VIDEO_FRAME binary messages from server.py
  // at ~20fps and displays them via mjpegImg. Avoids HTTP mixed-content issues.
  function playWsJpeg() {
    errorDiv.textContent = '';
    video.style.display = 'none';
    mjpegImg.onload = null;
    mjpegImg.onerror = null;
    mjpegImg.src = '';
    setStatus('WebSocket JPEG...', '#aaa');

    let prevObjUrl = null;
    videoFrameListeners[name] = function(frameData) {
      if (prevObjUrl) { URL.revokeObjectURL(prevObjUrl); prevObjUrl = null; }
      prevObjUrl = URL.createObjectURL(new Blob([frameData], {type: 'image/jpeg'}));
      mjpegImg.src = prevObjUrl;
      mjpegImg.style.display = 'block';
      setStatus('', '');
      errorDiv.textContent = '';
      streamSelect.style.borderColor = '#88a';
      streamSelect.title = 'Active: WebSocket JPEG';
    };
    setVideoSubscription(Object.keys(videoFrameListeners));   // websocket.js: only the outputs shown here
  }

  // Listen for Python to report the actual MJPEG port via plugin parameter 'mjpeg_port'
  addStateListener(name, function(state) {
    if (state && state.mjpeg_port && state.mjpeg_port > 0) {
      const newPort = parseInt(state.mjpeg_port, 10);
      if (newPort !== port) {
        port = newPort;
        console.log(`VideoOutput: received actual MJPEG port ${port} from server`);
      }
    }
  });


  // GridStack v10 uses pointer events (pointerdown) for drag detection.
  // Block both mousedown and pointerdown so neither event reaches GridStack
  // when the user clicks on interactive controls inside the widget.
  [streamSelect, stopBtn].forEach(el => {
    if (el) {
      el.addEventListener('mousedown',  e => e.stopPropagation());
      el.addEventListener('pointerdown', e => e.stopPropagation());
    }
  });

  // Stop button event
  stopBtn.addEventListener('click', function () {
    const isStopping = stopBtn.textContent === 'Stop';
    console.log('Stopping stream');
    let msg = {};
    msg[name] = { 'stop_video': 'stop' };
    sendWebsocket(msg); // Send a stop message to WebSocket
    if (isStopping) {
        stopBtn.textContent = 'Start';
      } else {
        stopBtn.textContent = 'Stop';
      }
  });

  // WS JPEG is the only stream (low-latency push, ~5-20ms, so Insert frame sync needs no delay
  // compensation). The WebRTC option was removed 2026-09-29: ICE never completed on this setup,
  // every widget signalled to port 8554 (the first VideoOutput), and that half-open peer wedged
  // jetson-utils' WebRTC server, which then leaked every raw frame (61 GB before a restart).
  // VideoOutput no longer starts that server at all (see video_output.py).
  playWsJpeg();

  return widget;
}


function setStateDict(state_dicts) {
  for( plugin_name in state_dicts ) {
    const state_dict = state_dicts[plugin_name];
    for( state_name in state_dict ) {
      const id = document.getElementById(`${plugin_name}_config_${state_name}`);
      if( id != null ) {
        id.value = state_dict[state_name];
        // A <select> with options (addPluginDialog's dropdown fields) gets replaced
        // by a select2 widget - setting the native element's .value directly (as
        // above) doesn't repaint select2's own rendered UI, so without this the
        // dropdown keeps showing whatever was selected when the dialog was first
        // built even after this sync writes the live value underneath it.
        if( id.tagName === 'SELECT' && $(id).hasClass('select2-hidden-accessible') )
          $(id).trigger('change.select2');
      }
    }
    
    if( plugin_name in stateListeners )
      stateListeners[plugin_name].forEach((listener) => {listener(state_dict);});

    if( 'all' in stateListeners )
      stateListeners['all'].forEach((listener) => {listener(state_dict);});
  }
}

const _statsCache = {};

function setStats(stats_dicts) {
  for( plugin_name in stats_dicts ) {
    const stats = stats_dicts[plugin_name];

    if( stats && stats['source'] )   // the node feeding a VideoOutput (track_boxes.js)
      trackBoxesSetSource(plugin_name, stats['source']);

    if( ! ('summary' in stats) )
      continue;


    let summary = stats['summary'];

    if( Array.isArray(summary) ) {
      const num_outputs = $(`.${plugin_name} .outputs .output`).length;
      summary = summary.join($(`.${plugin_name}`).length == 0 || num_outputs > 0 ? '\n' : ' ');
    }

    // Skip DOM update if text hasn't changed
    if( _statsCache[plugin_name] === summary )
      continue;
    _statsCache[plugin_name] = summary;

    let node_stats = document.getElementById(`${plugin_name}_node_stats`);

    if( node_stats != undefined ) {
      // one line per item, cut with an ellipsis at the node's width (a long notice ran out of the
      // 160 px node, 2026-11-09); hovering shows the whole text
      node_stats.replaceChildren(...String(summary).split('\n').map(function(line) {
        const el = document.createElement('div');
        el.className = 'node-stats-line';
        el.textContent = line;
        return el;
      }));
      node_stats.title = summary;
    }
  }
}

function truncate(str, max_len) {
  if( str.length > max_len )
    return str.slice(0, max_len+1);
  else
    return str;
}

function addPlugin(plugin) {
  const plugin_name = plugin['name'];

  // Prevent duplicate nodes on WebSocket reconnect / page refresh
  try {
    const existing = drawflow.getNodesFromName(plugin_name);
    if (existing && existing.length > 0) {
      console.log(`addPlugin: '${plugin_name}' already exists, skipping`);
      return;
    }
  } catch(e) {}

  const plugin_title = plugin['title'];
  const layout_grid = pickLayout(plugin, viewMode);   // sensor_view.js: this view's own, else layout_grid
  const layout_node = plugin['layout_node'];
  const nodes = document.querySelectorAll('.drawflow-node');

  if( ('x' in layout_node) && ('y' in layout_node) ) {
    var x = layout_node['x'];
    var y = layout_node['y'];
  }
  else
  {
    var x = 10;
    var y = 10;
      
    if( nodes.length > 0 ) {
      const node = nodes[nodes.length-1];
      const abs_rect = node.getBoundingClientRect();
      x = node.offsetLeft + abs_rect.width + 60;
      y = node.offsetTop
    }
  }
  
  let stats_class = '';
  
  if( plugin['outputs'].length > 1 )
    stats_class = 'mt-2';
    
  const html = `
    <div style="position: absolute; top: 5px;">
      ${truncate(plugin_title, 14)}
      <p id="${plugin_name}_node_stats" class="${stats_class}" style="font-family: monospace, monospace; font-size: 80%; white-space: pre-line"></p>
    </div>
  `;
  
  const node_id = drawflow.addNode(plugin_name, plugin['inputs'].length, plugin['outputs'].length, x, y, plugin_name, {}, html);
  nodeIdToName[node_id] = plugin_name;
  console.log(`added node id=${node_id} for {plugin_name}`);
  
  let style = '';
  let max_output_chars = 0;
  
  for( i in plugin['outputs'] ) {
    const output = plugin['outputs'][i].toString();
    max_output_chars = Math.max(max_output_chars, output.length);
    style += `.${plugin_name} .outputs .output:nth-child(${Number(i)+1}):before {`;
    style += `display: block; content: "${output}"; position: relative; min-width: 160px; font-size: 80%; bottom: 2px; right: ${(output.length-1) * 6 + 20}px;} `;
  }
    
  style += `.outputs { margin-top: 20px; font-family: monospace, monospace; } `;
  
  var style_el = document.createElement('style');
  style_el.id = `${plugin_name}_node_io_styles`;
  style_el.innerHTML = style;
  document.head.appendChild(style_el);

  const has_config_dialog = (Object.keys(plugin['parameters']).length > 0);
  
  $(`.${plugin_name}`).on('dblclick', function () {
    //console.log(`double-click ${plugin_name}`);
    if( addPluginGridWidget(plugin_name, plugin['type'], plugin_title) == null ) {
      if( has_config_dialog ) {
        // get_state_dict's response lands asynchronously and setStateDict() (above)
        // writes it straight into these same form fields to keep the dialog's
        // display in sync with values changed elsewhere. Showing the modal
        // immediately (the old behavior) let that write land AFTER the operator
        // had already picked a new value but BEFORE they hit submit, silently
        // reverting their pick back to the pre-edit value - a config change that
        // visually appeared to work but never actually took effect. Wait for one
        // response before showing the modal so there's nothing left to race.
        const name = plugin['name'];
        const listeners = stateListeners[name] || (stateListeners[name] = []);
        const showOnce = function(_state_dict) {
          const idx = listeners.indexOf(showOnce);
          if( idx !== -1 )
            listeners.splice(idx, 1);
          const config_modal = new bootstrap.Modal(`#${name}_config_dialog`);
          config_modal.show();
        };
        listeners.push(showOnce);
        sendWebsocket({'get_state_dict': plugin_name});
      }
    }
  });
  
  if( has_config_dialog ) {
    // Tools_Hub/Skills_Hub's enabled_tools is hidden=True - a machine-managed dict, not a
    // user-editable form field - so the generic auto-form builder would render an empty dialog. Build custom content under the same
    // "#<name>_config_dialog" id instead, so the existing double-click opener above
    // still finds and shows it without any changes to that shared logic.
    if( plugin['type'] === 'Tools_Hub' || plugin['type'] === 'Skills_Hub' )
      addHubDialog(plugin_name, plugin_title);
    else
      addPluginDialog(plugin_name, 'config', plugin_title, null, plugin['parameters']);
  }

  // SafetyReview's confirm dialog is a functional requirement (a gated tool call
  // blocks waiting for it), not an optional display panel - it must be wired up
  // unconditionally whenever this plugin exists on the graph, regardless of
  // whether it was loaded from a preset with a saved layout_grid or added fresh
  // via the UI (which always starts with an empty layout_grid). Do NOT gate this
  // behind addPluginGridWidget()'s layout_grid/double-click-only dispatch below -
  // that path is for optional display widgets, and a plugin added live through
  // the graph editor would silently never get a confirm dialog subscribed.
  // Dual-screen exhibition display (2026-09-19): the camera-only kiosk screen is a
  // passive display for booth visitors - a tool-call confirmation dialog popping up
  // there would have no one to answer it. Only skip registering it in that one view;
  // ?view=pipeline and the everyday no-param URL keep it exactly as today.
  if( plugin['type'] === 'SafetyReview' && viewMode !== 'sensor' )
    addSafetyReviewWidget(plugin_name, 0, true);

  // WakeWord: the state listener and the wake key must work whether or not its grid widget is
  // open and for nodes added live (same reasoning as the SafetyReview hook above). The camera-only
  // kiosk view has no one to press anything.
  if( plugin['type'] === 'WakeWord' && viewMode !== 'sensor' )
    addWakeWordHooks(plugin_name, plugin['wake_key']);
  if( plugin['type'] === 'PerformanceMonitor' && viewMode !== 'sensor' )
    addPerformanceMonitorHooks(plugin_name);   // perf_monitor.js
  if( plugin['type'] === 'EventLog' && viewMode !== 'sensor' )
    addEventLogHooks(plugin_name);             // event_log.js
  if( plugin['type'] === 'Tools_Hub' && viewMode !== 'sensor' )
    addObjectTrackerHooks(plugin_name);   // object_tracker.js: the tracking tool module's panel
  if( plugin['type'] === 'Tools_Hub' )
    addTrackBoxesHooks(plugin_name);      // track_boxes.js: boxes over the camera views, camera view too

  // Same reasoning as SafetyReview's confirm dialog above - a dataset finishing
  // in the background must notify the operator regardless of whether this
  // node's grid widget happens to be open, and regardless of whether the node
  // was preset-loaded or added live via the graph editor. DatasetLoader gets the
  // same modal (keyed to its own name, so it's a separate dialog instance) because
  // it now broadcasts its own {'ready': false, 'error': ...} state on a nonexistent/
  // unreadable upload folder or zero images after extension filtering - the same
  // silent-dead-end problem the DatasetCollector modal exists to close for
  // packaging failures.
  // Same reasoning as the SafetyReview gate above.
  if( (plugin['type'] === 'DatasetCollector' || plugin['type'] === 'DatasetLoader') && viewMode !== 'sensor' )
    addDatasetCollectorReadyModal(plugin_name);

  // Camera access is gated on "does a WebVideoIn plugin exist on the graph" (see
  // audio.js setWebVideoInCount()/updateRemoteCameraState()), which must react the
  // same way whether this plugin arrived via a preset load or was dragged in live -
  // so this is registered unconditionally here, not inside the layout_grid-gated
  // addPluginGridWidget() call below (same reasoning as the SafetyReview hook above).
  // The preview widget itself is also created unconditionally for the same reason:
  // a WebVideoIn added live via the UI always starts with an empty layout_grid, and
  // without this it would silently have no visible panel until the user happens to
  // double-click the node - even though the camera stream itself would already be live.
  if( plugin['type'] === 'WebVideoIn' ) {
    webVideoInPlugins.add(plugin_name);
    if( typeof setWebVideoInCount === 'function' )
      setWebVideoInCount(webVideoInPlugins.size);
  }

  if( plugin['type'] === 'WebVideoIn' || Object.keys(layout_grid).length > 0 ) {
    addPluginGridWidget(plugin_name, plugin['type'], plugin_title, layout_grid);
  }

  // The Advantech badge, by plugin type (DynamicPlugin's ADVANTECH_TYPES, sent as TypeInfo 'vendor',
  // 2026-11-08): it used to match node names, so a renamed node lost it and newer plugins had none.
  const typeInfo = pluginTypes && pluginTypes[plugin['type']];
  if (typeInfo && typeInfo['vendor'] === 'advantech') {
    customizeNode(plugin_name, color = '#add8e6', label = 'Advantech', labelWidth = '80px', labelHeight = '25px', fontSize = '12px');
  }
}

function addPluginGridWidget(name, type, title, grid_options) {
  const id = `${name}_grid`;

  if( type == undefined )
    type = name;

  if( title == undefined )
    title = name;

  if( document.getElementById(id) != null )
    return null;

  // Dual-screen exhibition display (2026-09-19) follow-up fix: GraphEditor is a
  // functional component, not a display widget that camera view can filter out
  // like any other non-video type - addGraphEditor() is the ONLY place `drawflow`
  // (the node-graph engine every addPlugin() call depends on via
  // drawflow.addNode()/getNodesFromName()) ever gets constructed. Filtering it
  // out here the same way as other non-video types left `drawflow` permanently
  // undefined in camera view, so every subsequent plugin's addPlugin() call threw
  // an uncaught TypeError and aborted the whole batch - ?view=camera rendered
  // nothing but the navbar, on every preset (all of them wire a GraphEditor
  // global).
  //
  // 2026-09-22 revision: the original fix here built the GridStack widget as
  // normal and then immediately removed it again in camera view. That still
  // briefly inserted a widget at GraphEditor's saved position (which overlaps
  // the region the camera video widgets live in) into GridStack's layout
  // engine - the insert itself, not just the later removal, is what triggers
  // GridStack's collision avoidance, which permanently displaces whatever real
  // widget was already occupying that space. Removing GraphEditor's widget
  // right after does not undo that displacement. Root-caused live by noticing
  // the camera view's video widgets "fell" every time the pipeline-view page
  // reloaded (each reload rebroadcasts the full plugin list to every
  // connected client, re-running this same insert-then-remove dance). Fix:
  // addGraphEditor() now builds the drawflow engine directly in camera view,
  // entirely outside GridStack, so no widget for it is ever inserted at all.
  if( type === 'GraphEditor' )
    return addGraphEditor(name, id, grid_options);

  // Dual-screen exhibition display (2026-09-19): ?view=camera only shows widgets
  // that render a live picture; ?view=pipeline shows everything else. No 'view'
  // param (viewMode === null) shows everything, exactly like today.
  if( viewMode === 'sensor' && !isSensorWidget(type) )
    return null;
  if( viewMode === 'pipeline' && isSensorWidget(type) )
    return null;

  switch(type) {
    case 'UserPrompt':
      return addTextInputWidget(name, id, title, grid_options);
    case 'TextStream':
      return addTextStreamWidget(name, id, title, grid_options);
    case 'NanoLLM':
      return addChatWidget(name, id, title, grid_options);
    case 'NanoLLM_ICL':
      return addChatWidget_no_input(name, id, title, grid_options);
    case 'vLLM':
    case 'AgentLoop':
      return addChatWidget_no_input_history3(name, id, title, grid_options, type);
    case 'WakeWord':
      return addWakeWordWidget(name, id, title, grid_options);
    case 'PerformanceMonitor':
      return addPerformanceMonitorWidget(name, id, title, grid_options);
    case 'EventLog':
      return addEventLogWidget(name, id, title, grid_options);
    case 'VideoOutput':
      return addVideoOutputWidget(name, id, title, grid_options);
    case 'WebVideoIn':
      return addWebVideoInWidget(name, id, title, grid_options);
    case 'Image_Input':
      return addImageInputWidget(name, id, title, grid_options);
    case 'NanoDB':
      return addNanoDBWidget(name, id, title, grid_options);
    case 'NanoDB_Fashion':
      return addNanoDBWidget(name, id, title, grid_options);
    case 'TerminalPlugin':
      return addTerminalWidget(name, id, title, grid_options);
    case 'DatasetCollector':
      return addDatasetCollectorControlWidget(name, id, title, grid_options);
    case 'DatasetLoader':
      return addDatasetLoaderWidget(name, id, title, grid_options);
    default:
      return null;
  }
}

function connectPlugins(connections) {
  if( !Array.isArray(connections) )
    connections = [connections];

  ignoreGraphEvents = true;

  connections.forEach((connection) => {
    const from_id = drawflow.getNodesFromName(connection['from'])[0];
    const to_id = drawflow.getNodesFromName(connection['to'])[0];
    if( from_id === undefined || to_id === undefined ) {
      console.log(`skip connection: ${connection['from']}(${from_id}) => ${connection['to']}(${to_id}) — node not found`);
      return;
    }
    console.log(`connecting plugin ${connection['from']} (id=${from_id}, channel=${connection['output']}) => ${connection['to']} (id=${to_id}, channel=${connection['input']})`);
    try {
      drawflow.addConnection(from_id, to_id, `output_${connection['output']+1}`, `input_${connection['input']+1}`);
    } catch(e) {
      console.log(`addConnection failed: ${e.message}`);
    }
  });

  ignoreGraphEvents = false;
}

function removePlugins(plugins) {
  if( !Array.isArray(plugins) )
    plugins = [plugins];

  ignoreGraphEvents = true;

  plugins.forEach((plugin) => {
    if( webVideoInPlugins.has(plugin) ) {
      webVideoInPlugins.delete(plugin);
      if( typeof setWebVideoInCount === 'function' )
        setWebVideoInCount(webVideoInPlugins.size);
    }

    // remove drawflow node
    try {
      const id = drawflow.getNodesFromName(plugin)[0];
      console.log(`removing plugin ${plugin} (id=${id})`);
      drawflow.removeNodeId(`node-${id}`);
    } catch(e) { console.log(e); }

    // remove grid widget without triggering the 'removed' event
    // (which would send config_plugin to server and create ghost global_states entries)
    const widgetEl = document.querySelector(`.grid-stack-item[gs-id="${plugin}"]`);
    if( widgetEl ) {
      suppressGridRemoved = true;
      grid.removeWidget(widgetEl, false);
      suppressGridRemoved = false;
      widgetEl.remove();
    }

    // clean up all listener registries so stale callbacks don't leak
    delete outputListeners[plugin];
    delete stateListeners[plugin];
    delete videoFrameListeners[plugin];
  });
  setVideoSubscription(Object.keys(videoFrameListeners));

  ignoreGraphEvents = false;
}

function addPlugins(plugins) {
  if( !Array.isArray(plugins) )
    plugins = [plugins];

  suppressGridAdded = true;  // prevent GridStack auto-placement from overwriting saved positions

  for( i in plugins ) {
    let plugin = plugins[i];
    if( ('global' in plugin) ) {
      const lg = pickLayout(plugin, viewMode);
      // Only create widget for global plugins that have actual position data.
      // Empty layout_grid {} means a stale preset entry — skip to avoid ghost widgets.
      if( lg && Object.keys(lg).length > 0 )
        addPluginGridWidget(plugin['name'], null, plugin['name'], lg);
    }
    else
      addPlugin(plugin);
  }

  ignoreGraphEvents = true;
  
  for( i in plugins ) {
    for( l in plugins[i]['connections'] ) {
      const conn = plugins[i]['connections'][l];
      const from_id = drawflow.getNodesFromName(plugins[i]['name'])[0];
      const to_id = drawflow.getNodesFromName(conn['to'])[0];
      if( from_id === undefined || to_id === undefined ) {
        console.log(`skip connection (addPlugins): ${plugins[i]['name']}(${from_id}) => ${conn['to']}(${to_id}) — node not found`);
        continue;
      }
      console.log('adding connection', conn);
      try {
        drawflow.addConnection(from_id, to_id, `output_${conn['output']+1}`, `input_${conn['input']+1}`);
      } catch(e) {
        console.log(`addConnection failed: ${e.message}`);
      }
    }
  }
  
  ignoreGraphEvents = false;
  suppressGridAdded = false;

  // After get_state_dict responses arrive, correct layout if Terminal ended up above Node Editor
  setTimeout(ensureGlobalLayoutOrder, 1200);
}

function ensureGlobalLayoutOrder() {
  const graphEl = document.querySelector('.grid-stack-item[gs-id="GraphEditor"]');
  const termEl  = document.querySelector('.grid-stack-item[gs-id="TerminalPlugin"]');
  if( !graphEl || !termEl ) return;

  const graphY = parseInt(graphEl.getAttribute('gs-y') ?? '0');
  const graphH = parseInt(graphEl.getAttribute('gs-h') ?? '11');
  const termY  = parseInt(termEl.getAttribute('gs-y') ?? '99');

  // Fix whenever Terminal overlaps or sits inside Node Editor (should be below it)
  if( termY < graphY + graphH ) {
    console.log(`fixing global layout: Terminal(y=${termY}) overlaps Node Editor(y=${graphY}, h=${graphH})`);
    grid.update(graphEl, {x: 0, y: 0});
    grid.update(termEl,  {x: 0, y: graphH});  // y:graphH because Node Editor ends at y:0+graphH
  }
}

function addPluginTypes(types) {
  pluginTypes = types;

  /*for( pluginName in pluginTypes ) {
    const plugin = pluginTypes[pluginName];

    if( 'init' in plugin && Object.keys(plugin['init']['parameters']).length > 0 ) {
      addPluginDialog(pluginName, 'init', null, plugin['init']['description'], plugin['init']['parameters']);
    }
  }*/
}

function addModules(modules) {
  moduleTypes = modules;

  for( moduleName in moduleTypes ) {
    for( pluginName in moduleTypes[moduleName] ) {
      const plugin = moduleTypes[moduleName][pluginName];
      console.log('addModules', pluginName, plugin);
      if( 'init' in plugin && Object.keys(plugin['init']['parameters']).length > 0 ) {
        // every new client makes the server resend modules: rebuilding a dialog that is open
        // would delete it under the user's hands (camera-picker §4.4)
        if( document.querySelector(`#${pluginName}_init_dialog.show`) )
          continue;
        addPluginDialog(pluginName, 'init', null, plugin['init']['description'], plugin['init']['parameters']);
      }
    }
  }
}

// After an add dialog of a plugin with live_type_hints opens: read its options again (the cameras
// connected now) and replace the <option>s in place - spec 2026-11-06-camera-picker §4.4. The dialog
// is already showing (a ZED query takes ~1.7 s cold), so only the re-read fields say Detecting….
async function refreshLiveOptions(pluginName, fields) {
  const dialog = document.getElementById(`${pluginName}_init_dialog`);
  if( !dialog || dialog.dataset.refreshing )
    return;
  dialog.dataset.refreshing = '1';
  dialog.querySelector('.live-options-notice')?.remove();

  const helps = fields.map(f => document.getElementById(`${pluginName}_init_${f}_help`)).filter(el => el);
  const original = helps.map(el => el.innerHTML);
  helps.forEach(el => el.textContent = 'Detecting…');

  const parameters = await fetchLiveParameters(pluginName);
  delete dialog.dataset.refreshing;

  if( parameters == null ) {
    helps.forEach((el, i) => el.innerHTML = original[i]);
    dialog.querySelector('.modal-body')?.insertAdjacentHTML('afterbegin',
      '<div class="live-options-notice text-warning mb-2">Could not detect the cameras; the list may be out of date</div>');
    return;
  }

  for( const update of liveSelectUpdates(parameters) ) {
    const select = document.getElementById(`${pluginName}_init_${update.param}`);
    if( !select )
      continue;
    select.innerHTML = update.html;
    $(select).trigger('change');
    const help = document.getElementById(`${pluginName}_init_${update.param}_help`);
    if( help )
      help.innerHTML = update.help;
  }
}

function capitalizeTitle(string) {
    if( string.length < 4 )
      return string.toUpperCase();
    else
      return string.charAt(0).toUpperCase() + string.slice(1);
}

function pluginMenuBar() {
  if( moduleTypes == undefined )
    return '';
 
  let html = '';
  
  for( module in moduleTypes ) {
    html += `
      <span>
      <a class="dropdown-toggle ms-3" href="#" data-bs-target="#{add_plugin_${module}_dropdown}" data-bs-toggle="dropdown" aria-expanded="false" style="color: #aaaaaa;">
        ${capitalizeTitle(module)}
      </a>
      <span class="dropdown float-end float-top" id="add_plugin_${module}_dropdown">
      <ul class="dropdown-menu" id="add_plugin_${module}_menu">
    `;
    
    for( plugin in moduleTypes[module] )
      html += `<li><a class="dropdown-item" id="menu_create_plugin_${plugin}" href="#">${plugin}</a></li>`; // data-bs-toggle="modal" data-bs-target="#${plugin}_init_dialog"

    html += `</ul></span></span>`;
  }

  return html; 
}  

// <li class="divider">
function pluginContextMenu() {
  if( moduleTypes == undefined )
    return '';
 
  let html = `
    <ul id="plugin_context_menu" class="nav-item dropdown-menu" role="menu" style="display:none">
      <li><a class="dropdown-item" href="#">Presets</a>
          <ul class="submenu dropdown-menu" id="plugin_context_menu_presets"></ul>
      </li>
      <li><a class="dropdown-item" href="#" onclick="removeAll()">Remove All</a></li>
      <li><hr class="dropdown-divider"></li> 
  `;

  for( module in moduleTypes ) {
    html += `
      <li><a class="dropdown-item" href="#">${capitalizeTitle(module)}</a>
        <ul class="submenu dropdown-menu">
    `;
    
    for( plugin in moduleTypes[module] )
      html += `<li><a class="dropdown-item" id="plugin_context_menu_${plugin}" href="#">${plugin}</a></li>`;

    html += `</ul></li>`;
  }
    
  html += `</ul>`;
  return html; 
}  

function nodeLayoutInsertPos() {
  var contextMenu = document.getElementById('plugin_context_menu');
  var nodeEditor = document.getElementById('drawflow').getBoundingClientRect();
  
  var pos = {
    x: parseInt(contextMenu.style.left) - nodeEditor.left, 
    y: parseInt(contextMenu.style.top) - nodeEditor.top,
  };
  
  if( isNaN(pos.x) || isNaN(pos.y) ) {
    const nodes = document.querySelectorAll('.drawflow-node');

    var x = 10;
    var y = 10;
      
    if( nodes.length > 0 ) {
      const node = nodes[nodes.length-1];
      const abs_rect = node.getBoundingClientRect();
      pos.x = node.offsetLeft + abs_rect.width + 60;
      pos.y = node.offsetTop;
    }
    else
    {
      pos.x = 10;
      pos.y = 10;
    }
  }

  return pos;
}

function addGraphEditor(name, id, grid_options) {

  // Camera view never displays the graph - it only needs `drawflow` to exist
  // (every addPlugin() call depends on it via drawflow.addNode()/
  // getNodesFromName()), not an actual visible editor. Build the engine
  // against a plain hidden <div>, completely outside GridStack, so no widget
  // ever gets inserted at GraphEditor's saved position (see the 2026-09-22
  // revision note at this function's call site for why that insert itself -
  // not just a later removal - was displacing the real camera widgets).
  // Skips the operator-only right-click "add plugin" menu setup below too -
  // that's an editing action, not something the passive kiosk view needs.
  if( viewMode === 'sensor' ) {
    if( drawflow )
      return true;  // already built earlier this session - nothing to redo
    const hiddenHost = document.createElement('div');
    hiddenHost.id = 'drawflow';
    hiddenHost.style.display = 'none';
    document.body.appendChild(hiddenHost);
    drawflow = new Drawflow(hiddenHost);
    drawflow.start();
    drawflow.on('nodeMoved', onNodeMoved);
    drawflow.on('nodeRemoved', onNodeRemoved);
    drawflow.on('connectionCreated', onNodeConnectionCreated);
    drawflow.on('connectionRemoved', onNodeConnectionRemoved);
    return true;
  }

  let titlebar_html = pluginMenuBar();

  let html = `
    <div id="drawflow" class="mt-1 flex-grow-1 w-100"></div>
  `;

  let widget = addGridWidget(
     id, "Node Editor",
     html, titlebar_html,
     Object.assign({x: 0, y: 0, w: 8, h: 11}, grid_options)
  );

  let editor = document.getElementById("drawflow");

  editor.addEventListener('mouseenter', (event) => {
    //console.log('onmouseleave(drawflow) => disabling grid move/resize');
    grid.disable();
  });

  editor.addEventListener('mouseleave', (event) => {
    //console.log('onmouseleave(drawflow) => enabling grid move/resize');
    grid.enable();
  });

  drawflow = new Drawflow(editor);
  drawflow.start();

  drawflow.on('nodeMoved', onNodeMoved);
  drawflow.on('nodeRemoved', onNodeRemoved);

  drawflow.on('connectionCreated', onNodeConnectionCreated);
  drawflow.on('connectionRemoved', onNodeConnectionRemoved);

  //drawflow.on('contextmenu', onNodeContextMenu);
  document.body.appendChild(fromHTML(pluginContextMenu()));

  for( pluginName in pluginTypes ) {
    const plugin = pluginTypes[pluginName];
    
    let pluginMenus = [
      document.getElementById(`menu_create_plugin_${pluginName}`),
      document.getElementById(`plugin_context_menu_${pluginName}`),
    ];
    
    pluginMenus.forEach(pluginMenu => {
      if( 'init' in plugin && Object.keys(plugin['init']['parameters']).length > 0 ) {
        pluginMenu.addEventListener('click', (event) => {
          console.log(`opening init dialog for ${plugin['name']}`);
          // getOrCreateInstance: a second click on the menu must not stack a second modal/backdrop
          bootstrap.Modal.getOrCreateInstance(`#${plugin['name']}_init_dialog`).show();
          if( plugin['live_type_hints'] )
            refreshLiveOptions(plugin['name'], liveFields(plugin['init']['parameters']));
        });
      }
      else {
        pluginMenu.addEventListener('click', (event) => {
          sendWebsocket({
            'add_plugin': {
              'type': plugin['name'],
              'layout_node': nodeLayoutInsertPos(),
            }
          });
        });
      }
    });
  }
  
  $(".drawflow").contextMenu({
    menuSelector: "#plugin_context_menu",
    menuSelected: function (invokedOn, selectedMenu) {
        //var msg = "You selected the menu item '" + selectedMenu.text() + "' on the value '" + invokedOn.text() + "'";
        console.log('selected context menu', selectedMenu, msg);
    }
  });

  return widget;
}

function onNodeMoved(id) {
  const node = drawflow.getNodeFromId(id);
  //console.log('node moved', id, node);
  sendWebsocket({
    'config_plugin': {
      'name': node['name'],
      'layout_node': {'x': node['pos_x'], 'y': node['pos_y']}
    } 
  });
}

function onNodeRemoved(id) {
  const pluginName = nodeIdToName[id];
  delete nodeIdToName[id];
  console.log(`node removed id=${id} name=${pluginName}`);
  
  if( !ignoreGraphEvents )
    sendWebsocket({'remove_plugin': pluginName});
}

function onNodeConnectionCreated(event) {
  console.log(`onNodeConnectionCreated(ignore=${ignoreGraphEvents})`, event);
  
  if( ignoreGraphEvents )
    return;
    
  sendWebsocket({
    'add_connection': {
      'input': drawflow.getNodeFromId(event['input_id'])['name'],
      'input_channel': Number(event['input_class'].split('_').at(-1)) - 1,
      'output': drawflow.getNodeFromId(event['output_id'])['name'],
      'output_channel': Number(event['output_class'].split('_').at(-1)) - 1
    } 
  });
}

function onNodeConnectionRemoved(event) {
  console.log(`onNodeConnectionRemoved(ignore=${ignoreGraphEvents})`, event);
  
  if( ignoreGraphEvents )
    return;
    
  sendWebsocket({
    'remove_connection': {
      'input': drawflow.getNodeFromId(event['input_id'])['name'],
      'input_channel': Number(event['input_class'].split('_').at(-1)) - 1,
      'output': drawflow.getNodeFromId(event['output_id'])['name'],
      'output_channel': Number(event['output_class'].split('_').at(-1)) - 1
    } 
  });
}

/*function onNodeContextMenu(event) {
  if( event.target.className != "drawflow" ) {
    console.log(`ignoring contextmenu event from '${event.srcElement.className}'`);
    return;
  }
  
  // return native menu if pressing control
  if( event.ctrlKey ) 
    return;
                
  console.log('onNodeContextMenu', event);
  //addNodeContextMenu(event.clientX, event.clientY);
  
  //$('#contextMenu').show().css({position: "absolute", left: event.clientX, top: event.clientY});
  //openContextMenu('#contextMenu', event);
  
  return false;
}*/

function addNodeContextMenu(x, y) {
  let html = `
    <ul class="dropdown-menu" id="node_context_menu" style="position: absolute; left: 0; top: 0;">
      <li><a class="dropdown-item">ABC</a></li>
    </ul>
  `;
   
  html = `
    <ul id="node_context_menu" style="position: absolute; left: ${x}; top: ${y};">
      <li><a>ABC</a></li>
    </ul>
  `;
  
  //html = `<p style="position: absolute; left: 100; top: 100;">ABC123</p>`;
   
  let contextMenu = fromHTML(html);
  //document.getElementById("drawflow").appendChild(contextMenu);
  document.body.appendChild(contextMenu);
  console.log('opening node editor context menu', contextMenu);
  return contextMenu;
}

function addDialog(id, title, html, xl, onsubmit, oncancel) {
  // Replace, not duplicate: removePlugins() never cleans up a plugin's config dialog
  // (only outputListeners/stateListeners/videoFrameListeners), so remove+re-add of the
  // same-named plugin used to leave the old #<id> modal sitting in the DOM and append a
  // second one with the identical id. getElementById()/jQuery's $('#id') both resolve to
  // whichever matches first in document order - the OLD one, since new ones are appended
  // at the end - so the dialog that actually opened kept showing stale parameter defaults
  // from before the remove, and its bound onsubmit closure kept sending that stale data.
  document.getElementById(id)?.remove();
  $('body').append(`
  <div class="modal fade" id="${id}" tabindex="-1" aria-labelledby="${id}_label" aria-hidden="true">
      <div class="modal-dialog ${xl ? 'modal-xl' : ''}">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="${id}_label">${title}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close" style="color: #eeeeee;"></button>
          </div>
          <div class="modal-body">
            ${html}
          </div>
          <div class="modal-footer">
            <button id="${id}_cancel" type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button> 
            <button id="${id}_submit" type="button" class="btn btn-secondary" data-bs-dismiss="modal">Okay</button>
          </div>
        </div>
      </div>
    </div>
  `);
  
  if( onsubmit != undefined )
    $(`#${id}_submit`).on('click', onsubmit);
    
  if( oncancel != undefined )
    $(`#${id}_cancel`).on('click', oncancel);
}

function escapeHtmlPreserveBr(text) {
  // Temporarily replace <br> with a placeholder
  const BR_PLACEHOLDER = '__BR__';
  text = text.replace(/<br\s*\/?>/gi, BR_PLACEHOLDER);

  // escape HTML special characters
  text = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Restore <br>
  return text.replace(new RegExp(BR_PLACEHOLDER, 'g'), '<br>');
}


function addPluginDialog(plugin_name, stage, title, description, parameters, max_per_column) {
  if( title == undefined )
    title = plugin_name;
    
  if( max_per_column == undefined )
    max_per_column = 6;
    
  const num_params = Object.keys(parameters).length;
  const num_columns = Math.ceil(num_params / max_per_column);
  
  const dialog_id = `${plugin_name}_${stage}_dialog`;
  const dialog_xl = (num_params > max_per_column);
  
  let html = '';

  if( description != null )
    html += `<p>${escapeHtmlPreserveBr(description)}</p>`;
    
  html += `<div class="container">`;
  html += `<div class="row">`;
  html += `<div class="col-sm">`;

  var select2_args = {};
  let param_count = 0;
  
  for( param_name in parameters ) {
    const param = parameters[param_name];
    const id = `${plugin_name}_${stage}_${param_name}`;
    
    if( param['hidden'] )
      continue;
    
    if( param_count > 0 && param_count % Math.ceil(num_params / num_columns) == 0 )
      html += `</div><div class="col-sm">`;
      
    let value = '';
    let value_html = '';
    
    if( 'default' in param && param['default'] != undefined ) {
      value = param['default'];
      value_html = `value="${escapeHtml(value)}"`;
    }

    let help = '';

    if( 'help' in param )
      help = `<div id="${id}_help" class="form-text">${escapeHtml(param['help'])}</div>`;
    
    if( param['type'] == 'boolean' ) {
      param['options'] = [true, false]
    }
    
    const has_options = ('options' in param);
    const has_suggestions = ('suggestions' in param);
    
    if( has_options || has_suggestions ) {
      var input_html = '';
      
      if( has_options ) {
        var options = param['options'];
        if( options.length > 8 )
          select2_args[id] = {};
        else
          select2_args[id] = {minimumResultsForSearch: Infinity};
      }
      else if( has_suggestions ) {
        var options = param['suggestions'];
        select2_args[id] = {tags: true, placeholder: 'enter'}; //tags: true, placeholder: 'enter'};
      }
      
      input_html += `<br/><select id="${id}" class="form-control select2" style="width: 100%;">\n`
      // options may be {value, label}: a camera shows its model, the preset stores its by-id (dialog_options.js)
      input_html += buildOptionsHtml(options, param['default'], has_suggestions && !has_options);
      input_html += `</select>\n`;
    }
    /*else if( 'suggestions' in param ) {
      const list_id = `${id}_list`;
      var input_html = `<input id="${id}" type="${type}" class="form-control" list="${list_id}"/>`;
      
      input_html += `<datalist id="${list_id}">`;
      
      for( i in param['suggestions'] ) {
        input_html += `<option>${param['suggestions'][i]}</option>`;
      }
      
      input_html += `</datalist>`; 
    }*/
    else if( 'multiline' in param ) {
      var input_html = `<textarea id="${id}" class="form-control" aria-describedby="${id}_help" rows=${param['multiline']}>${value}</textarea>`;
    }
    else if( 'color' in param ) {
      var input_html = `<input id="${id}" type="color" class="form-control" aria-describedby="${id}_help" ${value_html}/>`;
    }
    else {
      var type = (param['type'] == 'integer') ? 'number' : param['type'];
      
      if( param.password )
        type = 'password';
        
      var input_html = `<input id="${id}" type="${type}" class="form-control" aria-describedby="${id}_help" ${value_html}>`;
    }

    html += `
      <div class="mb-3">
        <label for="${id}" class="form-label">${param['display_name']}</label>
        ${input_html}
        ${help}
      </div>
    `;
    
    param_count += 1;
  }
  
  html += `</div></div></div>`;
  
  let onsubmit = function() {
    //console.log(`onsubmit(${plugin_name})`);
    let args = {};
    
    for( param_name in parameters ) {
      if( parameters[param_name]['hidden'] )
        continue;
      let value = document.getElementById(`${plugin_name}_${stage}_${param_name}`).value;
      if( value != undefined && value.length > 0 ) { // input.value are always strings
        const type = parameters[param_name]['type'];
        if( type == 'integer' || type == 'number' )
          value = Number(value);
        args[param_name] = value;
      }
    }
    
    console.log(`${stage}Plugin(${plugin_name}) =>`);
    console.log(args);

    args['name'] = plugin_name;
    args['layout_node'] = nodeLayoutInsertPos();
    
    let msg = {};
    
    if( stage == 'init' ) {
      args['type'] = plugin_name;
      msg['add_plugin'] = args;
    }
    else {
      args['name'] = plugin_name;
      msg[`${stage}_plugin`] = args;
    }

    sendWebsocket(msg);
  }

  addDialog(dialog_id, title, html, dialog_xl, onsubmit);
  
  for( select2_id in select2_args ) {
    select2_args[select2_id]['dropdownParent'] = $(`#${dialog_id}`);
    $(`#${select2_id}`).select2(select2_args[select2_id]);
  }
  
  return dialog_id;
}

function fitGridWidgetContents(el) {
  //let width = parseInt(el.getAttribute('gs-w')) || 0;
  //let height = parseInt(el.getAttribute('gs-h')) || 0;
  //console.log('grid widget resize', width, height, el.offsetWidth, el.offsetHeight);
  //let card_title = el.querySelector('.card-title');
  //console.log('grid widget resize', card_title, card_title.offsetHeight);
  //el.querySelector('.collapse').style.height = `${el.offsetHeight - card_title.offsetHeight - 50}px`;
  console.log('grid widget resize', el.offsetWidth, el.offsetHeight);
  
  let grid_rect = el.getBoundingClientRect();

  let card = el.querySelector('.card-body');
  let card_rect = card.getBoundingClientRect();
  
  let card_inner = el.querySelector('.collapse');
  let card_inner_rect = card_inner.getBoundingClientRect();
  
  console.log(`grid widget rect height=${grid_rect.height}  bottom=${grid_rect.bottom}`);
  console.log(`card widget rect height=${card_rect.height}  bottom=${card_rect.bottom}`);
  console.log(`card inner rect height=${card_inner_rect.height}  bottom=${card_inner_rect.bottom}`);
  
  //if( card_inner_rect.bottom > card_rect.bottom ) {
    //card_inner.style.height = `${card_inner_rect.height - (card_inner_rect.bottom - card_rect.bottom)}px`;
    //console.log('set height', card_inner.style.height);
  //}
  /*if( card_rect.height > grid_rect.height ) {
    //card.style.height = `${grid_rect.height}px`;
    card_inner.style.height = `${card_inner.offsetHeight - (card_rect.height - grid_rect.height)}px`;
  }*/
  //card.style.height = `${el.offsetHeight}px`;
  //el.querySelector('.collapse').style.height = `${el.offsetHeight-150}px`;
}


/**
 * https://stackoverflow.com/a/35385518
 * @param {String} HTML representing a single element.
 * @param {Boolean} flag representing whether or not to trim input whitespace, defaults to true.
 * @return {Element | HTMLCollection | null}
 */
function fromHTML(html, trim = true) {
  // Process the HTML string.
  html = trim ? html.trim() : html;
  if (!html) return null;

  // Then set up a new template element.
  const template = document.createElement('template');
  template.innerHTML = html;
  const result = template.content.children;

  // Then return either an HTMLElement or HTMLCollection,
  // based on whether the input HTML had one or more roots.
  if (result.length === 1) return result[0];
  return result;
}

