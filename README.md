# Advantech Edge Agent

Advantech Edge Agent is an interactive sandbox designed to facilitate the rapid design and experimentation of automation agents, personal assistants, and edge AI systems. It seamlessly integrates multimodal Large Language Models (LLMs), speech and vision transformers, vector databases, prompt templates, and function calling with live sensors and I/O. Optimized for deployment on Jetson devices, it offers on-device computing, low-latency streaming, and unified memory for enhanced performance.

<a href="https://youtu.be/bKSFZuh24Yc"><img src="./images/media/sample_case.gif"></a>

## Key Features

- **Interactive Environment**: Design and test automation agents and personal assistants in a user-friendly interface.
- **Multimodal Integration**: Combine LLMs with speech and vision transformers for comprehensive AI solutions.
- **Real-Time Sensor Integration**: Connect and interact with live sensors and I/O for real-world applications.
- **Optimized for Jetson Devices**: Leverage on-device computing and low-latency streaming for enhanced performance.

> 💡Learn more about [Preset Projects](https://github.com/advantech-EdgeAI/edge_agent/wiki/03-preset-projects) of using Edge Agent in wiki.

> 💡Watch a quick intro video [here](https://www.youtube.com/watch?v=P6T5xecStjk).

## System Architecture

Advantech Edge Agent is built on Agent Studio from Jetson AI Lab, enhanced with additional custom features. Users may find the [official tutorial](https://www.jetson-ai-lab.com/archive/agent_studio.html), the [Jetson Forums](https://forums.developer.nvidia.com/c/agx-autonomous-machines/jetson-embedded-systems/jetson-projects/78) and [GitHub Issues](https://github.com/dusty-nv/NanoLLM) from NVIDIA helpful.

## Installation Guide

### System Requirements

| Name            | Description                                           |
|-----------------|-------------------------------------------------------|
| Product         | MIC-733-AO5A1 (32GB) / MIC-733-AO6A1 (64GB)           |
| JetPack Version | ⚠️ V6.0GA (***ONLY Verified on JetPack6.0***)         |
| Storage         | 512GB NVMe SSD (recommended)                          |
| USB Camera      | Logitech c270 HD webcam or any V4L2 compatible camera |
| Internet        | Required during installation                          |

### Short Video Installation Guide

Our short video tutorial walks you through the steps for installation and configuration. Click it to learn more.

<a href="https://www.youtube.com/watch?v=zIH040_c2yg"><img src="./images/media/install_tutorial_w_SSD.gif"></a>

### 1. Clone this Repository

Clone this repository to your JetPack 6 device:

```sh
git clone https://github.com/advantech-EdgeAI/edge_agent.git
cd edge_agent
```

### 2. Docker Service Installation 

Starting from JetPack 6, the SDK Manager does not install Docker service by default.

#### Checking on Docker Service

Check the Docker version to ensure that the Docker service is installed and running properly on your system:

```bash
docker --version
```

If Docker is not available, run the following script to install and enable it on your JetPack 6 device:

```bash
bash init-dockerd-jetson-jp6.sh
```

###  3. Setup Extended Storage - NVMe SSD

#### Physical Installation

1. Power off your Jetson device and disconnect peripherals.
2. Insert the NVMe SSD into the carrier board, ensuring it's properly seated and secured.
3. Reconnect peripherals and power on the device.
4. Verify the SSD is recognized by running:

   ```bash
   lspci
   ```

   You should see an entry similar to:
   ```
   0007:01:00.0 Non-Volatile memory controller: Marvell Technology Group Ltd. Device 1322 (rev 02)
   ```

#### Create ext4 Filesystem on SSD and Mount it to `/ssd` by Default

 - Follow the 'Format and Set Up Auto-mount' section in this [link](https://www.jetson-ai-lab.com/tutorials/ssd-docker-setup/).

#### Migrate Docker Directory to SSD

 1. The SSD directory on the root should be exactly as `/ssd` (not `/SSD`). Please follow the next step.
 2. Follow the 'Migrate Docker Directory to SSD' section in this [link](https://www.jetson-ai-lab.com/tutorials/ssd-docker-setup/).


#### Optional Setup Steps

 You can follow these ***optional*** steps to verify that the SSD is configured correctly for Docker images and disable Apport reporting:

- [Test Docker on SSD](https://github.com/advantech-EdgeAI/edge_agent/issues/5)
- [Disable Apport Reporting](https://github.com/advantech-EdgeAI/edge_agent/issues/6)

### 4. Download Essential Data

Run the following script to download Docker images and the necessary packages:

```bash
bash download-EA-JC-2ssd.sh
```

## Usage / Quick Start

### 1. Start Edge Agent

Start the Edge Agent, and the backend will listen on port 8050 on localhost:

```bash
bash startEA.sh
```

### 2. Start Working on Edge Agent Through Web UI

Once the Edge Agent starts up successfully, open another terminal to launch the web browser (Chromium):

```bash
bash launch-chromium.sh
```

At this stage, you should have successfully started the Edge Agent and accessed it via Chromium.

### 3. Start a Quick Demo Project

Load a preset project for a quick demo. Click to learn more.

<a href="https://www.youtube.com/watch?v=XNr-aNQwoPc"><img src="./images/media/quick_demo.gif"></a>

## Troubleshooting

We maintain frequently asked questions as GitHub Issues. This allows for better tracking, discussions, and updates.

How to Find Answers:
- Check the [FAQ label](https://github.com/advantech-EdgeAI/edge_agent/issues?q=is%3Aissue%20state%3Aclosed%20label%3AFAQ) in Issues to see if your question has already been answered.
- Use the search bar in the Issues tab to find relevant discussions.
- If you can’t find what you need, feel free to open a new issue with your question!

Looking for tech support or have a business inquiry? Let’s talk: [Contact Form](https://www.advantech.com/en/form/2bcb7004-44e9-4e70-9ef0-520f326e6141?callback=f51f1493-33ae-43e5-8172-cb8055499ec1)
