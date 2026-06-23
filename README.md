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

### Linux

```bash
npm run pack:linux
npm run dist:linux
```

### Build All Targets

```bash
npm run pack:all
npm run dist:all
```

## Scripts

- `npm run build` - compile TypeScript and copy renderer/assets
- `npm run typecheck` - run TypeScript type checking only
- `npm run clean` - remove build output, caches, and installed dependencies

## Runtime Layout

The app keeps runtime and download data in local cache directories under the project/app support locations. The bootstrap flow manages separate cache areas for:

- Python runtime downloads
- Electron runtime downloads
- Package and wheelhouse downloads

The packaged app resources are copied into the generated `.app` or platform distribution output by `electron-builder`.

## Project Structure

- `src/main` - main process, bootstrap, update, and window control
- `src/renderer` - splash and update UI
- `src/preload` - IPC bridges
- `python` - embedded runtime launcher scripts
- `assets` - shared UI assets
- `icons` - platform icons used by packaging

## Notes

- The macOS packaging flow is configured to build a universal app.
- The project is intentionally close to the original launcher behavior, but implemented in Electron/TypeScript.

## License

No license file is included in this repository snapshot.
