import { contextBridge, ipcRenderer } from 'electron';
import type { LaunchStage } from '../main/services/launchModels';

contextBridge.exposeInMainWorld('splashAPI', {
  platform: process.platform,
  onStage(callback: (stage: LaunchStage) => void): void {
    ipcRenderer.on('launch-stage', (_event, stage: LaunchStage) => callback(stage));
  },
  onDownloadPaused(callback: (value: boolean) => void): void {
    ipcRenderer.on('launch-download-paused', (_event, value: boolean) => callback(value));
  },
  setPaused(paused: boolean): void {
    ipcRenderer.send('launch-set-download-paused', paused);
  },
  togglePause(): Promise<boolean> {
    return ipcRenderer.invoke('launch-toggle-download-pause');
  },
  cancelDownload(): Promise<boolean> {
    return ipcRenderer.invoke('launch-cancel-download');
  },
  rendererReady(): void {
    ipcRenderer.send('launch-renderer-ready');
  }
});
