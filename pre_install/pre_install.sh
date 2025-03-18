#!/usr/bin/env bash
set -ex
apt-get update && apt-get install -y vim
echo "The synchronization error between NanoDB GPU and CPU has been fixed. Process begins."
# NanoDB GPU and CPU synchronize error fixed
cp -f /opt/NanoLLM/pre_install/nanodb.py /opt/NanoDB/nanodb/
echo "The synchronization error between NanoDB GPU and CPU has been fixed and the process is finished."

echo "-------------------------------------------------"
echo "NanoOWLv2 install. Process begins."
# NanoOWLv2 install
cd /opt/NanoLLM/nanoowl
python3 setup.py develop --user
# python3 -m nanoowl.build_image_encoder_engine   --model_name="google/owlv2-base-patch16-ensemble"  data/owlv2.engine
echo "NanoOWLv2 install. Process finished."

echo "-------------------------------------------------"
echo "Building TVM"
LLVM_VERSION=17
PYTHON_VERSION="3.10"
CUDAARCHS=87

pip3 install pytest -i https://pypi.org/simple
cp -f /opt/NanoLLM/pre_install/canonical_simplify.cc /opt/mlc-llm/3rdparty/tvm/src/arith/
cp -f /opt/NanoLLM/pre_install/test_arith_canonical_simplify.py /opt/mlc-llm/3rdparty/tvm/tests/python/arith/

# install LLVM the upstream way instead of apt because of:
# https://discourse.llvm.org/t/llvm-15-0-7-missing-libpolly-a/67942 
cd /
wget https://apt.llvm.org/llvm.sh
chmod +x llvm.sh
./llvm.sh ${LLVM_VERSION} all
ln -sf /usr/bin/llvm-config-* /usr/bin/llvm-config

# could NOT find zstd (missing: zstd_LIBRARY zstd_INCLUDE_DIR)
apt-get update
apt-get install -y --no-install-recommends libzstd-dev ccache
rm -rf /var/lib/apt/lists/*
apt-get clean

# add extras to the source
cp -f /tmp/mlc/benchmark.py /opt/mlc-llm/

# flashinfer build references 'python'
ln -sf /usr/bin/python3 /usr/bin/python

# disable pytorch: https://github.com/apache/tvm/issues/9362
# -DUSE_LIBTORCH=$(pip3 show torch | grep Locatioxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx                                                                                                                                                                                                    n: | cut -d' ' -f2)/torch
# cd /opt/mlc-llm/
# mkdir build
# cd build

# cmake -G Ninja \
# 	-DCMAKE_CXX_STANDARD=17 \
# 	-DCMAKE_CUDA_STANDARD=17 \
# 	-DCMAKE_CUDA_ARCHITECTURES=${CUDAARCHS} \
# 	-DUSE_CUDA=ON \
# 	-DUSE_CUDNN=ON \
# 	-DUSE_CUBLAS=ON \
# 	-DUSE_CURAND=ON \
# 	-DUSE_CUTLASS=ON \
# 	-DUSE_THRUST=ON \
# 	-DUSE_GRAPH_EXECUTOR_CUDA_GRAPH=ON \
# 	-DUSE_STACKVM_RUNTIME=ON \
# 	-DUSE_LLVM="/usr/bin/llvm-config --link-static" \
# 	-DHIDE_PRIVATE_SYMBOLS=ON \
# 	-DSUMMARIZE=ON \
# 	../
	
# ninja

# # OR
# mv /opt/NanoLLM/build /opt/mlc-llm

# build TVM python module
# cd /opt/mlc-llm/3rdparty/tvm/python

# TVM_LIBRARY_PATH=/opt/mlc-llm/build/tvm python3 setup.py --verbose bdist_wheel --dist-dir /opt

# pip3 install --no-cache-dir --force-reinstall --verbose /opt/tvm*.whl

pip3 install --no-cache-dir --force-reinstall --verbose /opt/NanoLLM/pre_install/tvm*.whl -i https://pypi.org/simple
# pip3 show tvm && python3 -c 'import tvm'
# rm -rf /opt/mlc-llm/build /opt/tvm*.whl

# build mlc-llm python module
# cd /opt/mlc-llm

# if [ -f setup.py ]; then
# 	python3 setup.py --verbose bdist_wheel --dist-dir /opt
# fi

# cd python
# python3 setup.py --verbose bdist_wheel --dist-dir /opt

# pip3 install --no-cache-dir --verbose /opt/mlc*.whl -i https://pypi.org/simple

    
# make the CUTLASS sources available for model builder
ln -s /opt/mlc-llm/3rdparty/tvm/3rdparty /usr/local/lib/python${PYTHON_VERSION}/dist-packages/tvm/3rdparty

# check pydantic > 2
pip3 install --no-cache-dir --verbose 'pydantic>2' -i https://pypi.org/simple
pip3 install "numpy<2" --force-reinstall -i https://pypi.org/simple

# Last one: make sure it loads
cd /
python3 /opt/mlc-llm/3rdparty/tvm/tests/python/arith/test_arith_canonical_simplify.py
pip3 show mlc_llm
python3 -m mlc_llm.build --help
python3 -c "from mlc_chat import ChatModule; print(ChatModule)"
echo "Building TVM finished"

echo "-------------------------------------------------"
echo "MQTT install. Process begins."
#install mqtt
pip3 install paho-mqtt==2.1.0 -i https://pypi.org/simple
echo "MQTT install. Process finished."

echo "-------------------------------------------------"
echo "Jetson-utils (RTSP fix). Process begins."
#gstEncoder fix
cd / && git clone https://github.com/dusty-nv/jetson-utils
cd /jetson-utils && mkdir build && cd build
cp -f /opt/NanoLLM/pre_install/gstEncoder.cpp /jetson-utils/codec
cmake ../ && make -j$(nproc) && make install && ldconfig
cd / && rm -rf /jetson-utils
echo "Jetson-utils (RTSP fix). Process finished."
pip uninstall numpy -y && pip3 uninstall numpy -y
pip3 install "numpy<2" --force-reinstall -i https://pypi.org/simple

echo "-------------------------------------------------"
