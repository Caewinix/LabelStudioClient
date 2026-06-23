import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, screen, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron';
import { RuntimeBootstrapService, BootstrapMode } from '../services/runtimeBootstrapService';
import { LaunchStage, UpdatePreferenceKey } from '../services/launchModels';
import { resolveAppIconPath } from '../utils/appIcon';
import { initialWindowFrame, rememberWindowFrame } from '../utils/windowFrameStore';

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

  constructor(
    private readonly runtimeBootstrapService: RuntimeBootstrapService
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
      backgroundColor: '#151515',
      icon: resolveAppIconPath(),
      webPreferences: {
        preload: updatePreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    rememberWindowFrame(this.win, 'updates');
    this.win.once('ready-to-show', () => {
      this.win?.show();
      void this.loadVersions();
    });
    this.win.webContents.once('did-finish-load', () => {
      void this.loadVersions();
    });
    this.win.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[updates-renderer] ${message}`);
    });
    this.win.on('closed', () => { this.win = undefined; });
    void this.win.loadFile(path.join(__dirname, '../../renderer/update/index.html'));
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
            await this.performPackageUpdate();
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
      const actualPaused = this.runtimeBootstrapService.setCurrentDownloadPaused(Boolean(paused));
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
    if (this.runtimeBootstrapService.pauseCurrentDownload()) this.setDownloadPaused(true);

    if (await this.hasUsableEmbeddedRuntimeAndPackage()) {
      this.runtimeBootstrapService.cancelCurrentDownloadAndSkip();
      this.setDownloadPaused(false);
      return true;
    }

    const result = await this.showMessageBox({
      type: 'warning',
      message: 'Cancel Download?',
      detail: 'The embedded Python runtime, Label Studio package, and Electron runtime are not all available inside this app. If you cancel this download now, the current operation cannot continue.\n\nChoose Continue Download to return to the current download.',
      // Keep the non-destructive path as the visual and keyboard default.
      buttons: ['Cancel', 'Continue'],
      defaultId: 1,
      cancelId: 1
    });

    if (result.response === 0) {
      this.runtimeBootstrapService.cancelCurrentDownloadAndSkip();
      this.setDownloadPaused(false);
      return true;
    }

    this.runtimeBootstrapService.resumeCurrentDownload();
    this.setDownloadPaused(false);
    return false;
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
        if (await this.promptToUpdatePackage(result, 'manual')) await this.performPackageUpdate('package');
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
      const versions = await this.runRuntimeBootstrap(BootstrapMode.updateElectron, 'Updating Electron', activeButton);
      this.setBusy(false, '');
      if (wasPackagedApp) {
        const pendingReplacement = this.runtimeBootstrapService.hasPendingElectronRuntimeReplacement();
        await this.showMessageBox({
          message: pendingReplacement ? 'Electron Update Ready' : 'Electron Updated',
          detail: pendingReplacement
            ? 'The new Electron runtime is ready. Quit Label Studio now to install it, then open Label Studio again.'
            : 'The Electron runtime files were replaced. Quit Label Studio now, then open it again to use the new Electron version.',
          buttons: ['Quit'],
          defaultId: 0,
          cancelId: 0
        });
        const exitFallback = setTimeout(() => app.exit(0), 1200);
        exitFallback.unref?.();
        app.quit();
        return;
      }
      await this.showMessageBox({ message: 'Electron Version', detail: versions.electronVersion });
    } catch (error) {
      this.setBusy(false, '');
      await this.showMessageBox({ type: 'error', message: 'Electron Update Failed', detail: `Electron could not be updated.\n\n${this.shortErrorDescription(error)}` });
    }
  }

  private async performPackageUpdate(activeButton?: 'package'): Promise<void> {
    try {
      const versions = await this.runRuntimeBootstrap(BootstrapMode.updatePackage, 'Updating Label Studio', activeButton);
      this.setBusy(false, '');
      await this.showMessageBox({ message: 'Label Studio Version', detail: versions.packageVersion });
    } catch (error) {
      this.setBusy(false, '');
      await this.showMessageBox({
        type: 'error',
        message: 'Package Update Failed',
        detail: this.runtimeCompatibilityMessage(error)
          ?? this.runtimeOptimizationMessage(error)
          ?? `Label Studio could not be updated.\n\n${this.shortErrorDescription(error)}`
      });
    }
  }

  private async performPythonUpdate(activeButton?: 'python'): Promise<void> {
    try {
      const versions = await this.runRuntimeBootstrap(BootstrapMode.updatePython, 'Updating Python', activeButton);
      this.setBusy(false, '');
      await this.showMessageBox({ message: 'Python Version', detail: versions.pythonVersion });
    } catch (error) {
      this.setBusy(false, '');
      await this.showMessageBox({
        type: 'error',
        message: 'Python Update Failed',
        detail: this.runtimeCompatibilityMessage(error)
          ?? this.runtimeOptimizationMessage(error)
          ?? `Python could not be updated.\n\n${this.shortErrorDescription(error)}`
      });
    }
  }

  private async performRuntimeProvisioning(activeButton?: RuntimeButton): Promise<void> {
    await this.runRuntimeBootstrap(BootstrapMode.ensurePackage, 'Preparing runtime', activeButton);
    this.setBusy(false, '');
  }

  private async runRuntimeBootstrap(mode: BootstrapMode, initialStatus: string, activeButton?: RuntimeButton) {
    this.setBusy(true, initialStatus, 0, activeButton);
    const previousTransientStageUpdate = this.runtimeBootstrapService.transientStageUpdate;
    const updateWindowStageHandler = (stage: LaunchStage): void => this.applyRuntimeBootstrapStage(stage);
    this.runtimeBootstrapService.transientStageUpdate = updateWindowStageHandler;
    try {
      await this.runtimeBootstrapService.ensureRuntime(mode, [
        runtimeUpdateStepStart('runtimeBootstrap'),
        runtimeUpdateStepEnd('runtimeBootstrap')
      ]);
    } finally {
      if (this.runtimeBootstrapService.transientStageUpdate === updateWindowStageHandler || this.runtimeBootstrapService.transientStageUpdate === undefined) {
        this.runtimeBootstrapService.transientStageUpdate = previousTransientStageUpdate;
      }
    }
    this.setBusy(true, 'Reading runtime versions', runtimeUpdateStepStart('readVersions'), activeButton);
    const versions = await this.runtimeBootstrapService.refreshVersionCache();
    this.send('state', {
      appVersion: this.runtimeBootstrapService.appVersionString(),
      electronVersion: versions.electronVersion,
      packageVersion: versions.packageVersion,
      pythonVersion: versions.pythonVersion,
      ...(await this.readPreferenceState())
    });
    this.setBusy(true, 'Runtime versions ready', runtimeUpdateStepEnd('publishVersions'), activeButton);
    return versions;
  }

  private applyRuntimeBootstrapStage(stage: LaunchStage): void {
    const visibleProgress = stage.showsDownloadProgress
      ? stage.downloadProgress ?? stage.progress
      : stage.progress;
    const rawStatus = stage.showsDownloadProgress ? (stage.downloadStatus ?? stage.title) : stage.title;
    this.currentDownloadStatus = stage.showsDownloadProgress ? rawStatus : undefined;
    const status = stage.showsDownloadProgress ? this.displayDownloadStatus(rawStatus) : rawStatus;
    this.setBusy(true, status, visibleProgress, this.activeBusyButton, stage.showsDownloadProgress, !stage.showsDownloadProgress);
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
    this.send('download-paused', paused);
    this.refreshDownloadStatusLabel();
  }

  private setBusy(
    busy: boolean,
    status: string,
    progress?: number,
    activeButton?: RuntimeButton,
    showsDownloadControls = false,
    showsInlineActivity = false
  ): void {
    if (activeButton) this.activeBusyButton = activeButton;
    if (progress == null || !showsDownloadControls) this.currentDownloadStatus = undefined;
    this.send('busy', { busy, status, progress, activeButton: this.activeBusyButton, showsDownloadControls, showsInlineActivity });
    if (!busy) this.activeBusyButton = undefined;
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
    if (!text.includes('collectstatic') && !text.includes('Optimizing Runtime')) return undefined;
    return `Python was installed, but Label Studio static asset optimization failed.\n\n${this.shortErrorDescription(error)}`;
  }

  private shortErrorDescription(error: unknown): string {
    const text = error instanceof Error ? (error.message || error.stack || String(error)) : String(error);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  }
}
