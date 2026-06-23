#!/usr/bin/env python3

from __future__ import annotations

import argparse
import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import sysconfig
import threading
import time
from pathlib import Path
from typing import Iterable


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Launch the embedded Label Studio service.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def detect_runtime_root() -> Path | None:
    env_root = os.environ.get("LABEL_STUDIO_RUNTIME_ROOT")
    if env_root:
        return Path(env_root).resolve()

    python_bin = Path(sys.executable).resolve()

    # Development / packaged runtime Python:
    #   .../Runtime/bin/Python
    if python_bin.parent.name in ("bin", "Scripts"):
        return python_bin.parent.parent
    if os.name == "nt" and python_bin.name.lower() == "python.exe":
        return python_bin.parent

    # Official macOS framework Python:
    #   .../Runtime/Library/Frameworks/Python.framework/Versions/Current/bin/python3
    parts = python_bin.parts
    if "Python.framework" in parts:
        framework_index = parts.index("Python.framework")
        if framework_index >= 2:
            runtime_parts = parts[: framework_index - 2]
            if runtime_parts:
                return Path(*runtime_parts).resolve()

    return None


def unique_paths(paths: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []

    for item in paths:
        try:
            key = str(item.resolve())
        except Exception:
            key = str(item)

        if key in seen:
            continue

        seen.add(key)
        result.append(item)

    return result


def executable_names() -> list[str]:
    if os.name == "nt":
        return ["label-studio.exe", "label-studio.cmd", "label-studio.bat", "label-studio"]
    return ["label-studio"]


def make_executable_if_possible(path_value: Path) -> bool:
    if not path_value.exists():
        return False

    if os.access(path_value, os.X_OK):
        return True

    try:
        current_mode = path_value.stat().st_mode
        path_value.chmod(current_mode | 0o755)
    except Exception:
        return False

    return os.access(path_value, os.X_OK)


def label_studio_cli() -> Path:
    python_bin = Path(sys.executable).resolve()
    bin_dir = python_bin.parent
    names = executable_names()
    candidates: list[Path] = []

    for name in names:
        candidates.append(bin_dir / name)

    runtime_root = detect_runtime_root()
    if runtime_root is not None:
        for name in names:
            candidates.append(runtime_root / "Scripts" / name)
            candidates.append(runtime_root / "bin" / name)
            candidates.append(runtime_root / name)

            candidates.append(
                runtime_root
                / "Library"
                / "Frameworks"
                / "Python.framework"
                / "Versions"
                / "Current"
                / "bin"
                / name
            )

            candidates.append(
                runtime_root
                / "Library"
                / "Frameworks"
                / "Python.framework"
                / "Versions"
                / "3.10"
                / "bin"
                / name
            )

            candidates.append(
                runtime_root
                / "Library"
                / "Frameworks"
                / "Python.framework"
                / "Versions"
                / "3.11"
                / "bin"
                / name
            )

            candidates.append(
                runtime_root
                / "Library"
                / "Frameworks"
                / "Python.framework"
                / "Versions"
                / "3.12"
                / "bin"
                / name
            )

        versions_dir = (
            runtime_root
            / "Library"
            / "Frameworks"
            / "Python.framework"
            / "Versions"
        )
        if versions_dir.exists():
            for version_dir in versions_dir.iterdir():
                if not version_dir.is_dir():
                    continue
                for name in names:
                    candidates.append(version_dir / "bin" / name)

    try:
        scripts_dir = Path(sysconfig.get_path("scripts")).resolve()
        for name in names:
            candidates.append(scripts_dir / name)
    except Exception:
        pass

    for name in names:
        found = shutil.which(name)
        if found:
            candidates.append(Path(found).resolve())

    candidates = unique_paths(candidates)

    for candidate in candidates:
        if make_executable_if_possible(candidate):
            return candidate.resolve()

    formatted = "\n".join(f"  - {candidate}" for candidate in candidates)
    raise FileNotFoundError(
        "Missing Label Studio CLI. Expected one of:\n"
        f"{formatted}"
    )


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

    cli = label_studio_cli()

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env.setdefault("LABEL_STUDIO_DISABLE_ANALYTICS", "1")
    env.setdefault("NO_PROXY", "127.0.0.1,localhost")
    env.setdefault("no_proxy", "127.0.0.1,localhost")
    prepend_pythonpath(env, sitecustomize_dir)

    cmd = [
        str(cli),
        "start",
        "--host",
        host,
        "--internal-host",
        host,
        "--port",
        str(port),
        "--data-dir",
        str(data_dir),
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
