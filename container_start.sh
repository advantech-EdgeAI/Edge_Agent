#!/bin/bash
# Container entrypoint: apply compiler patches then start studio
# This file is volume-mounted from the project directory and persists across container restarts.

# Orin (nvgpu iGPU) fix, before anything touches CUDA: the image was built on Thor and
# keeps /etc/ld.so.conf.d/00-nvcr-310529430.conf pointing at Thor's OpenRM driver
# (/opt/nvidia/l4t-gpu-libs/openrm/libcuda.so). On Orin the runtime adds its own
# 00-nvcr-<random>.conf for /opt/nvidia/l4t-gpu-libs/nvgpu, and whichever file sorts
# first wins - so CUDA came up only some of the time ("No CUDA GPUs are available",
# cuInit error 100). Thor has no /dev/nvgpu and needs that OpenRM entry, so it is
# left alone there.
if [ -d /dev/nvgpu ] && [ -d /opt/nvidia/l4t-gpu-libs/nvgpu ]; then
    sed -i '\#^/opt/nvidia/l4t-gpu-libs/openrm$#d' /etc/ld.so.conf.d/*.conf
    ldconfig
    echo "[container_start] nvgpu GPU (Orin): libcuda -> $(ldconfig -p | awk '/libcuda.so.1 /{print $NF; exit}')"
fi

echo "[container_start] Applying MLC compiler patches..."
python3 /opt/NanoLLM/apply_mlc_patches.py

# JetPack 7.2.1 (L4T R39.2.1) fix: GStreamer's V4L2-CUVID wrapper elements
# (nvv4l2decoder for file-based VideoSource decode, nvv4l2h264enc for WebRTC output
# encode) both segfaulted the instant they were touched. Root-caused via strace, not
# guessed: the dynamic linker was resolving libnvidia-encode.so to a STALE 69KB copy
# baked into this image at /usr/local/lib/ (left over from when the image was built
# against an older L4T release), instead of the correct 268KB copy the host bind-mounts
# in via nvidia-container-runtime's CSV mechanism at
# /usr/lib/aarch64-linux-gnu/nvidia/libnvidia-encode.so (matching the *current* host's
# actual driver, R39.2.1) - /usr/local/lib is earlier in the linker's default search
# path, so the stale copy always won. libnvcuvidv4l2.so calling into that
# ABI-mismatched stale copy is what produced the NULL-pointer segfault. Deleting the
# stale shadow copy and refreshing the linker cache makes both decode AND encode work
# through their real hardware paths (nvv4l2decoder / nvv4l2h264enc) - no plugin-rank
# rerouting or software-encode fallback needed, full hardware acceleration restored.
# Gated on the L4T major version actually reported by the host (bind-mounted in at
# /etc/nv_tegra_release) rather than applied unconditionally: the same stale file is
# presumably also present in the image on JetPack 7.0 (R38.2) hosts, but was never
# observed to cause a problem there (plausibly because it happened to still be
# ABI-compatible with the R38.2-era driver the image was originally built against) -
# only remove it once a newer host driver is actually detected, so R38.2's already-
# working behavior is never touched.
if [ -f /etc/nv_tegra_release ]; then
    L4T_MAJOR=$(grep -oP '(?<=# R)[0-9]+' /etc/nv_tegra_release | head -1)
    export EDGE_AGENT_L4T_MAJOR="$L4T_MAJOR"
    if [ -n "$L4T_MAJOR" ] && [ "$L4T_MAJOR" -ge 39 ] && [ -f /usr/local/lib/libnvidia-encode.so ]; then
        rm -f /usr/local/lib/libnvidia-encode.so
        ldconfig 2>/dev/null
        echo "[container_start] L4T R${L4T_MAJOR} detected - removed stale /usr/local/lib/libnvidia-encode.so so the linker resolves the host's real driver copy instead"
    fi
fi

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

# EDGE_AGENT_LOAD=<preset> (start.sh): load it at start - also after `docker restart`, which otherwise
# comes back to an empty Studio (2026-11-05)
LOAD_ARGS=()
if [ -n "${EDGE_AGENT_LOAD:-}" ]; then
    echo "[container_start] Loading preset ${EDGE_AGENT_LOAD} at start"
    LOAD_ARGS=(--load "${EDGE_AGENT_LOAD}")
fi

echo "[container_start] Starting Edge Agent Studio on ws-port=${WS_PORT} web-port=${WEB_PORT}..."
exec python3 -m nano_llm.studio --ws-port ${WS_PORT} --web-port ${WEB_PORT} "${LOAD_ARGS[@]}"
