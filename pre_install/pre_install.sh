#!/bin/bash
set -ex

echo "update env and install vim"
apt update && apt install -y vim

echo "fixed webrtc and rtsp error"
apt install -y gstreamer1.0-nice
apt-get install -y avahi-utils libnss-mdns
service avahi-daemon stop
# gstEncoder fix
cd / && git clone https://github.com/dusty-nv/jetson-utils
cd /jetson-utils && git checkout 6d5471c97dad443776d2339569a4d1145f034a9e && mkdir build && cd build
cp -f /opt/NanoLLM/pre_install/gstEncoder.cpp /jetson-utils/codec
cmake ../ && make -j$(nproc) && make install && ldconfig
cd / && rm -rf /jetson-utils

echo "fix nanodb"
cp -f /opt/NanoLLM/pre_install/nanodb.py /opt/NanoDB/nanodb/

echo "install owlv2"
cd /opt/NanoLLM/nanoowl
python3 setup.py develop --user
# python3 -m nanoowl.build_image_encoder_engine   --model_name="google/owlv2-base-patch16-ensemble"  data/owlv2.engine

echo "symbolic link for python to python3"
ln -sf /usr/bin/python3 /usr/bin/python

echo "install yoloworld"
pip install ultralytics==8.3.103 -i https://pypi.org/simple
pip install git+https://github.com/ultralytics/CLIP.git@d19bfc14081d768afe1e4379609444c472f4b38e
pip install albumentations==2.0.5 -i https://pypi.org/simple

echo "install vllm"
# local wheel (speedup)
# cd /opt/NanoLLM/jp6_cu126
# pip install torch-2.6.0*.whl
# pip install torchao-0.10.0*.whl
# pip install torchaudio-2.6.0*.whl
# pip install torchvision-0.21.0*.whl
# pip install tensorflow-2.18.0*.whl
# pip install transformer_engine-2.2.0*.whl
# # Transformers v4.52.0.dev
# pip install git+https://github.com/huggingface/transformers@371c44d0efb2ac552bbfed9a65baea4d4d83747c
# pip install triton-3.2.0*.whl
# pip install ray-2.44.1*.whl
# pip install cupy_cuda12x-13.4.1*.whl
# pip install vllm-0.7.4*.whl
# pip install xformers-0.0.30*.whl
# pip install tf_keras-2.18.0*.whl
# pip install flash_attn-2.7.4.post1*.whl
# pip install bitsandbytes-0.45.1*.whl
# cp -f /opt/NanoLLM/pre_install/async_llm_engine.py /usr/local/lib/python3.10/dist-packages/vllm/engine

# # online index
pip install torch==2.6.0 -i https://pypi.jetson-ai-lab.dev/jp6/cu126
pip install torchao==0.10.0 -i https://pypi.jetson-ai-lab.dev/jp6/cu126
pip install torchaudio==2.6.0 -i https://pypi.jetson-ai-lab.dev/jp6/cu126
pip install torchvision==0.21.0 -i https://pypi.jetson-ai-lab.dev/jp6/cu126
pip install tensorflow==2.18.0 -i https://pypi.jetson-ai-lab.dev/jp6/cu126
pip install transformer_engine==2.2.0.dev0+5bb771e -i https://pypi.jetson-ai-lab.dev/jp6/cu126
# # Transformers v4.52.0.dev
pip install git+https://github.com/huggingface/transformers@371c44d0efb2ac552bbfed9a65baea4d4d83747c
pip install triton==3.2.0 -i https://pypi.jetson-ai-lab.dev/jp6/cu126
pip install vllm==0.7.4 -i https://pypi.jetson-ai-lab.dev/jp6/cu126
pip install xformers==0.0.30 -i https://pypi.jetson-ai-lab.dev/jp6/cu126
pip install tf-keras==2.18.0
pip install flash-attn==2.7.4.post1 -i https://pypi.jetson-ai-lab.dev/jp6/cu126
pip install bitsandbytes==0.45.1 -i https://pypi.jetson-ai-lab.dev/jp6/cu126
cp -f /opt/NanoLLM/pre_install/async_llm_engine.py /usr/local/lib/python3.10/dist-packages/vllm/engine

echo "install other requirements"
pip install paho-mqtt==2.1.0 -i https://pypi.org/simple
pip install pydantic==2.11.1 -i https://pypi.org/simple
pip install fastapi==0.115.12 -i https://pypi.org/simple