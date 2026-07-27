/*
 * Copyright (c) 2023, NVIDIA CORPORATION. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
var connections = {};

function reportError(msg) {
  console.log(msg);
}
 
function getWebsocketProtocol() {
  return window.location.protocol == 'https:' ? 'wss://' : 'ws://';
}

function getWebsocketURL(name, port=8554) {  // wss://192.168.1.2:8554/name
  return `${getWebsocketProtocol()}${window.location.hostname}:${port}/${name}`;
}
  
function checkMediaDevices() {
  return (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !navigator.mediaDevices.enumerateDevices) ? false : true;
}

function hasConnectionType(type) {  // 'inbound' or 'outbound'
	for( const connection in connections )
		if( connections[connection].type == type )
			return true;
	return false;
}

function flushPendingIceCandidates(url) {
  const conn = connections[url];
  const pending = conn.pendingIceCandidates || [];
  if (pending.length === 0) return;
  console.log(`[WebRTC] flushing ${pending.length} queued ICE candidates for ${url}`);
  pending.forEach(ice => {
    conn.webrtcPeer.addIceCandidate(new RTCIceCandidate(ice)).catch(e => {
      console.error('[WebRTC] addIceCandidate (queued) failed:', e.message, JSON.stringify(ice));
    });
  });
  conn.pendingIceCandidates = [];
}

function onIncomingSDP(url, sdp) {
  console.log('[WebRTC] onIncomingSDP', url, sdp.type);

  function onLocalDescription(desc) {
    console.log('[WebRTC] sending local SDP answer', url);
    connections[url].webrtcPeer.setLocalDescription(desc)
      .then(() => {
        connections[url].websocket.send(JSON.stringify({ type: 'sdp', 'data': connections[url].webrtcPeer.localDescription }));
      }).catch(reportError);
  }

  if( connections[url].type == 'inbound' ) {
    connections[url].webrtcPeer.setRemoteDescription(sdp)
      .then(() => {
        console.log('[WebRTC] setRemoteDescription OK, calling createAnswer');
        flushPendingIceCandidates(url);
        return connections[url].webrtcPeer.createAnswer();
      })
      .then(onLocalDescription)
      .catch(e => {
        console.error('[WebRTC] setRemoteDescription/createAnswer failed:', e);
        connections[url].webrtcPeer.createAnswer()
          .then(onLocalDescription)
          .catch(reportError);
      });
  }
  else if( connections[url].type == 'outbound' ) {
    const constraints = { audio: false, video: { frameRate: { max: 15 }, deviceId: connections[url].deviceId } };
    connections[url].webrtcPeer.setRemoteDescription(sdp)
      .then(() => {
        flushPendingIceCandidates(url);
        return navigator.mediaDevices.getUserMedia(constraints);
      })
      .then((stream) => {
        stream.getTracks().forEach(track => connections[url].webrtcPeer.addTrack(track, stream));
        return connections[url].webrtcPeer.createAnswer();
      })
      .then(onLocalDescription)
      .catch(reportError);
  }
}

function onIncomingICE(url, ice) {
  console.log('[WebRTC] server ICE candidate received:', JSON.stringify(ice));
  const conn = connections[url];
  // Queue if remote description isn't set yet — server sends candidates almost
  // immediately after the offer, before setRemoteDescription() Promise resolves.
  if (!conn.webrtcPeer || !conn.webrtcPeer.remoteDescription) {
    conn.pendingIceCandidates = conn.pendingIceCandidates || [];
    conn.pendingIceCandidates.push(ice);
    console.log(`[WebRTC] queued ICE candidate (remoteDescription not yet set), queue size: ${conn.pendingIceCandidates.length}`);
    return;
  }
  conn.webrtcPeer.addIceCandidate(new RTCIceCandidate(ice)).then(() => {
    console.log('[WebRTC] addIceCandidate OK:', (ice.candidate||'').substring(0, 70));
  }).catch(e => {
    console.error('[WebRTC] addIceCandidate failed:', e.message, JSON.stringify(ice));
  });
}

function onAddRemoteStream(event) {
  var url = event.target.url;
  console.log('Adding remote stream to HTML video player (%s)', url);
  const videoEl = connections[url].videoElement;
  videoEl.srcObject = event.streams[0];
  videoEl.play().catch((e) => console.warn('WebRTC video play() rejected:', e));
}

function onIceCandidate(event) {
  var url = event.target.url;

  if (event.candidate == null)
    return;

  console.log('Sending ICE candidate out (%s)\n' + JSON.stringify(event.candidate), url);
  connections[url].websocket.send(JSON.stringify({'type': 'ice', 'data': event.candidate }));
}

function getConnectionStats(url, reportType) { 
  if( reportType == undefined ) 
    reportType = 'all'; 

  connections[url].webrtcPeer.getStats(null).then((stats) => { 
    let statsOutput = ''; 

    stats.forEach((report) => { 
      if( reportType == 'inbound-rtp' && report.type === 'inbound-rtp' && report.kind === 'video') { 
        statsOutput += `# inbound-rtp\n`; 

        if( connections[url].bytesReceived != undefined ) 
          statsOutput += `bitrate:          ${((report.bytesReceived - connections[url].bytesReceived) / 125000).toFixed(3)} mbps\n`; 

        connections[url].bytesReceived = report.bytesReceived; 

        statsOutput += `bytesReceived:    ${report.bytesReceived}\n`; 
        statsOutput += `packetsReceived:  ${report.packetsReceived}\n`; 
        statsOutput += `packetsLost:      ${report.packetsLost}\n`; 
        statsOutput += `framesReceived:   ${report.framesReceived}\n`; 
        statsOutput += `framesDropped:    ${report.framesDropped}\n`; 
        statsOutput += `frameWidth:       ${report.frameWidth}\n`; 
        statsOutput += `frameHeight:      ${report.frameHeight}\n`; 
        statsOutput += `framesPerSecond:  ${report.framesPerSecond}\n`; 
        statsOutput += `keyFramesDecoded: ${report.keyFramesDecoded}\n`; 
        statsOutput += `jitter:           ${report.jitter}\n`; 
      } 
      else if( reportType =='outbound-rtp' && report.type === 'outbound-rtp' && report.kind === 'video') { 
        statsOutput += `# outbound-rtp\n`; 

        if( connections[url].bytesSent != undefined ) 
          statsOutput += `bitrate:          ${((report.bytesSent - connections[url].bytesSent) / 125000).toFixed(3)} mbps\n`; 

        connections[url].bytesSent = report.bytesSent; 

        statsOutput += `bytesSent:        ${report.bytesSent}\n`; 
        statsOutput += `packetsSent:      ${report.packetsSent}\n`; 
        statsOutput += `packetsResent:    ${report.retransmittedPacketsSent}\n`; 
        statsOutput += `framesSent:       ${report.framesSent}\n`; 
        statsOutput += `frameWidth:       ${report.frameWidth}\n`; 
        statsOutput += `frameHeight:      ${report.frameHeight}\n`; 
        statsOutput += `framesPerSecond:  ${report.framesPerSecond}\n`; 
        statsOutput += `keyFramesSent:    ${report.keyFramesEncoded}\n`; 
      } 
      else if( reportType == 'all' || reportType == report.type ) { 
        statsOutput += `<h2>Report: ${report.type}</h2>\n<strong>ID:</strong> ${report.id}<br>\n` + 
        `<strong>Timestamp:</strong> ${report.timestamp}\n`; 

        Object.keys(report).forEach((statName) => { 
          if (statName !== 'id' && statName !== 'timestamp' && statName !== 'type') 
            statsOutput += `<strong>${statName}:</strong> ${report[statName]}\n`; 
        }); 
      } 
    }); 

    var statsElement = (connections[url].type == 'inbound') ? 'connection-stats-play' : 'connection-stats-send'; 
    statsElement = document.getElementById(statsElement);
    
    if( statsElement != null )
        statsElement.innerHTML = statsOutput; 
  }); 
} 

function onServerMessage(event) {
  var msg;
  var url = event.target.url;

  console.log('[WebRTC-RAW] msg from server:', event.data.substring(0, 80));

  try {
    msg = JSON.parse(event.data);
  } catch (e) {
    return;
  }

  if( !connections[url].webrtcPeer ) {
    connections[url].webrtcPeer = new RTCPeerConnection(connections[url].webrtcConfig);
    connections[url].webrtcPeer.url = url;

    connections[url].webrtcPeer.onconnectionstatechange = (ev) => {
      console.log('WebRTC connection state (%s) ' + connections[url].webrtcPeer.connectionState, url);
      
      if( connections[url].webrtcPeer.connectionState == 'connected' )
        setInterval(getConnectionStats, 1000, url, connections[url].type == 'inbound' ? 'inbound-rtp' : 'outbound-rtp');
    }

    if( connections[url].type == 'inbound' ) {
      connections[url].webrtcPeer.ontrack = onAddRemoteStream;
    }
    
    connections[url].webrtcPeer.onicecandidate = onIceCandidate;
  }

  switch (msg.type) {
    case 'sdp': onIncomingSDP(url, msg.data); break;
    case 'ice': onIncomingICE(url, msg.data); break;
    default: break;
  }
}

function playStream(url, videoElement) {
  console.log('playing stream ' + url); 
   
  connections[url] = {};

  connections[url].type = 'inbound';
  connections[url].videoElement = videoElement;
  connections[url].webrtcConfig = { 'iceServers': [] };  //modified
  // connections[url].webrtcConfig = { 'iceServers': [{ 'urls': 'stun:127.0.0.1:3478'}] };  //modified
  // connections[url].webrtcConfig = { 'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] }; //origin
   
  connections[url].websocket = new WebSocket(url);
  connections[url].websocket.addEventListener('message', onServerMessage);
}

function sendStream(url, deviceId) {
  console.log(`sending stream ${url}  (deviceId=${deviceId})`);

	if( url in connections && connections[url].type == 'outbound' ) {
		// replace the outbound stream in the existing connection
		replaceStream(url, deviceId);
		return false;
	}
	else {
		// create a new outbound connection
		connections[url] = {};

		connections[url].type = 'outbound';
		connections[url].deviceId = deviceId;
    connections[url].webrtcConfig = { 'iceServers': [] };  //modified
    // connections[url].webrtcConfig = { 'iceServers': [{ 'urls': 'stun:127.0.0.1:3478'}] };  //modified
		// connections[url].webrtcConfig = { 'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] }; //origin

		connections[url].websocket = new WebSocket(url);
		connections[url].websocket.addEventListener('message', onServerMessage);
		
		return true;
	}
}

function replaceStream(url, deviceId) {
	console.log(`replacing stream for outbound WebRTC connection to ${url}`);
	console.log(`old device ID:  ${connections[url].deviceId}`);
	console.log(`new device ID:  ${deviceId}`);
	
	var constraints = {'audio': false, 'video': { deviceId: deviceId }};
	
	navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
		const [videoTrack] = stream.getVideoTracks();
		const sender = connections[url].webrtcPeer.getSenders().find((s) => s.track.kind === videoTrack.kind);
		console.log('found sender:', sender);
		sender.replaceTrack(videoTrack);
		connections[url].deviceId = deviceId;
	}).catch(reportError);
}
