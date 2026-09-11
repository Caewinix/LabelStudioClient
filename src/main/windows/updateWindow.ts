import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, screen, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron';
import {
    RuntimeBootstrapService,
    BootstrapMode,
    ManagedRuntimeMutationCancelledError,
    type ManagedRuntimeMutationKind,
} from '../services/runtimeBootstrapService';
import { LaunchStage, UpdatePreferenceKey } from '../services/launchModels';
import { resolveAppIconPath } from '../utils/appIcon';
import { initialWindowFrame, rememberWindowFrame } from '../utils/windowFrameStore';
import {
    WindowsAdministratorPermissionCancelledError,
} from '../utils/runtimeElevation';

interface UpdateState {
    appVersion: string;
    electronVersion: string;
    packageVersion: string;
    pythonVersion: string;
}

type RuntimeButton = 'electron' | 'package' | 'python';

const RuntimeUpdateProgressSteps = [
    'runtimeBootstrap',
    'readVersions',
    'publishVersions',
] as const;

type RuntimeUpdateProgressStep = typeof RuntimeUpdateProgressSteps[number];

function runtimeUpdateStepIndex(step: RuntimeUpdateProgressStep): number {
    return RuntimeUpdateProgressSteps.indexOf(step);
}

function runtimeUpdateStepStart(step: RuntimeUpdateProgressStep): number {
    return runtimeUpdateStepIndex(step) / RuntimeUpdateProgressSteps.length;
}

function runtimeUpdateStepEnd(step: RuntimeUpdateProgressStep): number {
    return (runtimeUpdateStepIndex(step) + 1) / RuntimeUpdateProgressSteps.length;
}

export class UpdateWindowController {
    private win?: BrowserWindow;
    private activeBusyButton?: RuntimeButton;
    private currentDownloadStatus?: string;
    private isDownloadPaused = false;
    private pendingBusyPayload?: unknown;
    private pendingBusyTimer?: NodeJS.Timeout;

    constructor(
        private readonly runtimeBootstrapService: RuntimeBootstrapService,
        private readonly configureWindow?: (win: BrowserWindow) => void,
        private readonly shouldRestartMainRuntime?: () => boolean,
        private readonly restartMainRuntime?: () => Promise<boolean>,
        private readonly prepareMainRuntimeForReplacement?: () => Promise<void>,
        private readonly configureLaunchRuntimeBootstrapProgress?: (mode: BootstrapMode, targetPackageVersion?: string) => Promise<void>,
    ) {
        this.bindIpc();
    }

    presentWindow(): void {
        if (this.win && !this.win.isDestroyed()) {
            this.win.show();
            this.win.focus();
            void this.loadVersions();
            return;
        }

        const updatePreloadPath = path.join(__dirname, '../../preload/updatePreload.js');
        console.log('[updates] update preload path:', updatePreloadPath, 'exists =', fs.existsSync(updatePreloadPath));
        const initialFrame = initialWindowFrame({
            id: 'updates',
            display: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
            defaultWidth: 960,
            defaultHeight: 620,
            minWidth: 560,
            minHeight: 360
        });

        this.win = new BrowserWindow({
            ...initialFrame,
            minWidth: 560,
            minHeight: 360,
            title: 'Check for Updates',
            show: false,
            resizable: true,
            autoHideMenuBar: process.platform !== 'darwin',
            backgroundColor: '#151515',
            icon: resolveAppIconPath(),
            webPreferences: {
                preload: updatePreloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false
            }
        });
        this.configureWindow?.(this.win);
        if (process.platform !== 'darwin') {
            this.hideNativeMenuBar();
        }
        rememberWindowFrame(this.win, 'updates');
        this.win.once('ready-to-show', () => {
            this.hideNativeMenuBar();
            this.win?.show();
            void this.loadVersions();
        });
        this.win.on('show', () => this.hideNativeMenuBar());
        this.win.on('focus', () => this.hideNativeMenuBar());
        this.win.webContents.once('did-finish-load', () => {
            this.hideNativeMenuBar();
            void this.loadVersions();
        });
        this.win.webContents.on('console-message', (_event, _level, message) => {
            console.log(`[updates-renderer] ${message}`);
        });
        this.win.on('closed', () => {
            this.clearPendingBusy();
            this.win = undefined;
        });
        void this.win.loadFile(path.join(__dirname, '../../renderer/update/index.html'));
    }

    private hideNativeMenuBar(): void {
        if (process.platform === 'darwin' || !this.win || this.win.isDestroyed()) return;
        this.win.setAutoHideMenuBar(true);
        this.win.setMenuBarVisibility(false);
        this.win.setMenu(null);
        this.win.removeMenu();
    }

