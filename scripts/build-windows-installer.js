const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseWindowsArchitectureArguments } = require('./windows-architecture');

const root = path.resolve(__dirname, '..');
const project = path.join(root, 'native', 'windows-installer', 'LabelStudioInstaller.csproj');
const output = path.join(root, 'dist', 'windows-installer');
const { architectures: targets, passthroughArguments } = parseWindowsArchitectureArguments(process.argv.slice(2));

if (passthroughArguments.length > 0) {
    throw new Error(`Unknown Windows installer build arguments: ${passthroughArguments.join(' ')}`);
}
fs.mkdirSync(output, { recursive: true });

for (const target of targets) {
    const targetOutput = path.join(output, target.arch);
    const executable = path.join(targetOutput, 'Label Studio Installer.exe');
    fs.rmSync(targetOutput, { recursive: true, force: true });
    fs.mkdirSync(targetOutput, { recursive: true });

    const result = spawnSync('dotnet', [
        'publish',
        project,
        '--configuration', 'Release',
        '--runtime', target.dotnetRuntime,
        '--self-contained', 'true',
        '--output', targetOutput,
        '--nologo',
    ], {
        cwd: root,
        stdio: 'inherit',
    });

    if (result.error) {
        throw new Error(`Could not build Label Studio Installer.exe. Install the .NET 8 SDK and try again.\n${result.error.message}`);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
    if (!fs.existsSync(executable)) {
        throw new Error(`The Windows installer build completed without producing ${executable}.`);
    }

    const header = fs.readFileSync(executable).subarray(0, 2).toString('ascii');
    if (header !== 'MZ') throw new Error(`${executable} is not a Windows executable.`);
    console.log(`Built ${path.relative(root, executable)}`);
}
