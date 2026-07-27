#!/bin/bash
set -e

# Resolve the directory this script lives in (the project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load the token from .env if the environment variable isn't already set
if [ -z "$HUGGINGFACE_TOKEN" ] && [ -f "$SCRIPT_DIR/.env" ]; then
    source "$SCRIPT_DIR/.env"
fi
if [ -z "$HUGGINGFACE_TOKEN" ]; then
    echo "ERROR: HUGGINGFACE_TOKEN is not set."
    echo "Create a .env file in the project root and add:"
    echo "  HUGGINGFACE_TOKEN=hf_xxxxxxxxxxxxxxxx"
    exit 1
fi

echo "=== [1/4] Checking SSD mount status ==="
if ! mount | grep -q " /ssd "; then
    echo "SSD not mounted, mounting..."
    sudo mount /ssd
    echo "SSD mounted"

    echo "=== [2/4] Restarting containerd + Docker ==="
    sudo systemctl restart containerd
    sleep 5
    sudo systemctl restart docker
    sleep 3
    echo "Docker restarted"
else
    echo "SSD already mounted, skipping step 2"
fi

echo "=== [3/4] Verifying Docker image exists ==="
if docker images | grep -q "^old/nano_llm "; then
    docker tag old/nano_llm:edge_agent_mlc_compiler edge_agent:prod 2>/dev/null || true
fi

if ! docker images --format '{{.Repository}}:{{.Tag}}' | grep -qE "^edge_agent:(v2-vllm|v2|prod)$"; then
    echo "ERROR: could not find edge_agent:v2-vllm / v2 / prod image! The SSD mount or Docker restart may have failed."
    exit 1
fi

# Prefer v2-vllm (includes the vLLM/MiniCPM-o patch); fall back to v2, then prod
if docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "^edge_agent:v2-vllm$"; then
    IMAGE_TAG="edge_agent:v2-vllm"
elif docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "^edge_agent:v2$"; then
    IMAGE_TAG="edge_agent:v2"
else
    IMAGE_TAG="edge_agent:prod"
fi
echo "Image verified OK: $IMAGE_TAG"

echo "=== [4/4] Starting Edge Agent Container ==="
docker rm -f edge_agent_run 2>/dev/null || true

docker run \
  --runtime nvidia \
  --env NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics \
  -d --network host \
  --shm-size=8g \
  --volume /tmp/argus_socket:/tmp/argus_socket \
  --volume /etc/enctune.conf:/etc/enctune.conf \
  --volume /etc/nv_tegra_release:/etc/nv_tegra_release \
  --volume /tmp/nv_jetson_model:/tmp/nv_jetson_model \
  --volume /var/run/dbus:/var/run/dbus \
  --volume /var/run/avahi-daemon/socket:/var/run/avahi-daemon/socket \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$SCRIPT_DIR/data:/data" \
  -v /etc/localtime:/etc/localtime:ro \
  -v /etc/timezone:/etc/timezone:ro \
  --device /dev/snd \
  -e DISPLAY=:0 \
  -v /tmp/.X11-unix/:/tmp/.X11-unix \
  --device /dev/bus/usb \
  --name edge_agent_run \
  --env HUGGINGFACE_TOKEN="$HUGGINGFACE_TOKEN" \
  --privileged \
  --ulimit core=0 \
  -v /etc/machine-id:/etc/machine-id \
  -v /:/dummy_root:ro \
  -v "$SCRIPT_DIR:/opt/NanoLLM" \
  -v "$SCRIPT_DIR/data/flashinfer_cache/flashinfer:/root/.cache/flashinfer" \
  "$IMAGE_TAG" \
  bash /opt/NanoLLM/container_start.sh

echo ""
echo "=========================================="
echo "  Edge Agent started successfully!"
echo "  Wait about 20 seconds, then open your browser at"
echo "  https://$(hostname -I | awk '{print $1}'):8050"
echo "=========================================="
echo ""
echo "View logs: docker logs -f edge_agent_run"
