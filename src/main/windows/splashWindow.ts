import path from 'node:path';
import os from 'node:os';
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import { LaunchStage } from '../services/launchModels';
import { resolveAppIconPath } from '../utils/appIcon';

const heightLimitRatio = 0.92;

const SplashTheme = {
    windowWidthRatio: 0.5292,
    windowAspectRatio: 0.5357
};

const isWindows = process.platform === 'win32';
const WindowsSplashMaterial: NonNullable<Electron.BrowserWindowConstructorOptions['backgroundMaterial']> = 'acrylic';
const TransparentBackgroundColor = '#00000000';
const WindowsSplashFallbackBackgroundColor = '#fffaf4';
const WindowsSystemBackdropMinimumBuild = 22621;
const rendererReadyPromises = new WeakMap<BrowserWindow, Promise<void>>();
const pendingSplashStages = new WeakMap<BrowserWindow, { stage: LaunchStage; timer: NodeJS.Timeout }>();

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
        transparent: !isWindows,
        show: false,
        hasShadow: true,
        thickFrame: isWindows,
        movable: false,
        backgroundColor: isWindows ? WindowsSplashFallbackBackgroundColor : TransparentBackgroundColor,
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
    }

    return options;
}

function supportsWindowsSplashMaterial(): boolean {
    if (!isWindows) return false;
    const [major, , build] = os.release().split('.').map(part => Number.parseInt(part, 10));
    return major === 10 && Number.isFinite(build) && build >= WindowsSystemBackdropMinimumBuild;
}

function applyPlatformSplashMaterial(win: BrowserWindow): void {
    if (isWindows) {
        if (!supportsWindowsSplashMaterial()) {
            try { win.setBackgroundMaterial('none'); } catch { /* unsupported Windows build */ }
            win.setBackgroundColor(WindowsSplashFallbackBackgroundColor);
        } else {
            try {
                // Electron makes both the BrowserWindow and WebContents backgrounds
                // transparent when a system backdrop material is applied.
                win.setBackgroundMaterial(WindowsSplashMaterial);
            } catch {
                try { win.setBackgroundMaterial('none'); } catch { /* unsupported Windows build */ }
                win.setBackgroundColor(WindowsSplashFallbackBackgroundColor);
            }
        }
    }

    if (process.platform !== 'darwin') {
        const shadowWindow = win as BrowserWindow & { setHasShadow?: (hasShadow: boolean) => void };
        shadowWindow.setHasShadow?.(true);
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

    const showAfterRendererFailure = (): void => {
        if (didShow || win.isDestroyed()) return;
        didShow = true;
        win.show();
        resolveRendererReady?.();
        resolveRendererReady = undefined;
    };

    const rendererReadyHandler = (event: IpcMainEvent): void => {
        if (event.sender !== win.webContents) return;
        showAfterRendererLayout();
        resolveRendererReady?.();
        resolveRendererReady = undefined;
    };

    applyPlatformSplashMaterial(win);
    win.setMenuBarVisibility(false);
    win.on('show', () => applyPlatformSplashMaterial(win));
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        console.error(`[splash] failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
        showAfterRendererFailure();
    });
    win.webContents.on('render-process-gone', (_event, details) => {
        console.error(`[splash] render process gone: ${details.reason}`);
        showAfterRendererFailure();
    });
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
        console.error(`[splash] preload failed ${preloadPath}: ${error.message}`);
        showAfterRendererFailure();
    });
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

    const pending = pendingSplashStages.get(win);
    if (pending) {
        pending.stage = stage;
        return;
    }

    const entry = {
        stage,
        timer: setTimeout(() => {
            pendingSplashStages.delete(win);
            if (!win.isDestroyed()) win.webContents.send('launch-stage', entry.stage);
        }, 16)
    };
    pendingSplashStages.set(win, entry);
}

export function updateSplashDownloadPaused(win: BrowserWindow | null | undefined, paused: boolean): void {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('launch-download-paused', paused);
}
