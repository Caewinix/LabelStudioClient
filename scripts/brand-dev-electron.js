const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const appName = 'Label Studio';
const bundleId = 'io.codex.labelstudio.dev';
const root = path.resolve(__dirname, '..');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

function replacePlistValue(plistPath, key, value) {
  run('plutil', ['-replace', key, '-string', value, plistPath]);
}

function brandMacDevElectron() {
  const electronAppPath = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
  const plistPath = path.join(electronAppPath, 'Contents', 'Info.plist');
  const targetIconPath = path.join(electronAppPath, 'Contents', 'Resources', 'electron.icns');
  const sourceIconPath = path.join(root, 'icons', 'logo.icns');

  if (!fs.existsSync(plistPath)) return;

  replacePlistValue(plistPath, 'CFBundleDisplayName', appName);
  replacePlistValue(plistPath, 'CFBundleName', appName);
  replacePlistValue(plistPath, 'CFBundleIdentifier', bundleId);

  if (fs.existsSync(sourceIconPath)) {
    fs.copyFileSync(sourceIconPath, targetIconPath);
  }

  fs.utimesSync(electronAppPath, new Date(), new Date());
}

if (process.platform === 'darwin') {
  brandMacDevElectron();
}
