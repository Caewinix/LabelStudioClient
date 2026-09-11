export interface LaunchStage {
    readonly title: string;
    readonly detail: string;
    readonly progress: number;
    readonly progressStep?: string;
    readonly showsDownloadProgress: boolean;
    readonly mainProgressFraction?: number;
    readonly downloadProgress?: number;
    readonly downloadStatus?: string;
}

export type LaunchProgressTitleStep = readonly string[];

export function clamp01(value: number | undefined | null): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

export function launchStage(input: Partial<LaunchStage> & Pick<LaunchStage, 'title'>): LaunchStage {
    return {
        title: input.title,
        detail: input.detail ?? '',
        progress: clamp01(input.progress),
        progressStep: input.progressStep,
        showsDownloadProgress: input.showsDownloadProgress ?? false,
        mainProgressFraction: input.mainProgressFraction == null ? undefined : clamp01(input.mainProgressFraction),
        downloadProgress: input.downloadProgress == null ? undefined : clamp01(input.downloadProgress),
        downloadStatus: input.downloadStatus
    };
}

export const DefaultLaunchProgressTitleSteps: readonly LaunchProgressTitleStep[] = [
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
    ['Installing', 'Installing Label Studio'],
    ['Label Studio Installed'],
    ['Optimizing Runtime'],
    ['Runtime Optimized'],
    ['Applying Runtime'],
    ['Checking Electron', 'Updating Electron'],
    ['Electron Ready'],
    ['Reclaiming Cache', 'Cache Preserved'],
    ['Runtime Ready'],
    ['Checking Project Data'],
    ['Checking Updates'],
    ['Starting Local Service'],
    ['Opening Interface'],
] as const;

function launchTitleStepIndex(title: string, steps: readonly LaunchProgressTitleStep[]): number {
    return steps.findIndex(step => step.includes(title));
}

export function launchTitleProgress(
    title: string,
    fraction = 1,
    steps: readonly LaunchProgressTitleStep[] = DefaultLaunchProgressTitleSteps
): number | undefined {
    const index = launchTitleStepIndex(title, steps);
    if (index < 0) return undefined;
    return steps.length > 0 ? (index + clamp01(fraction)) / steps.length : undefined;
}

export function launchStageWithTitleProgress(
    stage: LaunchStage,
    fraction?: number,
    steps: readonly LaunchProgressTitleStep[] = DefaultLaunchProgressTitleSteps
): LaunchStage {
    const stageFraction = stage.mainProgressFraction
        ?? (stage.showsDownloadProgress ? stage.downloadProgress : undefined)
        ?? 0;
    const stepFraction = fraction ?? stageFraction;
    const progress = launchTitleProgress(stage.progressStep ?? stage.title, stepFraction, steps);
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
    autoCheckElectron: 'AutoCheckChromiumUpdates',
    autoCheckPackage: 'AutoCheckPackageUpdates',
    autoCheckPython: 'AutoCheckPythonUpdates'
} as const;

export const UpdatePreferenceDefaults: Record<string, boolean> = {
    [UpdatePreferenceKey.autoCheckElectron]: false,
    [UpdatePreferenceKey.autoCheckPackage]: true,
    [UpdatePreferenceKey.autoCheckPython]: false
};
