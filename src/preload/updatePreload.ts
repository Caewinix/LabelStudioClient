import { contextBridge, ipcRenderer } from 'electron';

type RuntimeKey = 'electron' | 'package' | 'python';

interface BusyPayload {
  busy: boolean;
  status: string;
  progress?: number;
  activeButton?: RuntimeKey;
  showsDownloadControls?: boolean;
}

interface UpdateStatePayload {
  appVersion?: string;
  electronVersion?: string;
  packageVersion?: string;
  pythonVersion?: string;
  autoCheckElectron?: boolean;
  autoCheckPackage?: boolean;
  autoCheckPython?: boolean;
}

function on<T>(channel: string, callback: (payload: T) => void): void {
  ipcRenderer.on(channel, (_event, payload: T) => callback(payload));
}

console.log('[updatePreload] installing updateAPI bridge');

contextBridge.exposeInMainWorld('updateAPI', {
  getState: async (): Promise<UpdateStatePayload> => {
    return await ipcRenderer.invoke('updates:get-state');
  },

  checkElectron: async (): Promise<void> => {
    await ipcRenderer.invoke('updates:check-electron');
  },

  checkPackage: async (): Promise<void> => {
    await ipcRenderer.invoke('updates:check-package');
  },

  checkPython: async (): Promise<void> => {
    await ipcRenderer.invoke('updates:check-python');
  },

  setPreference: async (key: string, value: boolean): Promise<void> => {
    await ipcRenderer.invoke('updates:set-preference', key, value);
  },

  onState: (callback: (payload: UpdateStatePayload) => void): void => {
    on<UpdateStatePayload>('updates:state', callback);
  },

  onBusy: (callback: (payload: BusyPayload) => void): void => {
    on<BusyPayload>('updates:busy', callback);
  },

  onElectronVersion: (callback: (value: string) => void): void => {
    on<string>('updates:electron-version', callback);
  },

  onPackageVersion: (callback: (value: string) => void): void => {
    on<string>('updates:package-version', callback);
  },

  onPythonVersion: (callback: (value: string) => void): void => {
    on<string>('updates:python-version', callback);
  },

  onDownloadPaused: (callback: (value: boolean) => void): void => {
    on<boolean>('updates:download-paused', callback);
  },

  onDownloadStatus: (callback: (value: string) => void): void => {
    on<string>('updates:download-status', callback);
  },

  setPaused: (paused: boolean): void => {
    ipcRenderer.send('updates:set-paused', paused);
  },

  togglePause: async (): Promise<boolean> => {
    return await ipcRenderer.invoke('updates:toggle-pause');
  },

  cancelDownload: async (): Promise<boolean> => {
    return await ipcRenderer.invoke('updates:cancel-download');
  }
});
