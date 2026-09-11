#!/usr/bin/env python3

from __future__ import annotations

import argparse
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Launch the embedded Label Studio service.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def find_available_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


def normalize_loopback_host(host: str) -> str:
    return "127.0.0.1" if host in ("localhost", "::1") else host


def write_socket_sitecustomize(data_dir: Path) -> Path:
    shim_dir = data_dir / ".python-sitecustomize"
    shim_dir.mkdir(parents=True, exist_ok=True)
    shim_path = shim_dir / "sitecustomize.py"
    content = '''\
import socket as _socket
import webbrowser as _webbrowser

_original_getaddrinfo = _socket.getaddrinfo
_original_connect = _socket.socket.connect
_original_connect_ex = _socket.socket.connect_ex

def _loopback_address(address):
    if isinstance(address, tuple) and len(address) >= 2 and address[0] == "localhost":
        return ("127.0.0.1",) + tuple(address[1:])
    return address

def getaddrinfo(host, *args, **kwargs):
    if host == "localhost":
        host = "127.0.0.1"
    return _original_getaddrinfo(host, *args, **kwargs)

def connect(self, address):
    return _original_connect(self, _loopback_address(address))

def connect_ex(self, address):
    return _original_connect_ex(self, _loopback_address(address))

_socket.getaddrinfo = getaddrinfo
_socket.socket.connect = connect
_socket.socket.connect_ex = connect_ex

def _disabled_browser_open(*_args, **_kwargs):
    return False

_webbrowser.open = _disabled_browser_open
_webbrowser.open_new = _disabled_browser_open
_webbrowser.open_new_tab = _disabled_browser_open
'''
    try:
        if not shim_path.exists() or shim_path.read_text(encoding="utf-8") != content:
            shim_path.write_text(content, encoding="utf-8")
    except Exception:
        shim_path.write_text(content, encoding="utf-8")
    return shim_dir


def prepend_pythonpath(env: dict[str, str], path_value: Path) -> None:
    current = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(path_value) if not current else str(path_value) + os.pathsep + current


def wait_for_http_ready(host: str, port: int, process: subprocess.Popen[str], max_seconds: float = 45.0) -> bool:
    deadline = time.monotonic() + max_seconds

    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False

        try:
            connection = http.client.HTTPConnection(host, port, timeout=1.0)
            connection.request("GET", "/user/login/")
            response = connection.getresponse()
            response.read()
            connection.close()
            return True
        except Exception:
            try:
                connection.close()  # type: ignore[name-defined]
            except Exception:
                pass

        time.sleep(0.25)

    return process.poll() is None


def emit_listening_event(host: str, port: int, pid: int | None) -> None:
    payload = {
        "event": "listening",
        "url": f"http://{host}:{port}/",
        "pid": pid,
    }
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def forward_pipe(pipe, target) -> None:
    try:
        for line in pipe:
            target.write(line)
            target.flush()
    except Exception:
        pass


def terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return

    try:
        process.terminate()
    except Exception:
        return

    try:
        process.wait(timeout=5)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def main() -> int:
    args = parse_args()

    host = normalize_loopback_host(args.host)
    port = args.port if args.port and args.port > 0 else find_available_port(host)
    data_dir = Path(args.data_dir).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    sitecustomize_dir = write_socket_sitecustomize(data_dir)

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONSAFEPATH"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env.setdefault("LABEL_STUDIO_DISABLE_ANALYTICS", "1")
    env["BROWSER"] = ""
    env.setdefault("NO_PROXY", "127.0.0.1,localhost")
    env.setdefault("no_proxy", "127.0.0.1,localhost")
    prepend_pythonpath(env, sitecustomize_dir)

    cmd = [
        sys.executable,
        "-c",
        "from label_studio.server import main; main()",
        "start",
        "--host",
        host,
        "--internal-host",
        host,
        "--port",
        str(port),
        "--data-dir",
        str(data_dir),
        "--no-browser",
        "--log-level",
        str(args.log_level),
    ]

    process = subprocess.Popen(
        cmd,
        cwd=str(data_dir),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    def handle_signal(_signum, _frame) -> None:
        terminate_process(process)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    stdout_thread = threading.Thread(
        target=forward_pipe,
        args=(process.stdout, sys.stdout),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=forward_pipe,
        args=(process.stderr, sys.stderr),
        daemon=True,
    )

    stdout_thread.start()
    stderr_thread.start()

    if wait_for_http_ready(host, port, process):
        emit_listening_event(host, port, process.pid)

    return_code = process.wait()

    try:
        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)
    except Exception:
        pass

    return int(return_code)


if __name__ == "__main__":
    raise SystemExit(main())
