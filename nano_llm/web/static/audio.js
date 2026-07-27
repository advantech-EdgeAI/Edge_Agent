/*
 * handles audio input/output device streaming
 * websocket.js should be included also
 */
var audioContext;       // AudioContext
var audioInputTrack;    // MediaStreamTrack
var audioInputDevice;   // MediaStream
var audioInputStream;   // MediaStreamAudioSourceNode
var audioInputCapture;  // AudioWorkletNode
var audioOutputWorker;  // AudioWorkletNode
var audioOutputMuted = false;
var remoteCameraVideo;  // 隱藏的 <video> 元素，用來播放攝影機的 MediaStream
var remoteCameraCanvas; // 隱藏的 <canvas> 元素，用來擷取靜態畫面
var remoteCameraCaptureInterval; // 定期擷取畫面送出的 setInterval id（VAD 自動判斷語音時，讓 AutoPrompt_ICL 每次都拿到最新畫面）

function checkMediaDevices() {
  return (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !navigator.mediaDevices.enumerateDevices) ? false : true;
}

function enumerateAudioDevices() {
	var selectInput = document.getElementById('audio-input-select');
	var selectOutput = document.getElementById('audio-output-select');
	
	if( !checkMediaDevices() ) {
		selectInput.add(new Option('use HTTPS to enable browser audio'));
		selectOutput.add(new Option('use HTTPS to enable browser audio'));
		return;
	}
	
	navigator.mediaDevices.getUserMedia({audio: true, video: false}).then((stream) => { // get permission from user
		navigator.mediaDevices.enumerateDevices().then((devices) => {
			stream.getTracks().forEach(track => track.stop()); // close the device opened to get permissions
			devices.forEach((device) => {
				console.log(`Browser media device:  ${device.kind}  label=${device.label}  id=${device.deviceId}`);
				
				if( device.kind == 'audioinput' )
					selectInput.add(new Option(device.label, device.deviceId));
				else if( device.kind == 'audiooutput' )
					selectOutput.add(new Option(device.label, device.deviceId));
			});
			
			if( selectInput.options.length == 0 )
				selectInput.add(new Option('browser has no audio inputs available'));

			if( selectOutput.options.length == 0 )
				selectOutput.add(new Option('browser has no audio outputs available'));
		});
	}).catch(reportError);
}

function openAudioDevices(inputDeviceId, outputDeviceId) {
	if( !checkMediaDevices() ) {
		console.error('getUserMedia() unavailable -- use HTTPS to enable browser audio');
		return;
	}
	
	if( inputDeviceId == undefined )
		inputDeviceId = document.getElementById('audio-input-select').value;
	
	if( outputDeviceId == undefined )
		outputDeviceId = document.getElementById('audio-output-select').value;
	
	const constraints = {
		video: false,
		audio: {
			deviceId: inputDeviceId
		},
	};
	
	navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
		console.log('Opened audio input device %s', inputDeviceId);

    audioInputDevice = stream;
		audioInputTrack = stream.getAudioTracks()[0];
	  audioSettings = audioInputTrack.getSettings();
		
		audioInputTrack.enabled = false;  // mute the mic by default
		
		console.log(audioInputTrack);
		console.log(audioSettings);
		
		/*options = {
			//mimeType: 'audio/webm; codecs=opus',
			mimeType: 'audio/webm; codecs=pcm',
		}
		
		audioMicRecorder = new MediaRecorder(audioInputDevice, options);
		audioMicRecorder.ondataavailable = onMicAudio;
		audioMicRecorder.start(250);  // capture interval in milliseconds */
		
		options = {
			//'latencyHint': 1.0,
			'sampleRate': audioSettings.sampleRate,
			'sinkId': outputDeviceId,
		};
		
		audioContext = new AudioContext(options);
		audioInputStream = audioContext.createMediaStreamSource(audioInputDevice);
		audioContext.audioWorklet.addModule("/static/audioWorkers.js").then(() => {
			audioInputCapture = new AudioWorkletNode(audioContext, "AudioCaptureProcessor");
			audioOutputWorker = new AudioWorkletNode(audioContext, "AudioOutputProcessor");
			audioInputStream.connect(audioInputCapture).connect(audioOutputWorker).connect(audioContext.destination);
			audioInputCapture.port.onmessage = onAudioInputCapture;
		});
	}).catch(reportError);
}

function onAudioInputCapture(event) {

	if( audioInputTrack.enabled )  // unmuted
		sendWebsocket(event.data, type=MESSAGE_AUDIO);  // event.data is a Uint16Array
	
  //console.log('onAudioInputCapture()', event.data);
	
  /*msg = event.data;
	
	if( msg['type'] != 'audio' )
		return;
	
	// encode to base64
	var reader = new FileReader();
	reader.readAsDataURL(new Blob([msg['data']]));
	
	reader.onloadend = function () {
		json = JSON.stringify({
				'type': 'audio',
				'size': msg['data'].length * 2,  // 16-bit samples
				'data': reader.result.slice(reader.result.indexOf(',') + 1), // remove the `data:...;base64,` header
				'settings': audioInputTrack.getSettings(),
			});
		websocket.send(json);
	};*/
}

