# Third-Party Models

Edge Agent runs models made by other organizations. Each model keeps its own license; using Edge Agent does not change it. Check the terms before you use a model in a product.

- **In the data package**: the file ships in `ispsae/edge_agent_data`.
- **Downloaded**: the file is fetched from Hugging Face (or the model's own host) the first time a preset uses it.

## Large language and vision-language models

| Model | Used for | Source | License |
|---|---|---|---|
| [nvidia/Qwen3.8-27B-NVFP4](https://huggingface.co/nvidia/Qwen3.8-27B-NVFP4) | Agent chat (`Harness-Chat-*`) | Downloaded | Apache-2.0 |
| [Qwen/Qwen3-VL-8B-Instruct-FP8](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-FP8) | Event summaries, scene description | Downloaded | Apache-2.0 |
| [nvidia/Cosmos3-Nano](https://huggingface.co/nvidia/Cosmos3-Nano) | Alert presets, event detection, video generation | Downloaded | [OpenMDW-1.1](https://openmdw.ai/license/1-1/) |
| [nvidia/Cosmos-Reason2-2B](https://huggingface.co/nvidia/Cosmos-Reason2-2B) | Fire alert | Downloaded | [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license) |
| [openbmb/MiniCPM-o-2_6](https://huggingface.co/openbmb/MiniCPM-o-2_6) | Arrest alert | Downloaded | Apache-2.0 |
| [nvidia/Cosmos-1.0-Guardrail](https://huggingface.co/nvidia/Cosmos-1.0-Guardrail) | Safety check of the video generator (blocklist, face blur; loaded by diffusers) | Downloaded | [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license) |
| [Qwen/Qwen3Guard-Gen-0.6B](https://huggingface.co/Qwen/Qwen3Guard-Gen-0.6B) | Prompt safety check of the video generator (loaded by diffusers) | Downloaded | Apache-2.0 |
| [Efficient-Large-Model/VILA1.5-3b](https://huggingface.co/Efficient-Large-Model/VILA1.5-3b), [VILA1.5-13b](https://huggingface.co/Efficient-Large-Model/VILA1.5-13b) | MLC alert and RAG presets | In the data package (MLC-converted) | **CC-BY-NC-4.0 (non-commercial)** |
| [Efficient-Large-Model/Llama-3-VILA1.5-8B](https://huggingface.co/Efficient-Large-Model/Llama-3-VILA1.5-8B) | MLC alert presets | In the data package (MLC-converted) | **CC-BY-NC-4.0 (non-commercial)**, and the [Meta Llama 3 Community License](https://www.llama.com/llama3/license/). Built with Meta Llama 3. |

To download `nvidia/Cosmos-Reason2-2B`, open its model page once and accept the terms with the Hugging Face account of your token.

## Detection, tracking and embedding models

| Model | Used for | Source | License |
|---|---|---|---|
| [YOLO-World v2](https://docs.ultralytics.com/models/yolo-world/) (`yolov8x-worldv2.pt`) | Object tracking, auto-labeling, open-vocabulary detection | In the data package | **AGPL-3.0** ([Ultralytics licensing](https://www.ultralytics.com/license)) |
| [YOLOE](https://docs.ultralytics.com/models/yoloe/) (`yoloe-11l-seg.pt`) | Tracking an object by a drawn box | In the data package | **AGPL-3.0** ([Ultralytics licensing](https://www.ultralytics.com/license)) |
| [google/owlv2-base-patch16-ensemble](https://huggingface.co/google/owlv2-base-patch16-ensemble) | Open-vocabulary detection | Downloaded | Apache-2.0 |
| [openai/clip-vit-large-patch14-336](https://huggingface.co/openai/clip-vit-large-patch14-336) | RAG image search | Downloaded | MIT |
| [patrickjohncyh/fashion-clip](https://huggingface.co/patrickjohncyh/fashion-clip) | RAG image search | Downloaded | MIT |

YOLO-World and YOLOE are Ultralytics models, and the `ultralytics` package that runs them is in the Docker image. Ultralytics requires an [Enterprise License](https://www.ultralytics.com/license) for use in a closed-source or commercial product.

## Speech models

| Model | Used for | Source | License |
|---|---|---|---|
| [openai/whisper-small](https://huggingface.co/openai/whisper-small) | Speech recognition | Downloaded | Apache-2.0 (code: MIT) |
| [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | Voice activity detection | In the data package | MIT |
| [hexgrad/Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) | Chinese and English speech output | Downloaded | Apache-2.0 |
| [Piper](https://huggingface.co/rhasspy/piper-voices) `en_US-libritts-high` | English speech output | In the data package | MIT; trained on [LibriTTS](http://www.openslr.org/60/) (CC BY 4.0) |
| [Piper](https://huggingface.co/rhasspy/piper-voices) `zh_CN-chaowen-medium` | Chinese speech output | In the data package | MIT; dataset CC0 |
| [Piper](https://huggingface.co/rhasspy/piper-voices) `en_US-lessac-high` | Not used by any preset | In the data package | MIT; trained on the [Blizzard 2013 Lessac data](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html), licensed for research only |

## Your own models

Models you fine-tune in Edge Agent (LoRA adapters, YOLO-World or OwlV2 fine-tunes) keep the license of the model they started from. YOLO-World fine-tunes are under AGPL-3.0, like the base model.
