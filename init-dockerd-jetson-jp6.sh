#!/bin/bash
# 
#
## ref. to https://docs.nvidia.com/jetson/jetpack/install-setup/index.html
# 
# Exit script if a command retured with a non-zero status
#set -e

apt_mark_unhold() {
# Unhold following packages to allow apt upgrade
    sudo apt-mark unhold \
    docker-ce=5:27.5.1-1~ubuntu.22.04~jammy \
    docker-ce-cli=5:27.5.1-1~ubuntu.22.04~jammy \
    docker-compose-plugin=2.32.4-1~ubuntu.22.04~jammy \
    docker-buildx-plugin=0.20.0-1~ubuntu.22.04~jammy \
    docker-ce-rootless-extras=5:27.5.1-1~ubuntu.22.04~jammy
}

apt_install_mark_hold() {
    # install and hold following packages to avoid upgrading
    sudo apt-get install -y docker-ce=5:27.5.1-1~ubuntu.22.04~jammy --allow-downgrades
    sudo apt-get install -y docker-ce-cli=5:27.5.1-1~ubuntu.22.04~jammy --allow-downgrades
    sudo apt-get install -y docker-compose-plugin=2.32.4-1~ubuntu.22.04~jammy --allow-downgrades
    sudo apt-get install -y docker-buildx-plugin=0.20.0-1~ubuntu.22.04~jammy --allow-downgrades
    sudo apt-get install -y docker-ce-rootless-extras=5:27.5.1-1~ubuntu.22.04~jammy --allow-downgrades

    # Hold packages
    sudo apt-mark hold \
    docker-ce=5:27.5.1-1~ubuntu.22.04~jammy \
    docker-ce-cli=5:27.5.1-1~ubuntu.22.04~jammy \
    docker-compose-plugin=2.32.4-1~ubuntu.22.04~jammy \
    docker-buildx-plugin=0.20.0-1~ubuntu.22.04~jammy \
    docker-ce-rootless-extras=5:27.5.1-1~ubuntu.22.04~jammy
}

turn_on_l4t_apt_source() {
#turn on nvidia apt source for further update
    sudo sed -i 's/^#deb/deb/g' /etc/apt/sources.list.d/nvidia-l4t-apt-source.list
    sudo sed -i 's/^# deb/deb/g' /etc/apt/sources.list.d/nvidia-l4t-apt-source.list
}

turn_off_l4t_apt_source() {
#turn off nvidia apt source for further update
    sudo sed -i 's/^deb/#deb/g' /etc/apt/sources.list.d/nvidia-l4t-apt-source.list
}

# JP6 docker: Unhold few packages to allow apt upgrade
apt_mark_unhold

turn_on_l4t_apt_source
sudo apt update

## install nvidia-jetpack
## If disk space is limited, use these commands:
apt depends nvidia-jetpack | awk '{print $2}' | xargs -I {} sudo apt install -y {}

# install containers
sudo apt install -y nvidia-container curl apt-utils
curl https://get.docker.com | sudo sh

# JP6 docker: Install and hold packages
## ref. to https://github.com/jetsonhacks/install-docker
apt_install_mark_hold

sudo systemctl --now enable docker
sudo nvidia-ctk runtime configure --runtime=docker

# Checking on the existence of docker group
if getent group docker ; then
    echo "Group 'docker' exists."
else
    sudo groupadd docker
fi

# Adding current user to docker group.
sudo usermod -aG docker $USER

# give it a fresh restart
sudo systemctl daemon-reload 
sudo systemctl restart docker

# turn off nvidia apt source to avoid unexpected update
turn_off_l4t_apt_source

echo "Docker installation done."
docker --version 

set +e
