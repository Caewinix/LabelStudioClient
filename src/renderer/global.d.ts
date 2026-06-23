import type { LaunchStage } from '../main/services/launchModels';

export {};

declare global {
  interface Window {
    splashAPI?: {
      platform: NodeJS.Platform;
      onStage(callback: (stage: LaunchStage) => void): void;
      onDownloadPaused(callback: (value: boolean) => void): void;
      setPaused(paused: boolean): void;
      togglePause(): Promise<boolean>;
      cancelDownload(): Promise<boolean>;
      rendererReady(): void;
    };
    updateAPI?: {
      getState(): Promise<any>;
      checkElectron(): Promise<void>;
      checkPackage(): Promise<void>;
      checkPython(): Promise<void>;
      setPreference(key: string, value: boolean): Promise<void>;
      setPaused?(paused: boolean): void;
      togglePause(): Promise<boolean>;
      cancelDownload(): Promise<boolean>;
      onState(callback: (payload: any) => void): void;
      onBusy(callback: (payload: any) => void): void;
      onElectronVersion(callback: (value: string) => void): void;
      onPackageVersion(callback: (value: string) => void): void;
      onPythonVersion(callback: (value: string) => void): void;
      onDownloadPaused(callback: (value: boolean) => void): void;
      onDownloadStatus(callback: (value: string) => void): void;
    };
  }
}
