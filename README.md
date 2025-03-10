# Advantech Edge Agent

Advantech Edge Agent is an interactive sandbox designed to facilitate the rapid design and experimentation of automation agents, personal assistants, and edge AI systems. It seamlessly integrates multimodal Large Language Models (LLMs), speech and vision transformers, vector databases, prompt templates, and function calling with live sensors and I/O. Optimized for deployment on Jetson devices, it offers on-device computing, low-latency streaming, and unified memory for enhanced performance.

<a href="https://www.youtube.com/watch?v=xsvGXlDslf0"><img src="./images/media/edge-agent-video.gif"></a>

> 💡Advantech Edge Agent is built on Agent Studio from Jetson AI Lab, enhanced with additional custom features. Users may find the [official tutorial](https://www.jetson-ai-lab.com/tutorial-intro.html), the [Jetson Forums](https://forums.developer.nvidia.com/c/agx-autonomous-machines/jetson-embedded-systems/jetson-projects/78) and [GitHub Issues](https://github.com/dusty-nv/NanoLLM) from NVIDIA helpful.

## Features

- **Interactive Environment**: Design and test automation agents and personal assistants in a user-friendly interface.
- **Multimodal Integration**: Combine LLMs with speech and vision transformers for comprehensive AI solutions.
- **Real-Time Sensor Integration**: Connect and interact with live sensors and I/O for real-world applications.
- **Optimized for Jetson Devices**: Leverage on-device computing and low-latency streaming for enhanced performance.

> 💡Learn more about [Practical Examples](https://github.com/advantech-EdgeAI/edge_agent/wiki#practical-examples) of using Edge Agent in wiki.

## Installation

### System Requirements

| Name            | Description                                           |
|-----------------|-------------------------------------------------------|
| Product         | MIC-733-AO5A1 (32GB) / MIC-733-AO6A1 (64GB)           |
| JetPack Version | V6.0GA                                                |
| Storage         | 512GB NVMe SSD (recommended)                          |
| USB Camera      | Logitech c270 HD webcam or any V4L2 compatible camera |
| Internet        | Required during installation                          |

### Docker Installation

Ensure your system has Docker installed. Check the version of Docker:
```sh
docker --version
# or run the docker command with sudo
# sudo docker --version
```

Install Docker on your system:

1. Make NVIDIA's Jetson apt source available
   ```sh
   sudo vi /etc/apt/sources.list.d/nvidia-l4t-apt-source.list
   ```
   Uncomment the lines as the following:
   ```sh
   deb https://repo.download.nvidia.com/jetson/common r36.4 main
   deb https://repo.download.nvidia.com/jetson/t234 r36.4 main
   deb https://repo.download.nvidia.com/jetson/ffmpeg r36.4 main
   ```
2. Manually install Docker and set it up:
   ```sh
   sudo apt update
   sudo apt install -y nvidia-container curl
   curl https://get.docker.com | sh && sudo systemctl --now enable docker
   sudo nvidia-ctk runtime configure --runtime=docker
   ```
3. Restart the Docker service and add your user to the Docker group to run commands without sudo:
   ```sh
   sudo systemctl restart docker
   sudo usermod -aG docker $USER
   newgrp docker
   ```
   Check the Docker installation with the command:
   ```sh
   docker --version
   ```
4. Add default runtime in `/etc/docker/daemon.json`:
   ```sh
   sudo vi /etc/docker/daemon.json
   ```
   Insert the `"default-runtime": "nvidia"` line as following:
   ```json
   {
    "runtimes": {
        "nvidia": {
            "path": "nvidia-container-runtime",
            "runtimeArgs": []
         }
      },
    "default-runtime": "nvidia"
   }
   ```
5. Restart Docker:
   ```sh
   sudo systemctl daemon-reload && sudo systemctl restart docker
   ```

###  SSD Installation 

1. Power off your Jetson device and disconnect peripherals.
2. Insert the NVMe SSD into the carrier board, ensuring it's properly seated and secured.
3. Reconnect peripherals and power on the device.
4. Verify the SSD is recognized by running:
   ```sh
   lspci
   ```
   You should see an entry similar to:
   ```sh
   0007:01:00.0 Non-Volatile memory controller: Marvell Technology Group Ltd. Device 1322 (rev 02)
   ```

### Format and Set Up Auto-Mount

1. Identify the SSD device name:
   ```sh
   lsblk
   ```
   Look for a device like `nvme0n1`.
2. Format the SSD:
   ```sh
   sudo mkfs.ext4 /dev/nvme0n1
   ```
3. Create a mount point and mount the SSD:
   ```sh
   sudo mkdir /ssd
   sudo mount /dev/nvme0n1 /ssd
   ```
4. Ensure the mount persists after reboot:
   - Retrieve the UUID of the SSD:
     ```sh
     lsblk -f | grep nvme0n1
     ```
   - Create and edit the `/etc/rc.local` file:
     ```sh
     sudo vi /etc/rc.local
     ```
   - Add the following lines, replacing UUID with the retrieved UUID:
     ```sh
     #!/bin/bash
     sleep 10
     mount UUID=************-****-****-****-******** /ssd
     systemctl daemon-reload
     systemctl restart docker
     journalctl -u docker
     exit 0
     ```
5. Make `/etc/rc.local` executable:
   ```sh
   sudo chmod +x /etc/rc.local
   ```
6. Change the ownership of /ssd:
   ```sh
   sudo chown ${USER}:${USER} /ssd
   ```

### Migrate Docker Directory to SSD

With the SSD installed, you can use the extra storage for the Docker directory.

1. Stop Docker:
   ```sh
   sudo systemctl stop docker
   ```
2. Move the Docker folder:
   ```sh
   sudo du -csh /var/lib/docker/
   sudo mkdir /ssd/docker
   sudo rsync -axPS /var/lib/docker/ /ssd/docker/
   sudo du -csh /ssd/docker/
   ```
3. Edit `/etc/docker/daemon.json`:
   ```sh
   sudo vi /etc/docker/daemon.json
   ```
4. Adding the line `"data-root": "/ssd/docker"` as the following:
   ```json
   {
    "runtimes": {
        "nvidia": {
            "path": "nvidia-container-runtime",
            "runtimeArgs": []
         }
      },
    "default-runtime": "nvidia",
    "data-root": "/ssd/docker"
   }
   ```
5. Rename and remove the old Docker data directory:
   ```sh
   sudo mv /var/lib/docker /var/lib/docker.old
   # optional: sudo rm -rf /var/lib/docker.old
   ```

5. Restart Docker:
   ```sh
   sudo systemctl daemon-reload
   sudo systemctl restart docker
   sudo journalctl -u docker
   ```

### ☕ Take a Break: Optional Steps

At this stage, you have installed Docker and an SSD on your device and set the SSD as the default storage location for Docker images. You can follow these optional steps to verify that the SSD is configured correctly for Docker images and disable Apport reporting:

- [Test Docker on SSD](https://github.com/advantech-EdgeAI/edge_agent/wiki/Test-Docker-on-SSD)
- [Disable Apport Reporting](https://github.com/advantech-EdgeAI/edge_agent/wiki/Disable-Apport-Reporting)

### Download Essential Data

1. Clone Jetson-containers and install:
   ```sh
   cd /ssd
   git clone https://github.com/dusty-nv/jetson-containers
   bash jetson-containers/install.sh
   ```
2. Clone Edge Agent and pre-configure:
   ```sh
   git clone https://github.com/advantech-EdgeAI/edge_agent.git

   docker run --name share-volume00-container ispsae/share-volume00
   docker cp share-volume00-container:/data/. /ssd/edge_agent/pre_install/

   mv /ssd/edge_agent/pre_install/owlv2.engine /ssd/edge_agent/nanoowl/data/
   ```
3. Extract demo videos:
   ```sh
   cd /ssd/edge_agent/pre_install
   tar xfz demo-videos.tgz --strip-components=1
   ```
4. Move data to Jetson containers:
   ```sh
   mv nanodb /ssd/jetson-containers/data/
   mv forbidden_zone /ssd/jetson-containers/data/images/
   mv demo /ssd/jetson-containers/data/videos/
   ```
5. Pull the Agent Studio container:
   ```sh
   docker pull dustynv/nano_llm:24.7-r36.2.0
   ```

### Apply Patches

1. Run the container:
   ```sh
   jetson-containers run \
   -v /ssd/edge_agent:/opt/NanoLLM \
   dustynv/nano_llm:24.7-r36.2.0 \
   /bin/bash
   ```
2. Inside the container, execute:
   ```sh
   cd /opt/NanoLLM/pre_install && sh pre_install.sh
   ```
3. Commit the updated container:
   ```sh
   sudo docker commit `docker ps -q -l` dustynv/nano_llm:24.7-r36.2.0_bug_fixed
   ```

### Register on HuggingFace

Sign up at HuggingFace and obtain an access token (Settings section).

![](./images/media/image3.png)

## Usage

Start Edge Agent container with HuggingFace token:
   ```sh
   jetson-containers run --env HUGGINGFACE_TOKEN=hf_xyz123abc456 \
   -v /etc/machine-id:/etc/machine-id \
   -v /:/dummy_root:ro \
   -v /ssd/edge_agent:/opt/NanoLLM \
   -v /ssd/edge_agent/pre_install/project_presets:/data/nano_llm/presets \
   dustynv/nano_llm:24.7-r36.2.0_bug_fixed \
   python3 -m nano_llm.studio
   ```
Or start without the HuggingFace token:
   ```sh
   jetson-containers run \
   -v /etc/machine-id:/etc/machine-id \
   -v /:/dummy_root:ro \
   -v /ssd/edge_agent:/opt/NanoLLM \
   -v /ssd/edge_agent/pre_install/project_presets:/data/nano_llm/presets \
   dustynv/nano_llm:24.7-r36.2.0_bug_fixed \
   python3 -m nano_llm.studio
   ```

Once the server starts on your device, open a browser and navigate to https://IP_ADDRESS:8050 (Note: Avoid using Firefox).

Here are a few important notes:

- Use the `--load` option to load your prebuilt pipeline before starting.
- If the program crashes, it will automatically restore the most recent pipeline you created.
- A "clear memory" function is available, allowing you to reset the system state.

To create a new project, click on the "Agent New Project" button in the top-right corner of Edge Agent. You’ll be given the option to either keep or discard the current pipeline before starting the new one.

Alternatively, you can visit https://IP_ADDRESS:8050/reload in your browser. After about 15 seconds, log back into https://IP_ADDRESS:8050. Either method will return your system to its initial state.

![](./images/media/image4.png)
