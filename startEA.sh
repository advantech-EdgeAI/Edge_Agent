#!/bin/bash
PWD=$(pwd)
echo $PWD

sudo jetson-containers run \
-v /etc/machine-id:/etc/machine-id \
-v /:/dummy_root:ro \
-v $PWD/pre_install/project_presets:/data/nano_llm/presets \
-v $PWD:/opt/NanoLLM \
ispsae/nano_llm:24.7-r36.2.0_bug_fixed \
python3 -m nano_llm.studio

