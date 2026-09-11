const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeWindowsArchitecture } = require('./windows-architecture');

const root = path.resolve(__dirname, '..');
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [path.join(root, 'scripts', 'brand-dev-electron.js')]);
run(npmExecutable, ['run', 'build']);

if (process.platform === 'win32') {
    const architecture = normalizeWindowsArchitecture(process.arch);
    run(process.execPath, [
        path.join(root, 'scripts', 'build-windows-installer.js'),
        `--arch=${architecture.arch}`,
    ]);
}

const electronExecutable = require('electron');
run(electronExecutable, ['.', ...process.argv.slice(2)]);
