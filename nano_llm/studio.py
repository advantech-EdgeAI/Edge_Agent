# -*- coding: utf-8 -*-
import subprocess
import sys
import time
import os
import threading
from datetime import datetime, timedelta, timezone


# Add the project root directory to the Python path
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(os.path.dirname(current_dir))
sys.path.insert(0, project_root)

# HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE are decided in nano_llm/__init__.py,
# at the very top of the package - before anything (including the import
# below) pulls in huggingface_hub/transformers and freezes their offline
# constants. See _resolve_offline_mode() there for why it can't live here.
try:
    from nano_llm.agents import DynamicAgent
    from nano_llm.utils import ArgParser
except ImportError:
    # If the import above fails, try importing directly.
    sys.path.insert(0, os.path.dirname(current_dir))
    from agents import DynamicAgent
    from utils import ArgParser

def write_to_log(log_file, message):
    """
    Write a log message to the specified text file.

    :param log_file: Path to the log file.
    :param message: Log message to write.
    """
    with open(log_file, "a", encoding="utf-8") as log:
        timestamp = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S")
        log.write(f"[{timestamp}] {message}\n")

def run_studio(args):
    agent = DynamicAgent(**args)
    agent.run()

def run_child_process(args):
    """The main function to run a subprocess"""
    # Set MESA env vars BEFORE any library loading (torch/cuda/gstreamer).
    # On Jetson with 13b+CLIP, MESA's DRI scanning exhausts glibc TLS slots.
    # Using software rasterizer and NVIDIA-only EGL vendor avoids this.
    os.environ.setdefault('LIBGL_ALWAYS_SOFTWARE', '1')
    os.environ.setdefault('MESA_LOADER_DRIVER_OVERRIDE', 'softpipe')
    os.environ.setdefault('EGL_PLATFORM', 'surfaceless')
    os.environ.setdefault('__EGL_VENDOR_LIBRARY_FILENAMES',
                          '/usr/share/glvnd/egl_vendor.d/10_nvidia.json')
    run_studio(args)

def start_child_process(args):
    """Start the subprocess, retaining the original command line arguments"""
    args_list = []
    for key, value in args.items():
        if value is not None:
            if key == "preset_dir":  # dest for the --agent-dir flag (see argparse setup below)
                args_list.append("--agent-dir")
                args_list.append(value)
            elif key in ["load", "index", "root"]:
                args_list.append(f"--{key}")
                args_list.append(value)
            elif key == "ws_port":
                args_list.extend(["--ws-port", str(value)])
            elif key == "web_port":
                # Pre-existing bug: without this, the child process always falls back to
                # argparse's web_port default (8050) regardless of what was passed to the
                # supervisor - only surfaced when running two studio instances on one host
                # (e.g. --network host containers on non-default ports), which this project
                # hadn't needed before. ws_port already had this forwarding; web_port didn't.
                args_list.extend(["--web-port", str(value)])
    env = os.environ.copy()
    # Prevent MESA/DRI from trying to open a display in headless Docker environment.
    # libdrm_amdgpu.so.1 on Jetson has an undefined symbol (drmCloseBufferHandle)
    # that causes TLS assertion crash when loaded by GStreamer GL plugins.
    env.setdefault('LIBGL_ALWAYS_SOFTWARE', '1')
    env.setdefault('MESA_LOADER_DRIVER_OVERRIDE', 'softpipe')
    env.setdefault('EGL_PLATFORM', 'surfaceless')
    return subprocess.Popen([sys.executable, "-m", "nano_llm.studio", "--no-child"] + args_list,
                          stdout=sys.stdout,
                          stderr=sys.stderr,
                          env=env)

def main(log_file, **args):
    # args is a dictionary
    if "--no-child" in sys.argv:
        try:
            run_child_process(args)
        except Exception as e:
            print(f"The subprocess encountered an error: {str(e)}", file=sys.stderr)
            sys.exit(1)
        return

    # Run with subprocess
    print("Run with subprocess")
    write_to_log(log_file, "Program started with subprocess.")

    from nano_llm.recovery import Supervisor, probe_health, sigterm_as_interrupt

    def log(message):
        print(message)
        write_to_log(log_file, message)

    # One watchdog for every way the child can get stuck or die (docs/superpowers/specs/
    # 2026-10-15-studio-self-recovery-design.md): no web answer, no exit after a restart
    # request, a plugin's report, a crash. It restarts with the last loaded preset.
    supervisor = Supervisor(start_child=lambda preset: start_child_process({**args, "load": preset}),
                            probe=lambda: probe_health(args.get("web_port") or 8050), log=log)
    def clean_old_files():   # once per container start (nano_llm/retention.py, 2026-11-08)
        try:
            from nano_llm import retention
            removed = retention.clean()
            if any(removed.values()):
                log(f"retention: deleted old files {removed} (periods: EDGE_AGENT_KEEP_*_DAYS)")
        except Exception as e:
            log(f"retention: skipped ({e})")
    threading.Thread(target=clean_old_files, daemon=True, name="retention").start()

    sigterm_as_interrupt()
    supervisor.run(args.get("load"))


if __name__ == "__main__":
    LOG_FILE = None
    if "--no-child" not in sys.argv:
        # Get the current time and format it for the log file name
        current_time = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S")

        # Define a log file path with the timestamp
        LOG_DIR = "/opt/NanoLLM/logs"  # Target directory for logs
        LOG_FILE = os.path.join(LOG_DIR, f"crash_log_{current_time}.txt")

        # Ensure the directory exists
        os.makedirs(LOG_DIR, exist_ok=True)

    parser = ArgParser(extras=['web', 'log'])

    parser.add_argument("--load", type=str, default=None, help="load an agent from .json or .yaml")
    # dest='preset_dir' so this actually reaches DynamicAgent.__init__(preset_dir=...) -
    # argparse would otherwise produce "agent_dir", which DynamicAgent silently ignored
    # (it fell into **kwargs), leaving this flag a no-op regardless of what was passed.
    # Default matches DynamicAgent's own default (the directory actually in use today).
    parser.add_argument("--agent-dir", dest="preset_dir", type=str, default="/opt/NanoLLM/presets", help="change the agent load/save directory")
    parser.add_argument("--index", "--page", type=str, default="studio.html", help="the filename of the site's index html page (should have static/ and template/)")
    parser.add_argument("--root", type=str, default=None, help="the root directory for serving site files")   
    parser.add_argument("--no-child", action="store_true", help="If you want to run with only one main process")
    parser.add_argument("-o", "--offline", action="store_true", help="Run in offline mode (make sure all models have been successfully downloaded and verified while online)")
    args = parser.parse_args()

    # The actual HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE decision already happened
    # in nano_llm/__init__.py's _resolve_offline_mode(), before huggingface_hub/
    # transformers were imported - this just records the outcome now that
    # LOG_FILE is known.
    if LOG_FILE and os.environ.get("HF_HUB_OFFLINE") == "1":
        write_to_log(LOG_FILE, "Running in offline mode (HF_HUB_OFFLINE=1, TRANSFORMERS_OFFLINE=1).")

    if LOG_FILE:
        write_to_log(LOG_FILE, "Initializing program with arguments:")
        write_to_log(LOG_FILE, str(vars(args)))

    main(log_file=LOG_FILE, **vars(args))