    private async showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
        const parent = this.win && !this.win.isDestroyed() ? this.win : undefined;
        const dialogOptions: MessageBoxOptions = { noLink: true, ...options };
        return parent ? dialog.showMessageBox(parent, dialogOptions) : dialog.showMessageBox(dialogOptions);
    }

    async performAutomaticChecksIfNeeded(): Promise<void> {
        const state = await this.readPreferenceState();
        if (!state.autoCheckElectron && !state.autoCheckPackage && !state.autoCheckPython) return;

        if (state.autoCheckElectron) {
            try {
                const result = await this.runtimeBootstrapService.checkElectron();
                this.send('electron-version', result.currentElectronVersion);
                if (result.updateAvailable && await this.promptToUpdateElectron(result, 'launch')) {
                    await this.performElectronUpdate();
                    if (this.runtimeBootstrapService.wasLastRuntimeOperationSkipped()) return;
                }
            } catch {
                this.setBusy(false, '');
                return;
            }
        }

        if (state.autoCheckPython) {
            try {
                const result = await this.runtimeBootstrapService.checkPython();
                this.send('python-version', result.currentPythonVersion);
                if (result.updateAvailable && await this.promptToUpdatePython(result, 'launch')) {
                    await this.performPythonUpdate();
                    if (this.runtimeBootstrapService.wasLastRuntimeOperationSkipped()) return;
                }
            } catch {
                this.setBusy(false, '');
                return;
            }
        }

        if (state.autoCheckPackage) {
            try {
                const result = await this.runtimeBootstrapService.checkPackage();
                this.send('package-version', result.currentPackageVersion);
                if (result.updateAvailable) {
                    if (await this.promptToUpdatePackage(result, 'launch')) {
                        await this.performPackageUpdate(undefined, result.latestPackageVersion);
                        if (this.runtimeBootstrapService.wasLastRuntimeOperationSkipped()) return;
                    }
                }
            } catch {
                this.setBusy(false, '');
            }
        }

        if (this.win && !this.win.isDestroyed()) await this.loadVersions();
    }

    private bindIpc(): void {
        console.log('[updates] bindIpc registered');
        ipcMain.handle('updates:get-state', async () => {
            console.log('[updates] get-state requested');
            try {
                const state = await this.fetchWindowState();
                console.log('[updates] get-state resolved:', {
                    appVersion: state.appVersion,
                    electronVersion: state.electronVersion,
                    packageVersion: state.packageVersion,
                    pythonVersion: state.pythonVersion
                });
                return state;
            } catch (error) {
                console.error('[updates] get-state failed:', error);
                throw error;
            }
        });
        ipcMain.handle('updates:check-electron', async () => await this.checkElectron());
        ipcMain.handle('updates:check-package', async () => await this.checkPackage());
        ipcMain.handle('updates:check-python', async () => await this.checkPython());
        ipcMain.handle('updates:set-preference', async (_event, key: string, value: boolean) => {
            globalThis.sharedStore?.set(key, value);
            return true;
        });
        ipcMain.on('updates:set-paused', (_event, paused: boolean) => {
            const requestedPaused = Boolean(paused);
            const actualPaused = this.runtimeBootstrapService.setCurrentDownloadPaused(requestedPaused);
            this.setDownloadPaused(actualPaused);
        });
        ipcMain.handle('updates:toggle-pause', () => {
            const paused = this.runtimeBootstrapService.toggleCurrentDownloadPause();
            this.setDownloadPaused(paused);
            return paused;
        });
        ipcMain.handle('updates:cancel-download', async () => await this.cancelUpdateDownload());
    }

    private async cancelUpdateDownload(): Promise<boolean> {
        const localPaused = this.runtimeBootstrapService.pauseCurrentDownload();
        if (localPaused) this.setDownloadPaused(true);

        try {
            const result = await this.showMessageBox({
                type: 'warning',
                message: 'Cancel Download?',
                detail: 'The current download is paused. Choose Continue Download to resume it, or Cancel Download to stop the current update.',
                buttons: ['Continue Download', 'Cancel Download'],
                defaultId: 0,
                cancelId: 1
            });

            if (result.response === 1) {
                this.runtimeBootstrapService.cancelCurrentDownloadAndSkip();
                this.setDownloadPaused(false);
                return true;
            }

            this.runtimeBootstrapService.resumeCurrentDownload();
            this.setDownloadPaused(false);
            return false;
        } catch (error) {
            this.runtimeBootstrapService.resumeCurrentDownload();
            this.setDownloadPaused(false);
            throw error;
        }
    }

    private async fetchWindowState(): Promise<UpdateState & Record<string, unknown>> {
        const versions = this.runtimeBootstrapService.versionSnapshot();
        const prefs = await this.readPreferenceState();
        return {
            appVersion: this.runtimeBootstrapService.appVersionString(),
            electronVersion: versions.electronVersion,
            packageVersion: versions.packageVersion,
            pythonVersion: versions.pythonVersion,
            ...prefs
        };
    }

    private async hasUsableEmbeddedRuntimeAndPackage(): Promise<boolean> {
        try {
            const versions = await this.runtimeBootstrapService.fetchVersions();
            const hasPackage = Boolean(versions.packageVersion)
                && versions.packageVersion !== 'Not installed'
                && versions.packageVersion !== 'Unknown';
            const hasPython = Boolean(versions.pythonVersion)
                && versions.pythonVersion !== 'Not installed'
                && versions.pythonVersion !== 'Unknown';
            return hasPackage && hasPython && this.runtimeBootstrapService.hasUsableElectronRuntime();
        } catch {
            return false;
        }
    }

    private async readPreferenceState(): Promise<{ autoCheckElectron: boolean; autoCheckPackage: boolean; autoCheckPython: boolean }> {
        const prefs = globalThis.sharedStore;
        return {
            autoCheckElectron: Boolean(prefs?.get(UpdatePreferenceKey.autoCheckElectron)),
            autoCheckPackage: prefs?.get(UpdatePreferenceKey.autoCheckPackage) !== false,
            autoCheckPython: Boolean(prefs?.get(UpdatePreferenceKey.autoCheckPython))
        };
    }

    private async loadVersions(): Promise<void> {
        if (this.activeBusyButton) return;
        try {
            const snapshot = await this.fetchWindowState();
            console.log('[updates] sending version snapshot:', {
                appVersion: snapshot.appVersion,
                electronVersion: snapshot.electronVersion,
                packageVersion: snapshot.packageVersion,
                pythonVersion: snapshot.pythonVersion
            });
            this.publishState(snapshot);
            if (!this.activeBusyButton) this.setBusy(false, 'Ready.');

            this.runtimeBootstrapService.primeVersionCache();
            void this.runtimeBootstrapService.fetchVersions()
                .then(async versions => {
                    const state = {
                        appVersion: this.runtimeBootstrapService.appVersionString(),
                        electronVersion: versions.electronVersion,
                        packageVersion: versions.packageVersion,
                        pythonVersion: versions.pythonVersion,
                        ...(await this.readPreferenceState())
                    };
                    console.log('[updates] sending refreshed versions:', versions);
                    this.publishState(state);
                    if (!this.activeBusyButton) this.setBusy(false, 'Ready.');
                })
                .catch(error => {
                    if (!this.activeBusyButton) {
                        this.setBusy(false, `Failed to read runtime versions: ${this.shortErrorDescription(error)}`);
                    }
                });
        } catch (error) {
            if (!this.activeBusyButton) {
                this.setBusy(false, `Failed to read runtime versions: ${this.shortErrorDescription(error)}`);
            }
        }
    }

    private async checkElectron(): Promise<void> {
        console.log('[updates] checkElectron invoked');
        this.setBusy(true, 'Checking Electron…', undefined, 'electron');
        try {
            const result = await this.runtimeBootstrapService.checkElectron();
            this.send('electron-version', result.currentElectronVersion);
            this.setBusy(false, '');
            if (result.updateAvailable) {
                if (await this.promptToUpdateElectron(result, 'manual')) await this.performElectronUpdate('electron');
            } else {
                await this.presentElectronCheckNotice(result);
            }
        } catch (error) {
            this.setBusy(false, '');
            await this.showMessageBox({ type: 'error', message: 'Electron Check Failed', detail: this.shortErrorDescription(error) });
        }
    }

    private async checkPackage(): Promise<void> {
        console.log('[updates] checkPackage invoked');
        this.setBusy(true, 'Checking Label Studio package…', undefined, 'package');
        try {
            const result = await this.runtimeBootstrapService.checkPackage();
            this.send('package-version', result.currentPackageVersion);
            this.setBusy(false, '');
            if (result.updateAvailable) {
                if (await this.promptToUpdatePackage(result, 'manual')) {
                    await this.performPackageUpdate('package', result.latestPackageVersion);
                }
            } else {
                await this.presentPackageCheckNotice(result);
            }
        } catch (error) {
            if (this.shouldPromptToRepairRuntime(error)) {
                if (!(await this.promptToRepairRuntime(error))) {
                    this.setBusy(false, '');
                    return;
                }
                try {
                    await this.performRuntimeProvisioning('package');
                } catch (repairError) {
                    this.setBusy(false, '');
                    await this.showMessageBox({
                        type: 'error',
                        message: 'Runtime Repair Failed',
                        detail: this.shortErrorDescription(repairError)
                    });
                }
            } else {
                this.setBusy(false, '');
                await this.showMessageBox({
                    type: 'error',
                    message: 'Label Studio Package Check Failed',
                    detail: this.shortErrorDescription(error)
                });
            }
        }
    }

    private async checkPython(): Promise<void> {
        console.log('[updates] checkPython invoked');
        this.setBusy(true, 'Checking Python…', undefined, 'python');
        try {
            const result = await this.runtimeBootstrapService.checkPython();
            this.send('python-version', result.currentPythonVersion);
            this.setBusy(false, '');
            if (result.updateAvailable) {
                if (await this.promptToUpdatePython(result, 'manual')) await this.performPythonUpdate('python');
            } else {
                await this.presentPythonCheckNotice(result);
            }
        } catch (error) {
            if (this.shouldPromptToRepairRuntime(error)) {
                if (!(await this.promptToRepairRuntime(error))) {
                    this.setBusy(false, '');
                    return;
                }
                try {
                    await this.performRuntimeProvisioning('python');
                } catch (repairError) {
                    this.setBusy(false, '');
                    await this.showMessageBox({
                        type: 'error',
                        message: 'Runtime Repair Failed',
                        detail: this.shortErrorDescription(repairError)
                    });
                }
            } else {
                this.setBusy(false, '');
                await this.showMessageBox({
                    type: 'error',
                    message: 'Python Check Failed',
                    detail: this.shortErrorDescription(error)
                });
            }
        }
    }

    private async promptToUpdateElectron(result: Awaited<ReturnType<RuntimeBootstrapService['checkElectron']>>, _source: string): Promise<boolean> {
        const response = await this.showMessageBox({
            message: 'Update Electron?',
            detail: `Current: ${result.currentElectronVersion}\nLatest: ${result.latestElectronVersion}\nPlatform: ${result.platform}`,
            buttons: ['Update', 'Not Now'], defaultId: 0, cancelId: 1
        });
        return response.response === 0;
    }

    private async promptToUpdatePackage(result: Awaited<ReturnType<RuntimeBootstrapService['checkPackage']>>, _source: string): Promise<boolean> {
        const response = await this.showMessageBox({
            message: 'Update Label Studio?',
            detail: result.pythonSatisfiesLatestPackage
                ? `Current: ${result.currentPackageVersion}\nLatest: ${result.latestPackageVersion}\n\nInstall now?`
                : `Current: ${result.currentPackageVersion}\nLatest: ${result.latestPackageVersion}\nRequires Python: ${result.requiresPython}\nPython will be updated first.`,
            buttons: ['Update', 'Not Now'], defaultId: 0, cancelId: 1
        });
        return response.response === 0;
    }

    private async promptToUpdatePython(result: Awaited<ReturnType<RuntimeBootstrapService['checkPython']>>, _source: string): Promise<boolean> {
        const response = await this.showMessageBox({
            message: 'Update Python?',
            detail: `Current: ${result.currentPythonVersion}\nLatest: ${result.latestInstallerVersion}`,
            buttons: ['Update', 'Not Now'], defaultId: 0, cancelId: 1
        });
        return response.response === 0;
    }

    private async promptToRepairRuntime(error: unknown): Promise<boolean> {
        if (!this.shouldPromptToRepairRuntime(error)) return false;
        const response = await this.showMessageBox({
            type: 'warning',
            message: 'Runtime Missing',
            detail: 'Download the embedded Python runtime, Label Studio package, and Electron runtime?',
            buttons: ['Download', 'Not Now'], defaultId: 0, cancelId: 1
        });
        return response.response === 0;
    }

    private shouldPromptToRepairRuntime(error: unknown): boolean {
        const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
        return text.includes('Embedded Python runtime is missing') || text.includes('Missing runtime') || text.includes('PythonCore') || text.includes('/bin/Python') || text.includes('ENOENT');
    }

    private async presentElectronCheckNotice(result: Awaited<ReturnType<RuntimeBootstrapService['checkElectron']>>): Promise<void> {
        await this.showMessageBox({ message: 'Electron is Up To Date', detail: `Current: ${result.currentElectronVersion}\nLatest: ${result.latestElectronVersion}` });
    }

    private async presentPackageCheckNotice(result: Awaited<ReturnType<RuntimeBootstrapService['checkPackage']>>): Promise<void> {
        await this.showMessageBox({ message: 'Label Studio is Up To Date', detail: `Current: ${result.currentPackageVersion}\nLatest: ${result.latestPackageVersion}` });
    }

    private async presentPythonCheckNotice(result: Awaited<ReturnType<RuntimeBootstrapService['checkPython']>>): Promise<void> {
        await this.showMessageBox({
            message: 'Python is On The Latest Installer',
            detail: `Current: ${result.currentPythonVersion}\nLatest: ${result.latestInstallerVersion}`
        });
    }

    private async performElectronUpdate(activeButton?: 'electron'): Promise<void> {
        try {
            const wasPackagedApp = app.isPackaged;
            const versions = await this.runRuntimeBootstrap(BootstrapMode.updateElectron, 'Updating Electron', activeButton, undefined, undefined, false);
            if (this.runtimeBootstrapService.wasLastRuntimeOperationSkipped()) {
                this.setBusy(false, '');
                return;
            }
            this.setBusy(false, '');
            if (wasPackagedApp) {
                const pendingReplacement = this.runtimeBootstrapService.hasPendingElectronRuntimeReplacement();
                if (process.platform === 'win32') {
                    this.runtimeBootstrapService.recordElectronUpdateDiagnostic(
                        `Showing Electron update confirmation. pendingReplacement=${pendingReplacement}`
                    );
                }
                await this.showMessageBox({
                    message: pendingReplacement ? 'Electron Update Ready' : 'Electron Updated',
                    detail: pendingReplacement
                        ? 'The new Electron runtime is ready. Label Studio will quit now. A background installer will finish replacing Electron files and automatically reopen Label Studio when the update is complete. If Label Studio is opened before the update finishes, it will close itself until the installer is done.'
                        : 'The Electron runtime files were replaced. Quit Label Studio now, then open it again to use the new Electron version.',
                    buttons: [pendingReplacement ? 'Quit And Install' : 'Quit'],
                    defaultId: 0,
                    cancelId: 0
                });
                if (process.platform === 'win32') {
                    this.runtimeBootstrapService.recordElectronUpdateDiagnostic('Quit And Install confirmation returned to the update controller.');
                }
                if (pendingReplacement && process.platform === 'win32') {
                    this.runtimeBootstrapService.recordElectronUpdateDiagnostic('Waiting for the independent Windows installer to become ready.');
                    await this.runtimeBootstrapService.startPendingElectronRuntimeReplacementInstaller();
                    this.runtimeBootstrapService.recordElectronUpdateDiagnostic('Independent Windows installer is ready; proceeding to app.quit().');
                }
                this.send('electron-version', versions.electronVersion);
                const exitFallback = setTimeout(() => {
                    if (process.platform === 'win32') {
                        this.runtimeBootstrapService.recordElectronUpdateDiagnostic('Graceful quit did not finish within 1200 ms; forcing app.exit(0).');
                    }
                    app.exit(0);
                }, 1200);
                exitFallback.unref?.();
                if (process.platform === 'win32') {
                    this.runtimeBootstrapService.recordElectronUpdateDiagnostic('Calling app.quit().');
                }
                app.quit();
                if (process.platform === 'win32') {
                    this.runtimeBootstrapService.recordElectronUpdateDiagnostic('app.quit() returned to the update controller.');
                    this.runtimeBootstrapService.recordElectronUpdateDiagnostic('Forcing the current Windows Electron process to terminate after synchronous quit cleanup.');
                    app.exit(0);
                }
                return;
            }
            await this.showMessageBox({ message: 'Electron Version', detail: versions.electronVersion });
            this.send('electron-version', versions.electronVersion);
        } catch (error) {
            this.setBusy(false, '');
            if (process.platform === 'win32') {
                this.runtimeBootstrapService.recordElectronUpdateDiagnostic(
                    `Electron update controller failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
                );
            }
            const diagnosticLog = process.platform === 'win32'
                ? `\n\nDiagnostic log:\n${this.runtimeBootstrapService.electronUpdateDiagnosticLogPath()}`
                : '';
            await this.showMessageBox({
                type: 'error',
                message: 'Electron Update Failed',
                detail: `Electron could not be updated.\n\n${this.shortErrorDescription(error)}${diagnosticLog}`
            });
        }
    }

    private async performPackageUpdate(activeButton?: 'package', targetPackageVersion?: string): Promise<void> {
        let versions: Awaited<ReturnType<RuntimeBootstrapService['refreshVersionCache']>> | undefined;
        let mainRuntimeStopped = false;
        try {
            versions = await this.runRuntimeBootstrap(
                BootstrapMode.updatePackage,
                'Updating Label Studio',
                activeButton,
                targetPackageVersion,
                async () => {
                    if (mainRuntimeStopped || !this.shouldRestartMainRuntime?.()) return;
                    const confirmation = await this.showMessageBox({
                        type: 'info',
                        message: 'Label Studio Service Restart Required',
                        detail: 'All package downloads are complete. Label Studio must now stop the local service and Python runtime before installing the prepared package files. The service will reopen when installation is complete.',
                        buttons: ['Continue', 'Cancel'],
                        defaultId: 0,
                        cancelId: 1
                    });
                    if (confirmation.response !== 0) throw new ManagedRuntimeMutationCancelledError();
                    if (!this.prepareMainRuntimeForReplacement) {
                        throw new Error('The running Python service cannot be stopped for the required package installation.');
                    }
                    this.setBusy(true, 'Stopping Label Studio service', runtimeUpdateStepStart('runtimeBootstrap'), activeButton, false, false, true);
                    mainRuntimeStopped = true;
                    await this.prepareMainRuntimeForReplacement();
                },
                false,
            );
            if (this.runtimeBootstrapService.wasLastRuntimeOperationSkipped()) {
                this.setBusy(false, '');
                return;
            }
        } catch (error) {
            if (mainRuntimeStopped) {
                try { await this.recoverMainRuntimeAfterFailedUpdate(activeButton); } catch { /* report the update error below */ }
            } else if (this.runtimeBootstrapService.hasPendingRuntimeReplacement()) {
                try { await this.runtimeBootstrapService.rollbackPendingRuntimeReplacement(); } catch { /* report the update error below */ }
            }
            this.setBusy(false, '');
            if (error instanceof ManagedRuntimeMutationCancelledError) return;
            if (error instanceof WindowsAdministratorPermissionCancelledError) {
                await this.showMessageBox({
                    type: 'info',
                    message: 'Administrator Permission Not Granted',
                    detail: error.message
                });
                return;
            }
            await this.showMessageBox({
                type: 'error',
                message: 'Package Update Failed',
                detail: this.runtimeCompatibilityMessage(error)
                    ?? this.runtimeOptimizationMessage(error)
                    ?? `Label Studio could not be updated.\n\n${this.shortErrorDescription(error)}`
            });
            return;
        }

        this.setBusy(false, '');

        if (!mainRuntimeStopped) {
            this.send('package-version', versions.packageVersion);
            await this.showMessageBox({ message: 'Label Studio Version', detail: versions.packageVersion });
            return;
        }

        try {
            await this.validateUpdatedMainRuntime(activeButton);
            this.send('package-version', versions.packageVersion);
            this.setBusy(false, '');
            await this.showMessageBox({
                type: 'info',
                message: 'Label Studio Updated',
                detail: `Label Studio was updated to ${versions.packageVersion}. The local service and interface reopened successfully.`,
                buttons: ['OK'],
                defaultId: 0,
                cancelId: 0
            });
        } catch (error) {
            let recoveryError: unknown;
            try {
                await this.recoverMainRuntimeAfterFailedUpdate(activeButton);
            } catch (caughtRecoveryError) {
                recoveryError = caughtRecoveryError;
            }
            this.setBusy(false, '');
            await this.showMessageBox({
                type: 'error',
                message: 'Service Restart Failed',
                detail: recoveryError
                    ? `The updated Label Studio runtime could not be opened, and the previous runtime could not be restored and reopened.\n\nUpdate failure:\n${this.shortErrorDescription(error)}\n\nRecovery failure:\n${this.shortErrorDescription(recoveryError)}`
                    : `The updated Label Studio runtime could not be opened, so the previous runtime was restored and reopened.\n\n${this.shortErrorDescription(error)}`
            });
        }
    }

    private async restartMainRuntimeAfterPackageUpdate(activeButton?: RuntimeButton): Promise<boolean> {
        if (!this.restartMainRuntime) return false;
        this.setBusy(true, 'Restarting Label Studio service', runtimeUpdateStepEnd('publishVersions'), activeButton, false, false, true);
        return await this.restartMainRuntime();
    }

    private async validateUpdatedMainRuntime(activeButton?: RuntimeButton): Promise<void> {
        const restarted = await this.restartMainRuntimeAfterPackageUpdate(activeButton);
        if (!restarted) throw new Error('The updated local service or main interface did not reopen successfully.');
        await this.runtimeBootstrapService.commitPendingRuntimeReplacement();
    }

    private async recoverMainRuntimeAfterFailedUpdate(activeButton?: RuntimeButton): Promise<void> {
        if (this.runtimeBootstrapService.hasPendingRuntimeReplacement()) {
            if (this.prepareMainRuntimeForReplacement) {
                try { await this.prepareMainRuntimeForReplacement(); } catch { /* Continue with rollback after best-effort shutdown. */ }
            }
            await this.runtimeBootstrapService.rollbackPendingRuntimeReplacement();
        }
        const restarted = await this.restartMainRuntimeAfterPackageUpdate(activeButton);
        if (!restarted) throw new Error('The previous local service or main interface could not be reopened after rollback.');
    }

    private async performPythonUpdate(activeButton?: 'python'): Promise<void> {
        let mainRuntimeStopped = false;
        try {
            const versions = await this.runRuntimeBootstrap(
                BootstrapMode.updatePython,
                'Updating Python',
                activeButton,
                undefined,
                async () => {
                    if (mainRuntimeStopped || !this.shouldRestartMainRuntime?.()) return;
                    const confirmation = await this.showMessageBox({
                        type: 'info',
                        message: 'Python Runtime Restart Required',
                        detail: 'All Python runtime and required package downloads are complete. Label Studio must now stop the local service before installing the prepared runtime. The service will reopen when installation is complete.',
                        buttons: ['Continue', 'Cancel'],
                        defaultId: 0,
                        cancelId: 1
                    });
                    if (confirmation.response !== 0) throw new ManagedRuntimeMutationCancelledError();
                    if (!this.prepareMainRuntimeForReplacement) {
                        throw new Error('The running Python service cannot be stopped for the required runtime replacement.');
                    }
                    this.setBusy(true, 'Stopping Label Studio service', runtimeUpdateStepStart('runtimeBootstrap'), activeButton, false, false, true);
                    mainRuntimeStopped = true;
                    await this.prepareMainRuntimeForReplacement();
                },
                false,
            );
            if (this.runtimeBootstrapService.wasLastRuntimeOperationSkipped()) {
                this.setBusy(false, '');
                return;
            }
            this.setBusy(false, '');
            if (!mainRuntimeStopped) {
                this.send('python-version', versions.pythonVersion);
                await this.showMessageBox({ message: 'Python Version', detail: versions.pythonVersion });
                return;
            }

            await this.validateUpdatedMainRuntime(activeButton);
            this.send('python-version', versions.pythonVersion);
            this.setBusy(false, '');
            await this.showMessageBox({
                type: 'info',
                message: 'Python Updated',
                detail: `The managed Python runtime was updated to ${versions.pythonVersion}. The local service and interface reopened successfully.`,
                buttons: ['OK'],
                defaultId: 0,
                cancelId: 0
            });
        } catch (error) {
            let recoveryError: unknown;
            if (mainRuntimeStopped) {
                try {
                    await this.recoverMainRuntimeAfterFailedUpdate(activeButton);
                } catch (caughtRecoveryError) {
                    recoveryError = caughtRecoveryError;
                }
            } else if (this.runtimeBootstrapService.hasPendingRuntimeReplacement()) {
                try {
                    await this.runtimeBootstrapService.rollbackPendingRuntimeReplacement();
                } catch (caughtRecoveryError) {
                    recoveryError = caughtRecoveryError;
                }
            }
            this.setBusy(false, '');
            if (error instanceof ManagedRuntimeMutationCancelledError) return;
            if (error instanceof WindowsAdministratorPermissionCancelledError) {
                await this.showMessageBox({
                    type: 'info',
                    message: 'Administrator Permission Not Granted',
                    detail: error.message
                });
                return;
            }
            await this.showMessageBox({
                type: 'error',
                message: 'Python Update Failed',
                detail: recoveryError
                    ? `Python could not be updated, and the previous runtime could not be restored and reopened.\n\nUpdate failure:\n${this.shortErrorDescription(error)}\n\nRecovery failure:\n${this.shortErrorDescription(recoveryError)}`
                    : this.runtimeCompatibilityMessage(error)
                        ?? this.runtimeOptimizationMessage(error)
                        ?? `Python could not be updated.\n\n${this.shortErrorDescription(error)}`
            });
        }
    }

    private async performRuntimeProvisioning(activeButton?: RuntimeButton): Promise<void> {
        await this.runRuntimeBootstrap(BootstrapMode.ensurePackage, 'Preparing runtime', activeButton);
        this.setBusy(false, '');
    }

    private async runRuntimeBootstrap(
        mode: BootstrapMode,
        initialStatus: string,
        activeButton?: RuntimeButton,
        targetPackageVersion?: string,
        beforeManagedRuntimeMutation?: (kind: ManagedRuntimeMutationKind) => Promise<void>,
        publishVersionState = true,
    ) {
        await this.configureLaunchRuntimeBootstrapProgress?.(mode, targetPackageVersion);
        this.setBusy(true, initialStatus, 0, activeButton);
        await this.runtimeBootstrapService.waitForRuntimeReadersToSettle();
        const previousTransientStageUpdate = this.runtimeBootstrapService.transientStageUpdate;
        const previousBeforeManagedRuntimeMutation = this.runtimeBootstrapService.beforeManagedRuntimeMutation;
        const updateWindowStageHandler = (stage: LaunchStage): void => this.applyRuntimeBootstrapStage(stage);
        this.runtimeBootstrapService.transientStageUpdate = updateWindowStageHandler;
        this.runtimeBootstrapService.beforeManagedRuntimeMutation = beforeManagedRuntimeMutation;
        try {
            await this.ensureRuntimeBootstrapWithMirrorFallback(mode, targetPackageVersion);
        } finally {
            if (this.runtimeBootstrapService.transientStageUpdate === updateWindowStageHandler || this.runtimeBootstrapService.transientStageUpdate === undefined) {
                this.runtimeBootstrapService.transientStageUpdate = previousTransientStageUpdate;
            }
            if (this.runtimeBootstrapService.beforeManagedRuntimeMutation === beforeManagedRuntimeMutation) {
                this.runtimeBootstrapService.beforeManagedRuntimeMutation = previousBeforeManagedRuntimeMutation;
            }
        }
        if (this.runtimeBootstrapService.wasLastRuntimeOperationSkipped()) {
            return this.runtimeBootstrapService.versionSnapshot();
        }
        this.setBusy(true, 'Reading runtime versions', runtimeUpdateStepStart('readVersions'), activeButton);
        const versions = await this.runtimeBootstrapService.refreshVersionCache();
        if (publishVersionState) {
            this.send('state', {
                appVersion: this.runtimeBootstrapService.appVersionString(),
                electronVersion: versions.electronVersion,
                packageVersion: versions.packageVersion,
                pythonVersion: versions.pythonVersion,
                ...(await this.readPreferenceState())
            });
        } else {
            this.runtimeBootstrapService.invalidateVersionCache();
        }
        this.setBusy(true, 'Runtime versions ready', runtimeUpdateStepEnd('publishVersions'), activeButton);
        return versions;
    }

    private async ensureRuntimeBootstrapWithMirrorFallback(mode: BootstrapMode, targetPackageVersion?: string): Promise<void> {
        const progressRange: [number, number] = [
            runtimeUpdateStepStart('runtimeBootstrap'),
            runtimeUpdateStepEnd('runtimeBootstrap')
        ];
        try {
            await this.runtimeBootstrapService.ensureRuntime(mode, progressRange, targetPackageVersion);
        } catch (error) {
            if (!this.usesPyPISources(mode) || !this.runtimeBootstrapService.shouldRetryPyPIWithMirrorAfterFailure(error)) {
                throw error;
            }

            this.runtimeBootstrapService.forcePreferTunaPyPI('Retrying runtime bootstrap with the TUNA PyPI mirror after a primary network failure.');
            await this.runtimeBootstrapService.ensureRuntime(mode, progressRange, targetPackageVersion);
        }
    }

    private usesPyPISources(mode: BootstrapMode): boolean {
        return mode === BootstrapMode.ensurePackage
            || mode === BootstrapMode.updatePackage
            || mode === BootstrapMode.updatePython
            || mode === BootstrapMode.updateAll
            || mode === BootstrapMode.ensureAll;
    }

    private applyRuntimeBootstrapStage(stage: LaunchStage): void {
        const showsDownloadProgress = stage.showsDownloadProgress
            || stage.downloadProgress !== undefined
            || stage.downloadStatus !== undefined;
        if (!showsDownloadProgress && this.isDownloadPaused) this.setDownloadPaused(false);
        const showsDownloadControls = showsDownloadProgress;
        const visibleProgress = showsDownloadProgress
            ? stage.downloadProgress ?? stage.progress
            : stage.progress;
        const rawStatus = showsDownloadProgress ? (stage.downloadStatus ?? stage.title) : stage.title;
        this.currentDownloadStatus = showsDownloadProgress ? rawStatus : undefined;
        const status = showsDownloadProgress ? this.displayDownloadStatus(rawStatus) : rawStatus;
        this.setBusy(true, status, visibleProgress, this.activeBusyButton, showsDownloadControls, showsDownloadProgress, !showsDownloadProgress);
    }

    private displayDownloadStatus(status: string | undefined): string {
        const safeStatus = status ?? 'Preparing download';
        if (!this.isDownloadPaused) return safeStatus;
        const sizePart = safeStatus.split('    ')[0]?.trim();
        if (sizePart && sizePart.includes('/')) return `${sizePart}    Paused`;
        return 'Paused';
    }

    private refreshDownloadStatusLabel(): void {
        if (!this.currentDownloadStatus) return;
        this.send('download-status', this.displayDownloadStatus(this.currentDownloadStatus));
    }

    private setDownloadPaused(paused: boolean): void {
        this.isDownloadPaused = paused;
        if (paused) this.clearPendingBusy();
        this.send('download-paused', paused);
        this.refreshDownloadStatusLabel();
    }

    private setBusy(
        busy: boolean,
        status: string,
        progress?: number,
        activeButton?: RuntimeButton,
        showsDownloadControls = false,
        showsDownloadProgress = showsDownloadControls,
        showsInlineActivity = false
    ): void {
        if (activeButton) this.activeBusyButton = activeButton;
        if (progress == null || (!showsDownloadControls && !showsDownloadProgress)) this.currentDownloadStatus = undefined;
        const payload = { busy, status, progress, activeButton: this.activeBusyButton, showsDownloadControls, showsDownloadProgress, showsInlineActivity };
        if (busy && showsDownloadProgress) {
            this.sendCoalescedBusy(payload);
        } else {
            this.flushPendingBusy();
            this.send('busy', payload);
        }
        if (!busy) this.activeBusyButton = undefined;
    }

    private sendCoalescedBusy(payload: unknown): void {
        this.pendingBusyPayload = payload;
        if (this.pendingBusyTimer) return;
        this.pendingBusyTimer = setTimeout(() => {
            this.pendingBusyTimer = undefined;
            const pending = this.pendingBusyPayload;
            this.pendingBusyPayload = undefined;
            if (pending !== undefined) this.send('busy', pending);
        }, 16);
    }

    private flushPendingBusy(): void {
        if (!this.pendingBusyTimer) return;
        clearTimeout(this.pendingBusyTimer);
        this.pendingBusyTimer = undefined;
        const pending = this.pendingBusyPayload;
        this.pendingBusyPayload = undefined;
        if (pending !== undefined) this.send('busy', pending);
    }

    private clearPendingBusy(): void {
        if (this.pendingBusyTimer) {
            clearTimeout(this.pendingBusyTimer);
            this.pendingBusyTimer = undefined;
        }
        this.pendingBusyPayload = undefined;
    }

    private send(channel: string, payload: unknown): void {
        this.win?.webContents.send(`updates:${channel}`, payload);
    }

    private publishState(payload: UpdateState & Record<string, unknown>): void {
        this.send('state', payload);
        const serialized = JSON.stringify(payload);
        void this.win?.webContents.executeJavaScript(`
      (() => {
        const state = ${serialized};
        const setText = (id, value) => {
          const element = document.getElementById(id);
          if (element && typeof value === 'string' && value.length > 0) element.textContent = value;
        };
        const setChecked = (id, value) => {
          const element = document.getElementById(id);
          if (element && typeof value === 'boolean') element.checked = value;
        };
        setText('appVersion', state.appVersion);
        setText('electronVersion', state.electronVersion);
        setText('packageVersion', state.packageVersion);
        setText('pythonVersion', state.pythonVersion);
        setChecked('autoElectron', state.autoCheckElectron);
        setChecked('autoPackage', state.autoCheckPackage);
        setChecked('autoPython', state.autoCheckPython);
      })();
    `).catch(error => {
            console.error('[updates] failed to apply state in update document:', error);
        });
    }

    private runtimeCompatibilityMessage(error: unknown): string | undefined {
        const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
        const markers = ['ImportError', 'ModuleNotFoundError', 'AttributeError', 'cannot import name'];
        if (!markers.some(marker => text.toLowerCase().includes(marker.toLowerCase()))) return undefined;
        return 'This Python version is not compatible with the current Label Studio package yet.\n\nPlease wait for a Label Studio or dependency update.';
    }

    private runtimeOptimizationMessage(error: unknown): string | undefined {
        const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
        if (!/\bcollectstatic\b|static asset optimization failed/i.test(text)) return undefined;
        return `Python was installed, but Label Studio static asset optimization failed.\n\n${this.shortErrorDescription(error)}`;
    }

    private shortErrorDescription(error: unknown): string {
        const text = error instanceof Error ? (error.message || error.stack || String(error)) : String(error);
        const limit = 1600;
        if (text.length <= limit) return text;

        const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
        const separator = '\n\n…\n\n';
        const tailLength = Math.max(0, limit - firstLine.length - separator.length);
        return `${firstLine}${separator}${text.slice(-tailLength)}`;
    }
}
