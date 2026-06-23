#!/usr/bin/env python3
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote
from urllib.request import urlopen, Request


def detect_project_root() -> Path:
    if os.environ.get('LABEL_STUDIO_PROJECT_ROOT'):
        return Path(os.environ['LABEL_STUDIO_PROJECT_ROOT']).expanduser().resolve()
    # During development this script is copied to dist/Python, while the project
    # root is one level above dist. In source form it lives in Python directly.
    script_parent = Path(__file__).resolve().parents[1]
    if script_parent.name == 'dist':
        return script_parent.parent
    return script_parent


ROOT = detect_project_root()

def detect_runtime_root() -> Path:
    if os.environ.get('LABEL_STUDIO_RUNTIME_ROOT'):
        return Path(os.environ['LABEL_STUDIO_RUNTIME_ROOT']).expanduser().resolve()
    executable = Path(sys.executable).resolve()
    # UpdateService runs this manager with AppPaths.runtimePython(), i.e.
    # <runtime>/bin/Python on macOS or the platform runtime Python elsewhere.
    # Infer the runtime from sys.executable so the
    # manager does not require extra Electron-only environment variables.
    if executable.name in ('Python', 'Python.exe', 'PythonCore', 'PythonCore.exe') and executable.parent.name in ('bin', 'Scripts'):
        return executable.parent.parent
    if executable.name.lower() == 'python.exe' and executable.parent.name != 'Scripts':
        return executable.parent
    if executable.parent.name in ('bin', 'Scripts') and (executable.parent.parent / 'bin' / 'Python').exists():
        return executable.parent.parent
    return ROOT / '.runtime' / 'python'

RUNTIME = detect_runtime_root()
if sys.platform == 'darwin':
    BIN = RUNTIME / 'bin'
    PYTHON = BIN / 'python'
    RUNTIME_PYTHON = BIN / 'Python'
elif os.name == 'nt':
    BIN = RUNTIME
    PYTHON = RUNTIME / 'python.exe'
    RUNTIME_PYTHON = PYTHON
else:
    BIN = RUNTIME / 'bin'
    PYTHON = BIN / 'python3'
    RUNTIME_PYTHON = PYTHON
PACKAGE = 'label-studio'
CACHE = Path(os.environ.get('LABEL_STUDIO_RUNTIME_CACHE', str(ROOT / 'cache' / 'package' / 'wheelhouse'))).expanduser().resolve()
PIP_CACHE = Path(os.environ.get('PIP_CACHE_DIR', str(ROOT / 'cache' / 'package' / 'pip'))).expanduser().resolve()
ANACONDA_MINICONDA_BASE_URL = 'https://repo.anaconda.com/miniconda/'
TUNA_MINICONDA_BASE_URL = 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/'


def runtime_path_entries():
    entries = [BIN]
    if os.name == 'nt':
        entries.extend([RUNTIME, RUNTIME / 'Scripts'])
    seen = set()
    result = []
    for entry in entries:
        text = str(entry)
        if text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def clean_env():
    env = os.environ.copy()
    for key in ('PYTHONHOME', 'PYTHONPATH', 'DYLD_FRAMEWORK_PATH', 'DYLD_LIBRARY_PATH', 'VIRTUAL_ENV'):
        env.pop(key, None)
    env['PYTHONUNBUFFERED'] = '1'
    env['PIP_CACHE_DIR'] = str(PIP_CACHE)
    env['PATH'] = os.pathsep.join(runtime_path_entries() + [env.get('PATH', '')])

    python_home = RUNTIME / 'Library' / 'Frameworks' / 'Python.framework' / 'Versions' / 'Current'
    if python_home.exists():
        env['PYTHONHOME'] = str(python_home)
        env['DYLD_FRAMEWORK_PATH'] = str(RUNTIME / 'Library' / 'Frameworks')
        env['DYLD_LIBRARY_PATH'] = str(python_home / 'lib')
    elif (RUNTIME / 'pyvenv.cfg').exists():
        env['VIRTUAL_ENV'] = str(RUNTIME)
    elif sys.platform.startswith('linux'):
        runtime_lib = str(RUNTIME / 'lib')
        env['LD_LIBRARY_PATH'] = runtime_lib + (os.pathsep + env['LD_LIBRARY_PATH'] if env.get('LD_LIBRARY_PATH') else '')
    return env


