#!/bin/bash
set -e

# Resolve the directory this script lives in (the project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load the token from .env if the environment variable isn't already set
if [ -z "$HUGGINGFACE_TOKEN" ] && [ -f "$SCRIPT_DIR/.env" ]; then
    source "$SCRIPT_DIR/.env"
fi
# Without a token Studio starts offline: every model must already be under data/models.
# With one, missing HuggingFace models download on first use.
if [ -n "$HUGGINGFACE_TOKEN" ]; then
    HF_ARGS=(--env HUGGINGFACE_TOKEN="$HUGGINGFACE_TOKEN")
else
    echo "No HUGGINGFACE_TOKEN (.env): starting offline - models are read from data/models only."
    echo "  To download missing models, create .env in the project root with HUGGINGFACE_TOKEN=hf_..."
    HF_ARGS=(--env HF_HUB_OFFLINE=1 --env TRANSFORMERS_OFFLINE=1)
fi

echo "=== [1/4] Checking SSD mount status ==="
# "mount /ssd" (single-arg form) only works if /etc/fstab has a line whose
# mount-point column is exactly /ssd - it looks up the device from fstab,
# it does not mount "whatever disk happens to be plugged in". That fstab
# line is a manual, machine-local setup step (not part of this repo), so a
# freshly cloned checkout on a machine that never had it configured (or
# whose data disk isn't at /ssd) must skip this instead of failing outright.
if awk '$2 == "/ssd" { found=1 } END { exit !found }' /etc/fstab 2>/dev/null; then
    if ! mount | grep -q " /ssd "; then
        echo "SSD not mounted, mounting..."
        sudo mount /ssd
        echo "SSD mounted"
    else
        echo "SSD already mounted"
    fi
else
    echo "No /ssd entry in /etc/fstab - this machine doesn't use a dedicated SSD mount, skipping"
fi

echo "=== [2/4] Verifying Docker can see its images ==="
# Docker's data-root and containerd's root both live on /ssd. If either
# service started before /ssd finished mounting at boot, it initializes
# against an empty directory and never picks up the real data underneath
# once the mount lands - "SSD already mounted" above is then a false
# all-clear. Detect that directly (no images visible) rather than only
# inferring it from the mount check, and restart both to force a re-read.
if [ -z "$(docker images -q 2>/dev/null)" ]; then
    echo "Docker sees no images (it likely started before /ssd was mounted) - restarting containerd + Docker..."
    sudo systemctl restart containerd
    sleep 5
    sudo systemctl restart docker
    sleep 3

    if [ -z "$(docker images -q 2>/dev/null)" ]; then
        echo "ERROR: Docker still sees no images after restarting containerd + docker."
        echo "Check 'sudo journalctl -u containerd -u docker' for details."
        exit 1
    fi
    echo "Docker images visible after restart"
else
    echo "Docker images visible, skipping restart"
fi

echo "=== [3/4] Verifying Docker image exists ==="
# The code is volume-mounted, so the image only brings the runtime. edge_agent_jp7:latest is the
# Thor/Orin image (Docker Hub ispsae/nano_llm:4.0.0-jp7, sm_87 + sm_110, vLLM 0.27.1,
# 2026-11-07): the same tag on both machines.
IMAGE_TAG="edge_agent_jp7:latest"
CONTAINER_NAME="edge_agent_run"
# EDGE_AGENT_IMAGE=<repo:tag> runs another image with the same settings (e.g. one being verified)
IMAGE_TAG="${EDGE_AGENT_IMAGE:-$IMAGE_TAG}"
if ! docker images --format '{{.Repository}}:{{.Tag}}' | grep -qx "$IMAGE_TAG"; then
    echo "ERROR: could not find the $IMAGE_TAG image! The SSD mount or Docker restart may have failed."
    exit 1
fi
echo "Image verified OK: $IMAGE_TAG"

echo "=== [4/4] Starting Edge Agent Container ==="
# Only one Edge Agent container can run at a time: they share the GPU memory and the cameras
# (a camera can be opened by one process only). Stop any other running one first.
for other in $(docker ps --format '{{.Names}}' | grep '^edge_agent_run' | grep -vx "$CONTAINER_NAME" || true); do
    echo "Stopping $other (only one Edge Agent container can use the GPU / cameras)"
    docker stop "$other" >/dev/null
done
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# The Thor image bakes in OPENBLAS_CORETYPE=NEOVERSEV2, which makes OpenBLAS use SVE; Orin's
# Cortex-A78AE has no SVE, so `import numpy` dies with "Illegal instruction" there. latest_orin
# already sets NEOVERSEN1; passing it here as well keeps an older Orin image working.
# Thor keeps the image's setting.
CPU_ARGS=()
if ! grep -qw sve /proc/cpuinfo; then
    echo "CPU has no SVE (Orin) - running OpenBLAS with OPENBLAS_CORETYPE=NEOVERSEN1"
    CPU_ARGS=(--env OPENBLAS_CORETYPE=NEOVERSEN1)
