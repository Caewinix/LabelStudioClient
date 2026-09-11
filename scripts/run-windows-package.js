const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parseWindowsArchitectureArguments } = require('./windows-architecture');

const root = path.resolve(__dirname, '..');
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const target = process.argv[2];
if (target !== 'dir' && target !== 'nsis') {
    throw new Error('The Windows package target must be dir or nsis.');
}

const { architectures, passthroughArguments } = parseWindowsArchitectureArguments(process.argv.slice(3));

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

function electronVersion() {
    const appPackage = require(path.join(root, 'package.json'));
    return appPackage.devDependencies?.electron ?? appPackage.dependencies?.electron;
}

function defaultElectronCacheDirectories() {
    const directories = [];
    if (process.env.ELECTRON_CACHE) directories.push(process.env.ELECTRON_CACHE);

    if (process.platform === 'darwin') {
        directories.push(path.join(os.homedir(), 'Library', 'Caches', 'electron'));
    } else if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData) directories.push(path.join(localAppData, 'electron', 'Cache'));
    } else {
        directories.push(path.join(os.homedir(), '.cache', 'electron'));
    }

    return [...new Set(directories)];
}

function cachedElectronArchives(version, architecture) {
    const filename = `electron-v${version}-win32-${architecture.arch}.zip`;
    const archives = [];

    for (const cacheDirectory of defaultElectronCacheDirectories()) {
        if (!fs.existsSync(cacheDirectory)) continue;

        const directArchive = path.join(cacheDirectory, filename);
        if (fs.existsSync(directArchive)) archives.push(directArchive);

        for (const entry of fs.readdirSync(cacheDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const nestedArchive = path.join(cacheDirectory, entry.name, filename);
            if (fs.existsSync(nestedArchive)) archives.push(nestedArchive);
        }
    }

    return [...new Set(archives)];
}

function removeInvalidElectronCacheArchives() {
    const version = electronVersion();
    if (!version) return;

    const unzipProbe = spawnSync('unzip', ['-v'], { stdio: 'ignore' });
    if (unzipProbe.error) return;

    for (const architecture of architectures) {
        for (const archive of cachedElectronArchives(version, architecture)) {
            const result = spawnSync('unzip', ['-tq', archive], {
                cwd: root,
                stdio: 'ignore',
            });
            if (result.status === 0) continue;

            fs.rmSync(archive, { force: true });
            console.warn(`Removed invalid Electron cache archive: ${archive}`);
        }
    }
}

run(npmExecutable, ['run', 'build']);
run(process.execPath, [
    path.join(root, 'scripts', 'build-windows-installer.js'),
    ...architectures.map(architecture => `--arch=${architecture.arch}`),
]);
removeInvalidElectronCacheArchives();
run(process.execPath, [
    path.join(root, 'scripts', 'run-electron-builder.js'),
    '--win',
    target,
    ...architectures.map(architecture => architecture.electronBuilderFlag),
    ...passthroughArguments,
]);
