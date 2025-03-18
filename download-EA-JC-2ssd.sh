#!/bin/bash

## Please run this shell in edge_agent/
PWD=$(pwd)
echo "The current working folder is $PWD"

# Clone Jetson-containers and install:
SSD=/ssd
sudo mkdir -p $SSD
sudo chmod 0777 $SSD

# extend the sudo password timeout value
sudo cp -f passwd_timeout /etc/sudoers.d/

JCI=jetson-containers/install.sh
if [ ! -f $SSD/$JCI ];
then
    cd $SSD
    git clone https://github.com/dusty-nv/jetson-containers
    bash $JCI
fi

# copy owlv2 tensorrt model to target folder
PRE_INSD=$PWD/pre_install
OWLRT=$PWD/nanoowl/data/owlv2.engine
if [ ! -f $OWLRT ];
then
    sudo docker run --name share-volume00-container ispsae/share-volume00
    sudo docker cp share-volume00-container:/data/. $PRE_INSD
    sudo cp -fa $PRE_INSD/owlv2.engine $OWLRT
fi


# then move database and data in edge_agent/pre_install to Jetson-containers folder
cd $PRE_INSD
tar xzf demo-videos.tgz --strip-components=1
cp -far nanodb/ $SSD/jetson-containers/data/
cp -far forbidden_zone/ $SSD/jetson-containers/data/images/
cp -far demo/ $SSD/jetson-containers/data/videos/

# Pull the Edge Agent docker images
echo "docker pull ispsae/nano_llm:24.7-r36.2.0_bug_fixed"
echo "Please be patient, the download will take some time."
echo "..."
sudo docker pull ispsae/nano_llm:24.7-r36.2.0_bug_fixed
sudo docker images

# set the sudo password timeout back to default value
sudo rm -f /etc/sudoers.d/passwd_timeout