fi

# EDGE_AGENT_LOAD=<preset>: container_start.sh loads it when Studio starts (also after docker restart).
LOAD_ARGS=()
[ -n "$EDGE_AGENT_LOAD" ] && LOAD_ARGS=(--env EDGE_AGENT_LOAD="$EDGE_AGENT_LOAD")

# This machine's own HTTPS certificate (server.cert.pem / server.key.pem in certs/) instead of the one in
# the image, whose private key every copy of the public image shares.
CERT_DIR="${EDGE_AGENT_CERT_DIR:-$SCRIPT_DIR/certs}"
# Models copied to the internal disk (2026-11-08: Thor's data/ is on a USB SSD, 416 MB/s direct reads;
# the NVMe reads 784 MB/s): each EDGE_AGENT_FAST_MODELS/models--<org>--<name> (a whole HuggingFace cache
# entry, copied with cp -a) is mounted over data/'s copy. No folder or nothing in it: nothing changes.
FAST_MODELS=${EDGE_AGENT_FAST_MODELS:-$HOME/edge-agent-models}
FAST_ARGS=()
for d in "$FAST_MODELS"/models--*; do
    [ -d "$d" ] && FAST_ARGS+=(-v "$d:/data/models/huggingface/$(basename "$d"):ro")
done
[ ${#FAST_ARGS[@]} -gt 0 ] && echo "  models from the internal disk: $(( ${#FAST_ARGS[@]} / 2 )) ($FAST_MODELS)"

CERT_ARGS=()
if [ -f "$CERT_DIR/server.cert.pem" ] && [ -f "$CERT_DIR/server.key.pem" ]; then
    CERT_ARGS=(-v "$CERT_DIR:/etc/edge_agent_certs:ro"
               --env SSL_CERT=/etc/edge_agent_certs/server.cert.pem --env SSL_KEY=/etc/edge_agent_certs/server.key.pem)
fi

# -v /dev:/dev: --privileged only grants the container the *device nodes that
# already existed on the host* at container-create time - a long-running
# container started before a USB camera was plugged in (or re-enumerated)
# never picks it up without a restart. This bind mount makes /dev a live view
# of the host's, so newly-appeared devices show up without recreating the
# container.
docker run \
  --runtime nvidia \
  --env NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics \
  -d --network host \
  --shm-size=8g \
  --memory=100g \
  --memory-swap=100g \
  --volume /tmp/argus_socket:/tmp/argus_socket \
  --volume /etc/enctune.conf:/etc/enctune.conf \
  --volume /etc/nv_tegra_release:/etc/nv_tegra_release \
  --volume /tmp/nv_jetson_model:/tmp/nv_jetson_model \
  --volume /var/run/dbus:/var/run/dbus \
  --volume /var/run/avahi-daemon/socket:/var/run/avahi-daemon/socket \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$SCRIPT_DIR/data:/data" \
  "${FAST_ARGS[@]}" \
  -v /etc/localtime:/etc/localtime:ro \
  -v /etc/timezone:/etc/timezone:ro \
  --device /dev/snd \
  -e DISPLAY=:0 \
  -v /tmp/.X11-unix/:/tmp/.X11-unix \
  --device /dev/bus/usb \
  -v /dev:/dev \
  --name "$CONTAINER_NAME" \
  "${CPU_ARGS[@]}" \
  "${HF_ARGS[@]}" \
  "${LOAD_ARGS[@]}" \
  "${CERT_ARGS[@]}" \
  --env VLLM_LOAD_WATCHDOG_SEC=1800 \
  --env PYTHONUTF8=1 \
  --env VLLM_NO_USAGE_STATS=1 --env DO_NOT_TRACK=1 --env ORT_DISABLE_TELEMETRY=1 --env HF_HUB_DISABLE_TELEMETRY=1 \
  --privileged \
  --ulimit core=0 \
  -v /etc/machine-id:/etc/machine-id \
  -v /:/dummy_root:ro \
  -v "$SCRIPT_DIR:/opt/NanoLLM" \
  -v "$SCRIPT_DIR/data/flashinfer_cache/flashinfer:/root/.cache/flashinfer" \
  -v "$SCRIPT_DIR/data/vllm_cache:/root/.cache/vllm" \
  "$IMAGE_TAG" \
  bash /opt/NanoLLM/container_start.sh


echo ""
echo "=========================================="
echo "  Edge Agent started successfully!"
echo "  Wait about 20 seconds, then open your browser at"
echo "  https://$(hostname -I | awk '{print $1}'):8050"
echo "=========================================="
echo ""
echo "View logs: docker logs -f $CONTAINER_NAME"
