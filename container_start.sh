#!/bin/bash
# Container entrypoint: apply compiler patches then start studio
# This file is volume-mounted from the project directory and persists across container restarts.

echo "[container_start] Applying MLC compiler patches..."
python3 /opt/NanoLLM/apply_mlc_patches.py

# Start the MQTT broker (used by Attire_det_webrtc_MQTT_advan)
if ! command -v mosquitto &>/dev/null; then
    echo "[container_start] Installing mosquitto..."
    apt-get install -y -q mosquitto 2>/dev/null
fi
if command -v mosquitto &>/dev/null; then
    mosquitto -d 2>/dev/null && echo "[container_start] MQTT broker started on port 1883"
fi

# Auto-select WebSocket port (49000 default; fall back to 49001 if zombie socket present)
if python3 -c "import socket; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('',49000)); s.close()" 2>/dev/null; then
    WS_PORT=49000
else
    echo "[container_start] Port 49000 busy (zombie socket), using 49001"
    WS_PORT=49001
fi

# Auto-select Web port (8050 default; fall back to 8051 if zombie socket present)
if python3 -c "import socket; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('',8050)); s.close()" 2>/dev/null; then
    WEB_PORT=8050
else
    echo "[container_start] Port 8050 busy (zombie socket), using 8051"
    WEB_PORT=8051
fi

echo "[container_start] Starting Edge Agent Studio on ws-port=${WS_PORT} web-port=${WEB_PORT}..."
exec python3 -m nano_llm.studio --ws-port ${WS_PORT} --web-port ${WEB_PORT}
