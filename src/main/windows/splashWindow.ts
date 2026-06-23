import path from 'node:path';
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import { LaunchStage } from '../services/launchModels';
import { resolveAppIconPath } from '../utils/appIcon';

const heightLimitRatio = 0.92;

const SplashTheme = {
  windowWidthRatio: 0.5292,
  windowAspectRatio: 0.5357
};

const WindowsSplashMaterial: NonNullable<Electron.BrowserWindowConstructorOptions['backgroundMaterial']> = 'acrylic';
const rendererReadyPromises = new WeakMap<BrowserWindow, Promise<void>>();

function currentScreenFrame(win?: BrowserWindow | null): Electron.Rectangle {
  if (win && !win.isDestroyed()) {
    return screen.getDisplayMatching(win.getBounds()).bounds;
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
}

function splashFrame(frame: Electron.Rectangle): Electron.Rectangle {
  const widthFromScreen = frame.width * SplashTheme.windowWidthRatio;
  const heightFromWidth = widthFromScreen * SplashTheme.windowAspectRatio;
  const heightLimit = frame.height * heightLimitRatio;

  let width: number;
  let height: number;

  if (heightFromWidth <= heightLimit) {
    width = Math.round(widthFromScreen);
    height = Math.round(heightFromWidth);
  } else {
    height = Math.round(heightLimit);
    width = Math.round(height / SplashTheme.windowAspectRatio);
  }

  return {
    x: Math.round(frame.x + frame.width / 2 - width / 2),
    y: Math.round(frame.y + frame.height / 2 - height / 2),
    width,
    height
  };
}

function splashWindowOptions(frame: Electron.Rectangle): Electron.BrowserWindowConstructorOptions {
  const options: Electron.BrowserWindowConstructorOptions = {
    ...frame,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    transparent: true,
    show: false,
    hasShadow: true,
    movable: false,
    backgroundColor: '#00000000',
    icon: resolveAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../../preload/splashPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  if (process.platform === 'darwin') {
    options.vibrancy = 'popover';
    options.visualEffectState = 'active';
  } else if (process.platform === 'win32') {
    options.backgroundMaterial = WindowsSplashMaterial;
  }

  return options;
}

function applyPlatformSplashMaterial(win: BrowserWindow): void {
  if (process.platform !== 'win32') return;

  try {
    win.setBackgroundMaterial(WindowsSplashMaterial);
  } catch {
    // Windows acrylic is only available on supported Windows releases. Keep the
    // transparent CSS fallback instead of failing the splash window.
  }
}

export function relayoutSplashWindowForCurrentScreen(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.setBounds(splashFrame(currentScreenFrame(win)), false);
}

export function createSplashWindow(): BrowserWindow {
  const frame = splashFrame(currentScreenFrame(null));
  const win = new BrowserWindow(splashWindowOptions(frame));
  let didShow = false;
  let resolveRendererReady: (() => void) | undefined;
  const rendererReadyPromise = new Promise<void>((resolve) => {
    resolveRendererReady = resolve;
  });

  const showAfterRendererLayout = (): void => {
    if (didShow || win.isDestroyed()) return;
    didShow = true;
    win.show();
  };

  const rendererReadyHandler = (event: IpcMainEvent): void => {
    if (event.sender !== win.webContents) return;
    showAfterRendererLayout();
    resolveRendererReady?.();
    resolveRendererReady = undefined;
  };

  applyPlatformSplashMaterial(win);
  win.setMenuBarVisibility(false);
  rendererReadyPromises.set(win, rendererReadyPromise);
  ipcMain.on('launch-renderer-ready', rendererReadyHandler);
  win.loadFile(path.join(__dirname, '../../renderer/splash/index.html'));

  const relayout = (): void => relayoutSplashWindowForCurrentScreen(win);
  screen.on('display-added', relayout);
  screen.on('display-removed', relayout);
  screen.on('display-metrics-changed', relayout);
  win.on('closed', () => {
    resolveRendererReady?.();
    resolveRendererReady = undefined;
    rendererReadyPromises.delete(win);
    ipcMain.off('launch-renderer-ready', rendererReadyHandler);
    screen.off('display-added', relayout);
    screen.off('display-removed', relayout);
    screen.off('display-metrics-changed', relayout);
  });

  return win;
}

export async function waitForSplashRendererReady(win: BrowserWindow | null | undefined): Promise<void> {
  if (!win || win.isDestroyed()) return;
  await (rendererReadyPromises.get(win) ?? Promise.resolve());
}

export function updateSplash(win: BrowserWindow | null | undefined, stage: LaunchStage): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('launch-stage', stage);
}

export function updateSplashDownloadPaused(win: BrowserWindow | null | undefined, paused: boolean): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('launch-download-paused', paused);
}
