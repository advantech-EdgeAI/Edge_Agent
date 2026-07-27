# -*- coding: utf-8 -*-
import subprocess
import sys
import time
import os
from datetime import datetime, timedelta

# Must match DynamicAgent._AUTOLOAD_FILE in nano_llm/agents/dynamic_agent.py.
# Written by the child right before a "restart and load preset" exit; read here
# so the next child comes up with that preset already loaded.
_AUTOLOAD_FILE = '/opt/NanoLLM/.autoload_preset'

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
        timestamp = (datetime.utcnow() + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S")
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
    global child_process
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

    while True: #(Normal run)
        child_process = start_child_process(args)
        try:
            # Wait for the subprocess to finish
            child_process.wait()
        except KeyboardInterrupt:
            shutdown_message = "Received termination signal, shutting down the program..."
            print(shutdown_message)
            write_to_log(log_file, shutdown_message)
            child_process.terminate()
            try:
                child_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child_process.kill()
            break

        if child_process.returncode == 42 or child_process.returncode == 43 or child_process.returncode == 44:
            crash_message = (
                f"The subprocess exited abnormally (exit code: {child_process.returncode}). "
            )
            print(crash_message)
            write_to_log(log_file, crash_message)
            child_process.terminate()
            try:
                child_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child_process.kill()
            break

        if child_process.returncode != 0:  # (Crash)
            crash_message = (
                f"The subprocess exited abnormally (exit code: {child_process.returncode}). "
                "Restarting after 3 seconds..."
            )
            print(crash_message)
            write_to_log(log_file, crash_message)
            # Do NOT auto-load LastPipeline.json after a crash:
            # if the pipeline caused the crash (e.g. TLS exhaustion), auto-loading
            # creates an infinite crash loop. Start clean; user can reload from presets.
            _ = args.pop("load", None)
            # Discard any pending autoload request too, in case the crash happened
            # mid-restart — we don't want a stale request surviving to a later exit.
            try:
                os.remove(_AUTOLOAD_FILE)
            except FileNotFoundError:
                pass
            time.sleep(3)
        else: #("/reload", "New project", or "Load preset" for clearing memory)
            # If the child wrote an autoload request (Agent -> Load), start the next
            # child with that preset; otherwise start clean (New -> Discard / plain reload).
            try:
                with open(_AUTOLOAD_FILE) as f:
                    args["load"] = f.read().strip()
                os.remove(_AUTOLOAD_FILE)
            except FileNotFoundError:
                _ = args.pop("load", None)
            write_to_log(log_file, "Subprocess exited normally.")

if __name__ == "__main__":
    LOG_FILE = None
    if "--no-child" not in sys.argv:
        # Get the current time and format it for the log file name
        current_time = (datetime.utcnow() + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S")

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
