#!/bin/bash

#split tvm
#split -b 100M tvm-0.15.0-cp310-cp310-linux_aarch64.whl "tvm-0.15.0-cp310-cp310-linux_aarch64.whl.part"

#combine all parts togeter
cat tvm-0.15.0-cp310-cp310-linux_aarch64.whl.part* > tvm-0.15.0-cp310-cp310-linux_aarch64.whl

#to be removed
rm -f tvm-0.15.0-cp310-cp310-linux_aarch64.whl.part*