def runtime_python() -> Path:
    # Embedded commands run through bin/Python, not through the
    # framework bin/python symlink.  The official python.org framework's
    # bin/python can resolve sys.executable back to Resources/Python.app, and
    # this app bundle is intentionally removed from the embedded runtime after
    # Python is copied out.  Running ensurepip through bin/python can then
    # fail with a posix_spawn error.
    if RUNTIME_PYTHON.exists():
        return RUNTIME_PYTHON
    return PYTHON


def run(cmd):
    return subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True, env=clean_env()).strip()


def ensure_runtime():
    if not PYTHON.exists():
        raise SystemExit(f'Missing managed Python runtime: {PYTHON}')

    if not RUNTIME_PYTHON.exists() and not RUNTIME_PYTHON.is_symlink():
        RUNTIME_PYTHON.parent.mkdir(parents=True, exist_ok=True)
        try:
            RUNTIME_PYTHON.symlink_to(PYTHON.name)
        except Exception:
            shutil.copy2(PYTHON, RUNTIME_PYTHON)
        try:
            RUNTIME_PYTHON.chmod(0o755)
        except Exception:
            pass

    try:
        subprocess.check_call(
            [str(runtime_python()), '-m', 'pip', '--version'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=clean_env(),
        )
        return
    except Exception:
        pass

    try:
        subprocess.check_call(
            [str(runtime_python()), '-m', 'pip', '--version'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=clean_env(),
        )
        return
    except Exception:
        pass

    print('12% Bootstrapping pip', flush=True)
    subprocess.check_call([str(runtime_python()), '-m', 'ensurepip', '--upgrade'], env=clean_env())


def package_version():
    try:
        out = subprocess.check_output(
            [str(runtime_python()), '-m', 'pip', 'show', PACKAGE],
            stderr=subprocess.DEVNULL,
            text=True,
            env=clean_env(),
        )
        for line in out.splitlines():
            if line.startswith('Version:'):
                return line.split(':', 1)[1].strip()
    except Exception:
        pass
    return 'Not installed'


def python_version():
    out = subprocess.check_output([str(runtime_python()), '--version'], stderr=subprocess.STDOUT, text=True, env=clean_env()).strip()
    return out.replace('Python ', '')


def pypi_latest():
    req = Request(f'https://pypi.org/pypi/{PACKAGE}/json', headers={'User-Agent': 'Label-Studio-Electron-Manager'})
    with urlopen(req) as r:
        data = json.loads(r.read().decode('utf-8'))
    requires = data.get('info', {}).get('requires_python') or '>=3.9'
    return data.get('info', {}).get('version') or 'Unknown', requires


def npm_electron_latest():
    req = Request('https://registry.npmjs.org/electron/latest', headers={'User-Agent': 'Label-Studio-Electron-Manager'})
    with urlopen(req) as r:
        return json.loads(r.read().decode('utf-8')).get('version', 'Unknown')


def parse_min_python(spec):
    m = re.search(r'>=\s*(\d+(?:\.\d+)*)', spec or '')
    return m.group(1) if m else '3.9'


def minimum_python_series(spec):
    minimum = parse_min_python(spec)
    pieces = minimum.split('.')
    if len(pieces) >= 2:
        return f'{pieces[0]}.{pieces[1]}'
    return minimum


def fetch_text_with_fallback(urls):
    last_error = None
    for url in urls:
        try:
            req = Request(url, headers={'User-Agent': 'Label-Studio-Electron-Manager'})
            with urlopen(req) as r:
                return r.read().decode('utf-8', errors='ignore')
        except Exception as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise RuntimeError('No URL candidates were provided.')


def miniconda_installer_platform_suffix():
    machine = platform.machine().lower()
    if sys.platform.startswith('win'):
        if machine in ('amd64', 'x86_64'):
            return 'Windows-x86_64.exe'
        if machine in ('arm64', 'aarch64'):
            return 'Windows-aarch64.exe'
    if sys.platform.startswith('linux'):
        if machine in ('amd64', 'x86_64'):
            return 'Linux-x86_64.sh'
        if machine in ('arm64', 'aarch64'):
            return 'Linux-aarch64.sh'
        if machine == 'ppc64le':
            return 'Linux-ppc64le.sh'
        if machine == 's390x':
            return 'Linux-s390x.sh'
    return ''


def miniconda_python_series(text):
    if not text.isdigit() or len(text) < 2:
        return ''
    return f'{text[0]}.{text[1:]}'


def anaconda_miniconda_installers():
    suffix = miniconda_installer_platform_suffix()
    if not suffix:
        return []
    html = fetch_text_with_fallback([ANACONDA_MINICONDA_BASE_URL, TUNA_MINICONDA_BASE_URL])
    pattern = re.compile(r'href="(Miniconda3-py(\d+)_([^"]+)-' + re.escape(suffix) + r')"')
    installers = []
    for filename, py_tag, installer_version in pattern.findall(html):
        series = miniconda_python_series(py_tag)
        if not series:
            continue
        installers.append({
            'filename': unquote(filename),
            'python_series': series,
            'installer_version': installer_version,
        })
    return installers


def available_python_versions():
    if sys.platform != 'darwin':
        versions = {installer['python_series'] for installer in anaconda_miniconda_installers()}
        return sorted(versions, key=version_tuple, reverse=True)

    req = Request('https://www.python.org/ftp/python/', headers={'User-Agent': 'Label-Studio-Electron-Manager'})
    with urlopen(req) as r:
        html = r.read().decode('utf-8', errors='ignore')
    versions = set(re.findall(r'href="(\d+\.\d+\.\d+)/"', html))
    return sorted(versions, key=version_tuple, reverse=True)


def python_package_name(version):
    if sys.platform != 'darwin':
        requested_series = '.'.join((version or '').split('.')[:2])
        candidates = [
            installer for installer in anaconda_miniconda_installers()
            if installer['python_series'] == requested_series
        ]
        candidates.sort(key=lambda item: version_tuple(item['installer_version']), reverse=True)
        return candidates[0]['filename'] if candidates else None

    req = Request(f'https://www.python.org/ftp/python/{version}/', headers={'User-Agent': 'Label-Studio-Electron-Manager'})
    with urlopen(req) as r:
        html = r.read().decode('utf-8', errors='ignore')
    escaped = re.escape(version)
    match = re.search(r'href="(python-' + escaped + r'-macos\d+\.pkg)"', html)
    if not match:
        return None
    return match.group(1)


def latest_python_version():
    for version in available_python_versions():
        if python_package_name(version):
            return version
    return 'Unknown'


def latest_installer_version_for_requirement(requires_python):
    series = minimum_python_series(requires_python)
    for version in available_python_versions():
        if (version == series or version.startswith(series + '.')) and python_package_name(version):
            return version
    return latest_python_version()


def version_tuple(text):
    parts = []
    for part in re.findall(r'\d+', text or ''):
        parts.append(int(part))
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def python_version_satisfies(version, requirement):
    requirement = (requirement or '').strip()
    if not requirement:
        return True
    current = version_tuple(version)
    for clause in [c.strip() for c in requirement.split(',') if c.strip()]:
        m = re.match(r'(>=|<=|==|!=|>|<)\s*([^,;\s]+)', clause)
        if not m:
            continue
        op, raw = m.groups()
        target = version_tuple(raw)
        if op == '>=' and not (current >= target): return False
        if op == '<=' and not (current <= target): return False
        if op == '==' and not (current == target): return False
        if op == '!=' and not (current != target): return False
        if op == '>' and not (current > target): return False
        if op == '<' and not (current < target): return False
    return True


def satisfies_current_python(spec):
    return python_version_satisfies(python_version(), spec)



def package_download_info():
    # Mirrors Swift RuntimeBootstrapService.packageDownload(version:):
    # choose a non-yanked wheel from the project-level PyPI JSON and prefer
    # python_version == "py3". Do not call python_version() here: during first
    # bootstrap the embedded runtime may not exist yet, and Swift chooses the
    # package first, then chooses a Python installer from requires_python.
    req = Request(f'https://pypi.org/pypi/{PACKAGE}/json', headers={'User-Agent': 'Label-Studio-Electron-Manager'})
    with urlopen(req) as r:
        data = json.loads(r.read().decode('utf-8'))
    version = data.get('info', {}).get('version') or 'Unknown'
    project_requires = data.get('info', {}).get('requires_python') or ''
    releases = data.get('releases', {}).get(version, []) or data.get('urls', [])
    candidates = [
        f for f in releases
        if not f.get('yanked')
        and (f.get('packagetype') == 'bdist_wheel' or str(f.get('filename', '')).endswith('.whl'))
        and str(f.get('filename', '')).endswith('.whl')
    ]
    chosen = next((f for f in candidates if f.get('python_version') == 'py3'), None) or (candidates[0] if candidates else None)
    if not chosen:
        raise SystemExit(f'Unable to find a PyPI wheel for {PACKAGE} {version}.')
    return {
        'version': version,
        'requires_python': chosen.get('requires_python') or project_requires,
        'url': chosen.get('url'),
        'filename': chosen.get('filename'),
        'size': chosen.get('size'),
    }

def check_package():
    current = package_version()
    latest, requires = pypi_latest()
    return {
        'current_package_version': current,
        'current_python_version': python_version(),
        'latest_package_version': latest,
        'requires_python': requires,
        'minimum_python_version': parse_min_python(requires),
        'python_satisfies_latest_package': satisfies_current_python(requires),
        'update_available': current == 'Not installed' or current != latest,
    }


def check_python():
    latest_pkg, requires = pypi_latest()
    current = python_version()
    latest_installer = latest_python_version()
    return {
        'current_python_version': current,
        'latest_package_version': latest_pkg,
        'requires_python': requires,
        'minimum_python_version': parse_min_python(requires),
        'python_satisfies_latest_package': python_version_satisfies(current, requires),
        'latest_installer_version': latest_installer,
        'update_available': latest_installer != 'Unknown' and version_tuple(current) < version_tuple(latest_installer),
    }


def versions():
    return {
        'package_version': package_version(),
        'python_version': python_version(),
    }


def ensure_package(upgrade=False, local_package=None):
    ensure_runtime()
    print('25% Installing Label Studio package', flush=True)
    cmd = [str(runtime_python()), '-m', 'pip', 'install']
    if upgrade:
        cmd.append('--upgrade')
    if local_package:
        cmd.append(str(Path(local_package).expanduser().resolve()))
    else:
        cmd.append(PACKAGE)
    subprocess.check_call(cmd, env=clean_env())
    print('100% Runtime ready', flush=True)
    return versions()


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else 'versions'
    local_package = sys.argv[2] if len(sys.argv) > 2 else None
    if command == 'versions': result = versions()
    elif command == 'ensure-runtime':
        ensure_runtime()
        result = versions()
    elif command == 'package-download-info': result = package_download_info()
    elif command == 'check-package': result = check_package()
    elif command == 'check-python': result = check_python()
    elif command in ('ensure-all', 'ensure-package'): result = ensure_package(False, local_package)
    elif command == 'update-package': result = ensure_package(True, local_package)
    elif command == 'update-python': result = versions()
    elif command in ('ensure-electron', 'update-electron'):
        result = {'electron_latest': npm_electron_latest()}
    elif command == 'update-all': result = ensure_package(True, local_package)
    else:
        raise SystemExit(f'Unknown command: {command}')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
