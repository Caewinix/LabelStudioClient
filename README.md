# Label Studio Client

Electron version of the Label Studio desktop launcher.

## Features

- Cross-platform desktop launcher for macOS, Windows, and Linux
- Splash screen with staged bootstrap progress
- Update window for Electron, package, and Python checks
- Managed runtime download cache and staged install flow
- Platform-specific packaging via `electron-builder`

## Requirements

- Node.js 18 or newer
- npm
- Platform build tools required by `electron-builder`
- .NET 8 SDK when building Windows packages (used to publish the self-contained installer executable)
- On macOS, code signing/notarization credentials if you want signed distribution builds

## Install

```bash
npm install
```

## Run In Development

```bash
npm start
```

`npm start` builds the TypeScript sources, brands the local Electron app for development, and launches the app.

## Build

### macOS

```bash
npm run pack:mac
npm run dist:mac
```

`pack:mac` produces an unpacked universal `.app` in `release/mac-universal/`.

`dist:mac` produces a distributable macOS package target.

### Windows

```bash
npm run pack:win
npm run dist:win
```

Both Windows commands build and bundle `Label Studio Installer.exe`. With no architecture argument they use the build machine architecture. Select one explicitly with `npm run pack:win -- --x64`, `--arm64` (or `--arm`), or `--ia32` (or `--x86`); `dist:win` accepts the same arguments. Multiple architecture flags build all requested targets. On Windows, `npm start` also builds the installer for the current architecture before launching Electron.

The installer is self-contained, so end users do not need to install .NET. Its C# implementation owns UAC elevation, named-pipe coordination, transactional Electron file replacement, rollback, and app restart directly; it does not invoke PowerShell.

### Linux
Comming soon...

## Scripts

- `npm run build` - compile TypeScript and copy renderer/assets
- `npm run typecheck` - run TypeScript type checking only
- `npm run clean` - remove build output, caches, and installed dependencies

## Project Structure

- `src/main` - main process, bootstrap, update, and window control
- `src/renderer` - splash and update UI
- `src/preload` - IPC bridges
- `python` - embedded runtime launcher scripts
- `assets` - shared UI assets
- `icons` - platform icons used by packaging