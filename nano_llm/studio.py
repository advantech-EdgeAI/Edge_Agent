# -*- coding: utf-8 -*-
import subprocess
import sys
import time
import os
import signal
import argparse
from datetime import datetime, timedelta

# Add the project root directory to the Python path
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(os.path.dirname(current_dir))
sys.path.insert(0, project_root)

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
    run_studio(args)

def signal_handler(signum, frame):
    """Handle the SIGUSR1 signal to restart the subprocess"""
    global child_process
    if signum == signal.SIGUSR1:
        print("Received restart signal, preparing to restart the subprocess...")
        if child_process:
            # Terminate the existing subprocess
            child_process.terminate()
            try:
                child_process.wait(timeout=5)  # Wait for the subprocess to terminate
            except subprocess.TimeoutExpired:
                child_process.kill()  # If the wait times out, forcefully terminate
            # Start a new subprocess
            child_process = start_child_process()

def start_child_process(args):
    """Start the subprocess, retaining the original command line arguments"""
    args_list = []
    for key, value in args.items():
        if value is not None:
            if key in ["load", "agent-dir", "index", "root"]:
                args_list.append(f"--{key}")
                args_list.append(value)
    return subprocess.Popen([sys.executable, "-m", "nano_llm.studio", "--no-child"] + args_list,
                          stdout=sys.stdout,
                          stderr=sys.stderr)

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

    signal.signal(signal.SIGUSR1, signal_handler)

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
            args["load"] = "LastPipeline.json"
            time.sleep(3)
        else: #("/reload" or "New project" for clearing memory)
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
    parser.add_argument("--agent-dir", type=str, default="/data/nano_llm/agents", help="change the agent load/save directory (should be under web/templates)")
    parser.add_argument("--index", "--page", type=str, default="studio.html", help="the filename of the site's index html page (should have static/ and template/)")
    parser.add_argument("--root", type=str, default=None, help="the root directory for serving site files")   
    parser.add_argument("--no-child", action="store_true", help="If you want to run with only one main process")
    args = parser.parse_args()

    if LOG_FILE:
        write_to_log(LOG_FILE, "Initializing program with arguments:")
        write_to_log(LOG_FILE, str(vars(args)))

    main(log_file=LOG_FILE, **vars(args))