function onAudioOutput(samples) {
	if( audioOutputWorker != undefined && !audioOutputMuted ) {
		int16Array = new Int16Array(samples);
		audioOutputWorker.port.postMessage(int16Array, [int16Array.buffer]);
	}
}

/*function onMicAudio(event) {  // previous handler used with MediaRecorder
	data = event.data;
	console.log(`onMicAudio()  size=${data.size} type=${data.type}`);
	
	// encode to base64
	var reader = new FileReader();
	reader.readAsDataURL(data);
	
	reader.onloadend = function () {
		json = JSON.stringify({
				'type': 'audio',
				'size': data.size,
				'mime': data.type,
				'data': reader.result.slice(reader.result.indexOf(',') + 1), // remove the `data:...;base64,` header
			});
		websocket.send(json);
	};
}*/

function ensureRemoteCameraOpen(onReady) {
	if( remoteCameraVideo ) {
		if( onReady )
			onReady();
		return;  // 已經開過了，不重複要權限
	}
	navigator.mediaDevices.getUserMedia({ audio: false, video: true }).then((stream) => {
		// 優先重複使用 WebVideoIn plugin 產生的面板 <video> 元素（同一顆元素兼做預覽顯示
		// 跟下面 captureAndSendCameraFrame() 的擷取來源）；找不到（例如目前載入的
		// pipeline/preset 沒有 WebVideoIn 這個 plugin）就照舊建立隱藏的 detached video 元素。
		const widgetVideo = document.querySelector('video[data-role="web-video-in"]');
		remoteCameraVideo = widgetVideo || document.createElement('video');
		remoteCameraVideo.srcObject = stream;
		remoteCameraCanvas = document.createElement('canvas');
		if( onReady ) {
			remoteCameraVideo.onloadedmetadata = () => {  // 等第一個畫面真的解碼出來才觸發，videoWidth 才會有值
				if( widgetVideo ) {
					// 面板裡的 video 元素預設是隱藏的，等畫面真的準備好才顯示，並隱藏狀態文字
					widgetVideo.style.display = 'block';
					const statusEl = document.getElementById(widgetVideo.id.replace(/_video$/, '_status'));
					if( statusEl )
						statusEl.style.display = 'none';
				}
				onReady();
			};
		}

		remoteCameraVideo.muted = true;  // 這條 stream 本來就沒有音軌，靜音只是保險，避免瀏覽器自動播放政策卡住
		remoteCameraVideo.playsInline = true;  // 讓部分手機瀏覽器用行內顯示，不要跳全螢幕

		remoteCameraVideo.play();
	}).catch(reportError);
}

function captureAndSendCameraFrame() {
	if( !remoteCameraVideo || !remoteCameraVideo.videoWidth )
		return;  // 攝影機還沒開啟，或第一個畫面還沒到
	remoteCameraCanvas.width = remoteCameraVideo.videoWidth;
	remoteCameraCanvas.height = remoteCameraVideo.videoHeight;
	remoteCameraCanvas.getContext('2d').drawImage(remoteCameraVideo, 0, 0);
	remoteCameraCanvas.toBlob((blob) => {
		blob.arrayBuffer().then((buffer) => {
			sendWebsocket(buffer, type=MESSAGE_IMAGE, metadata='jpg');
		});
	}, 'image/jpeg', 0.85);
}

function muteAudioInput() {
	var button = document.getElementById('audio-input-mute');
	const muted = button.classList.contains('bi-mic-fill');
	console.log(`muteAudioInput(${muted})`);
	if( muted ) {
		button.classList.replace('bi-mic-fill', 'bi-mic-mute-fill');
		if( remoteCameraCaptureInterval ) {
			clearInterval(remoteCameraCaptureInterval);
			remoteCameraCaptureInterval = undefined;
		}
	} else {
		button.classList.replace('bi-mic-mute-fill', 'bi-mic-fill');
		ensureRemoteCameraOpen(() => {
			captureAndSendCameraFrame();
			// 現在改成由 VADFilter 自動偵測講話結束（不再需要按靜音才觸發），
			// 所以畫面也要跟著定期更新，讓每次自動判斷出的問題都能配到當下的最新畫面。
			remoteCameraCaptureInterval = setInterval(captureAndSendCameraFrame, 1000);
		});
	}
	if( audioInputTrack != undefined )
		audioInputTrack.enabled = !muted;
}

function muteAudioOutput() {  
	var button = document.getElementById('audio-output-mute');
	const muted = button.classList.contains('bi-volume-up-fill');
	console.log(`muteAudioOutput(${muted})`);
	if( muted )
		button.classList.replace('bi-volume-up-fill', 'bi-volume-mute-fill');
	else
		button.classList.replace('bi-volume-mute-fill', 'bi-volume-up-fill');
	audioOutputMuted = muted;
}
