const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const distRoot = path.join(root, 'dist');
const rendererSource = path.join(root, 'src', 'renderer');
const rendererOutput = path.join(distRoot, 'renderer');

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

function copyRendererResources(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            copyRendererResources(source);
            continue;
        }
        if (!entry.isFile() || (path.extname(entry.name) !== '.html' && path.extname(entry.name) !== '.css')) {
            continue;
        }

        const destination = path.join(rendererOutput, path.relative(rendererSource, source));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
    }
}

fs.rmSync(rendererOutput, { recursive: true, force: true });
run(process.execPath, [
    path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
]);
copyRendererResources(rendererSource);

for (const directory of ['assets', 'python', 'scripts', 'Assets', 'Python', 'Scripts']) {
    fs.rmSync(path.join(distRoot, directory), { recursive: true, force: true });
}

fs.cpSync(path.join(root, 'assets'), path.join(distRoot, 'assets'), { recursive: true });
const scriptOutput = path.join(distRoot, 'scripts');
fs.mkdirSync(scriptOutput, { recursive: true });
for (const entry of fs.readdirSync(path.join(root, 'scripts'), { withFileTypes: true })) {
    if (entry.isFile() && path.extname(entry.name) === '.py') {
        fs.copyFileSync(path.join(root, 'scripts', entry.name), path.join(scriptOutput, entry.name));
    }
}
