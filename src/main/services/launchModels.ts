export interface LaunchStage {
  readonly title: string;
  readonly detail: string;
  readonly progress: number;
  readonly showsDownloadProgress: boolean;
  readonly mainProgressFraction?: number;
  /** Swift parity: LaunchStage.downloadProgress is Double?, not an object. */
  readonly downloadProgress?: number;
  readonly downloadStatus?: string;
}

export function clamp01(value: number | undefined | null): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

export function launchStage(input: Partial<LaunchStage> & Pick<LaunchStage, 'title'>): LaunchStage {
  return {
    title: input.title,
    detail: input.detail ?? '',
    progress: clamp01(input.progress),
    showsDownloadProgress: input.showsDownloadProgress ?? false,
    mainProgressFraction: input.mainProgressFraction == null ? undefined : clamp01(input.mainProgressFraction),
    downloadProgress: input.downloadProgress == null ? undefined : clamp01(input.downloadProgress),
    downloadStatus: input.downloadStatus
  };
}

const LaunchProgressTitleSteps = [
  ['Preparing Runtime'],
  ['Preparing Download'],
  ['Downloading Python'],
  ['Runtime Download Skipped'],
  ['Expanding Runtime'],
  ['Runtime Expanded'],
  ['Installing Runtime'],
  ['Runtime Installed'],
  ['Preparing Package'],
  ['Bootstrapping pip'],
  ['Pip Ready'],
  ['Planning Installation'],
  ['Downloading Wheelhouse'],
  ['Wheelhouse Ready'],
  ['Installing Label Studio'],
  ['Label Studio Installed'],
  ['Optimizing Runtime'],
  ['Runtime Optimized'],
  ['Checking Electron', 'Updating Electron'],
  ['Electron Ready'],
  ['Reclaiming Cache', 'Cache Preserved'],
  ['Runtime Ready'],
  ['Checking Project Data'],
  ['Checking Updates'],
  ['Starting Local Service'],
  ['Opening Interface'],
] as const;

function launchTitleStepIndex(title: string): number {
  return LaunchProgressTitleSteps.findIndex(step => step.includes(title as never));
}

export function launchTitleProgress(title: string, fraction = 1): number | undefined {
  const index = launchTitleStepIndex(title);
  if (index < 0) return undefined;
  return (index + clamp01(fraction)) / LaunchProgressTitleSteps.length;
}

export function launchStageWithTitleProgress(stage: LaunchStage, fraction?: number): LaunchStage {
  const downloadFraction = stage.mainProgressFraction ?? Math.max(clamp01(stage.downloadProgress), clamp01(stage.progress));
  const stepFraction = fraction ?? (stage.showsDownloadProgress ? downloadFraction : 1);
  const progress = launchTitleProgress(stage.title, stepFraction);
  return progress == null ? stage : launchStage({ ...stage, progress });
}

export function launchTitleStage(
  input: Partial<LaunchStage> & Pick<LaunchStage, 'title'> & { fraction?: number }
): LaunchStage {
  return launchStage({
    ...input,
    progress: launchTitleProgress(input.title, input.fraction ?? 1) ?? input.progress
  });
}

const LaunchProgressSteps = [
  'runtime',
  'bootstrap',
  'migrations',
  'localService',
] as const;

type LaunchProgressStep = typeof LaunchProgressSteps[number];

function launchStepIndex(step: LaunchProgressStep): number {
  return LaunchProgressSteps.indexOf(step);
}

export function launchStepStart(step: LaunchProgressStep): number {
  return launchStepIndex(step) / LaunchProgressSteps.length;
}

export function launchStepEnd(step: LaunchProgressStep): number {
  return (launchStepIndex(step) + 1) / LaunchProgressSteps.length;
}

// Swift SplashScreen.swift LaunchStep parity.
export const LaunchStep = {
  runtime: launchStage({
    title: 'Preparing Runtime',
    detail: 'Verifying the bundled Python runtime and packaged resources.',
    progress: launchTitleProgress('Preparing Runtime', 0) ?? launchStepStart('runtime')
  }),
  bootstrap: launchStage({
    title: 'Checking Project Data',
    detail: 'Loading Label Studio modules and local configuration.',
    progress: launchTitleProgress('Checking Project Data') ?? launchStepEnd('runtime')
  }),
  migrations: launchStage({
    title: 'Checking Project Data',
    detail: 'Making sure the local database and static assets are ready.',
    progress: launchTitleProgress('Checking Project Data') ?? launchStepEnd('bootstrap')
  }),
  localService: launchStage({
    title: 'Starting Local Service',
    detail: 'Binding a local port and warming the workspace.',
    progress: launchTitleProgress('Starting Local Service', 0) ?? launchStepEnd('migrations')
  }),
  interfaceReady: launchStage({
    title: 'Opening Interface',
    detail: 'Switching from splash screen to the annotation window.',
    progress: launchTitleProgress('Opening Interface') ?? launchStepEnd('localService')
  })
} as const;

export const UpdatePreferenceKey = {
  // Swift names are AutoCheckChromiumUpdates / Package / Python. Chromium is intentionally renamed to Electron.
  // Keep the Swift UserDefaults key for the first runtime card. The UI/action is renamed Electron,
  // but preserving the underlying key keeps preference migration and default semantics aligned.
  autoCheckElectron: 'AutoCheckChromiumUpdates',
  autoCheckPackage: 'AutoCheckPackageUpdates',
  autoCheckPython: 'AutoCheckPythonUpdates'
} as const;

export const UpdatePreferenceDefaults: Record<string, boolean> = {
  [UpdatePreferenceKey.autoCheckElectron]: false,
  [UpdatePreferenceKey.autoCheckPackage]: true,
  [UpdatePreferenceKey.autoCheckPython]: false
};
