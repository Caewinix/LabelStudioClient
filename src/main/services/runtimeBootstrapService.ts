import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { gunzip, inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { app } from "electron";
import { AppPaths } from "./appPaths";
import { LaunchStage, launchStage, clamp01 } from "./launchModels";
import { UpdateService } from "./updateService";
import { LineAccumulator } from "./lineAccumulator";
import { DownloadMirrorFallbackError, ManagedDownloadTask, formatDownloadStatus, type DownloadProgress } from "./managedDownload";
import {
    runPlatformPackageReplacement,
    runPlatformRuntimeReplacement,
    type PreparedPackageReplacement,
    type PreparedRuntimeReplacement,
} from "../utils/runtimeElevation";
import {
    loadCondaRepodataInBackground,
    parseJsonInBackground,
    type CondaRepodataCatalog,
} from "../utils/backgroundJson";
import { extractCondaTarBz2InBackground } from "../utils/condaExtractionWorker";

const originalFs = require("original-fs") as typeof fs;
const gunzipAsync = promisify(gunzip);
const inflateRawAsync = promisify(inflateRaw);

export enum BootstrapMode {
    ensureAll = "ensure-all",
    updatePython = "update-python",
    ensurePackage = "ensure-package",
    updatePackage = "update-package",
    ensureElectron = "ensure-electron",
    updateElectron = "update-electron",
    updateAll = "update-all",
}

export type ManagedRuntimeMutationKind = "package" | "python";
type RuntimeInstallationCacheKind = "electron" | "package" | "python";

export interface ManagedRuntimeReplacementSnapshot {
    runtimeRoot: string;
    backupRoot: string;
    hadRuntime: boolean;
}

export interface ManagedRuntimeReplacementFinalizer {
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
}

const WindowsElectronInstallerActiveResponse = "ACTIVE";

export function windowsElectronInstallerPipeName(executablePath: string): string {
    const installIdentity = path.resolve(executablePath).replace(/\//g, "\\").toLowerCase();
    const digest = createHash("sha256").update(installIdentity).digest("hex").slice(0, 24);
    return `label-studio-electron-installer-${digest}`;
}

export function windowsElectronInstallerPipePath(executablePath: string): string {
    return `\\\\.\\pipe\\${windowsElectronInstallerPipeName(executablePath)}`;
}

interface NpmElectronPackage {
    version?: string;
    dist?: { tarball?: string; fileCount?: number; unpackedSize?: number };
}

interface WindowsElectronInstallerReadyPipe {
    pipeName: string;
    ready: Promise<void>;
    close: () => Promise<void>;
}

interface WindowsElectronRuntimeReplacement {
    cacheRoot: string;
    stagingRoot: string;
    sourceRoot: string;
    targetRoot: string;
    sourceExecutableName: string;
    targetExecutable: string;
    expectedVersion: string;
    activePipeName: string;
    needsElevation: boolean;
}

interface PyPIProject {
    info?: { version?: string; requires_python?: string; requires_dist?: string[] };
    releases?: Record<string, PyPIFile[]>;
    urls?: PyPIFile[];
}

interface PyPIFile {
    filename?: string;
    packagetype?: string;
    python_version?: string;
    requires_python?: string;
    url?: string;
    yanked?: boolean;
    size?: number;
}

interface PyPISimpleProject {
    name?: string;
    versions?: string[];
    files?: PyPISimpleFile[];
}

interface PyPISimpleFile {
    filename?: string;
    url?: string;
    size?: number;
    yanked?: boolean | string;
    "requires-python"?: string | null;
}

interface WheelTag {
    interpreter: string;
    abi: string;
    platform: string;
}

interface ParsedWheelFilename {
    name: string;
    version: string;
    buildTag: [] | [number, string];
    fileTags: WheelTag[];
}

type PythonMarkerTerm = { kind: "variable" | "value"; value: string };
type PythonMarkerExpression =
    | { kind: "atom"; left: PythonMarkerTerm; op: string; right: PythonMarkerTerm }
    | { kind: "and" | "or"; left: PythonMarkerExpression; right: PythonMarkerExpression };

interface PackageDownloadInfo {
    version: string;
    requiresPython: string;
    url: string;
    filename: string;
    size?: number;
}

interface WheelhouseArtifact {
    name: string;
    version: string;
    url: string;
    filename: string;
    requested: boolean;
    size?: number;
    yanked?: boolean;
    resolverName?: string;
    resolverExtras?: string[];
    synthetic?: boolean;
    installed?: boolean;
    installedMetadata?: InstalledPythonDistributionMetadata;
    coreMetadata?: PythonCoreMetadata;
}

interface WheelhouseResolveDownloadResult {
    artifacts: WheelhouseArtifact[];
    resolvedVersions: Map<string, string>;
    resolutionComplete: boolean;
    result: "completed" | "skipped";
}

interface WheelhouseResolverResult {
    artifacts: WheelhouseArtifact[];
    resolvedVersions: Map<string, string>;
}

interface ParsedPythonRequirement {
    name: string;
    extras: string[];
    specifier: string;
    url?: string;
    candidate?: WheelhouseArtifact;
    marker: string;
}

interface WheelhouseRequirementState {
    constraints: string[];
    directUrl?: string;
    explicitCandidates: WheelhouseArtifact[];
    extras: Set<string>;
    requested: boolean;
    sources: WheelhouseRequirementSource[];
}

interface ResolvedWheelhousePackage {
    artifact: WheelhouseArtifact;
    dependencyKey: string;
}

interface WheelhouseRequirementInformation {
    requirement: ParsedPythonRequirement;
    parent?: WheelhouseArtifact;
    requested: boolean;
    requestedOrder: number;
}

interface WheelhouseCriterion {
    candidates: WheelhouseArtifact[];
    information: WheelhouseRequirementInformation[];
    incompatibilities: WheelhouseArtifact[];
}

interface WheelhouseResolutionState {
    mapping: Map<string, WheelhouseArtifact>;
    criteria: Map<string, WheelhouseCriterion>;
    backtrackCauses: WheelhouseRequirementInformation[];
}

interface WheelhouseResolverContext {
    pythonVersion: string;
    indexUrl: string;
    onArtifact: (artifact: WheelhouseArtifact) => void;
    emittedArtifacts: Set<string>;
    installedDistributions: Map<string, InstalledPythonDistribution[]>;
    maxRounds: number;
    states: WheelhouseResolutionState[];
    conflictCounts: Map<string, number>;
    conflictPromoted: Set<string>;
    optimisticBackjumpingRatio: number;
    saveStates?: WheelhouseResolutionState[];
}

interface WheelhouseRequirementSource {
    parentName: string;
    parentVersion: string;
    rawRequirement: string;
}

interface RuntimeArchiveInfo {
    url: string;
    filename: string;
    size?: number;
    fallbackUrls?: string[];
}

interface PackageFallbackArtifact {
    name: string;
    version: string;
    url: string;
    filename: string;
    requested: boolean;
    size?: number;
}

interface CondaPackageRecord {
    name: string;
    version: string;
    build?: string;
    build_number?: number;
    depends?: string[];
    size?: number;
    subdir?: string;
}

interface CondaPackageCandidate {
    name: string;
    version: string;
    filename: string;
    subdir: string;
    url: string;
    fallbackUrls: string[];
    size?: number;
    depends: string[];
    buildNumber: number;
}

interface CondaDependencySpec {
    name: string;
    constraints: string;
}

interface RuntimeProcessOptions {
    outputShowsDownloadProgress?: boolean;
}

interface PipDownloadProgressState {
    filename: string;
    downloadedBytes: number;
    totalBytes: number;
    displayFraction?: number;
    startedAt: number;
    lastBytes: number;
    lastAt: number;
    lastByteProgressAt: number;
}

interface PipInstallDetailProgressState {
    emittedDetails: number;
    progress: number;
}

interface SourceArchiveTextEntry {
    name: string;
    text: string;
}

interface SourceArchiveMetadata {
    requiresPython?: string;
    requiresDist: string[];
    buildRequires: string[];
}

interface PythonCoreMetadata {
    requiresPython?: string;
    requiresDist: string[];
}

interface InstalledPythonDistributionMetadata {
    requiresPython?: string;
    requiresDist: string[];
}

interface InstalledPythonDistribution extends InstalledPythonDistributionMetadata {
    name: string;
    version: string;
    sitePackagesDirectory: string;
    distInfoPath: string;
}

interface InstalledPythonDistributionSnapshot {
    name?: string;
    version?: string;
    sitePackagesDirectory?: string;
    distInfoPath?: string;
    requiresPython?: string;
    requiresDist?: string[];
}

interface Pep440Version {
    raw: string;
    normalized: string;
    publicVersion: string;
    epoch: number;
    release: number[];
    pre?: [number, number];
    post?: number;
    dev?: number;
    local: Array<string | number>;
}

class WheelhouseResolutionError extends Error {
    constructor(
        readonly packageName: string,
        readonly constraints: string[],
        readonly pythonVersion: string,
    ) {
        super(`Unable to resolve ${packageName}${constraints.length > 0 ? ` ${constraints.join(",")}` : ""} for Python ${pythonVersion} on ${process.platform}-${process.arch}.`);
        this.name = "WheelhouseResolutionError";
    }
}

class WheelhouseRequirementsConflictedError extends Error {
    constructor(readonly criterion: WheelhouseCriterion) {
        super("Wheelhouse requirements conflicted.");
        this.name = "WheelhouseRequirementsConflictedError";
    }
}

class WheelhouseMetadataInvalidError extends Error {
    constructor(
        readonly artifact: WheelhouseArtifact,
        message: string,
    ) {
        super(message);
        this.name = "WheelhouseMetadataInvalidError";
    }
}

class WheelhouseResolutionImpossibleError extends Error {
    constructor(readonly causes: WheelhouseRequirementInformation[]) {
        super("Wheelhouse resolution is impossible.");
        this.name = "WheelhouseResolutionImpossibleError";
    }
}

export class WindowsRuntimeElevationRequiredError extends Error {
    constructor(
        readonly directory: string,
        readonly purpose: string,
        readonly detail: string,
    ) {
        super(
            `Windows administrator permission is required to ${purpose} inside the application directory: ${directory}\n\n${detail}`,
        );
        this.name = "WindowsRuntimeElevationRequiredError";
    }
}

export class LinuxRuntimeElevationRequiredError extends Error {
    constructor(
        readonly directory: string,
        readonly purpose: string,
        readonly detail: string,
    ) {
        super(
            `Linux administrator permission is required to ${purpose} inside the application directory: ${directory}\n\n${detail}`,
        );
        this.name = "LinuxRuntimeElevationRequiredError";
    }
}

export class ManagedRuntimeMutationCancelledError extends Error {
    constructor() {
        super("The managed runtime installation was cancelled before any installed files were changed.");
        this.name = "ManagedRuntimeMutationCancelledError";
    }
}

const AnacondaPkgsMainBaseUrl = "https://repo.anaconda.com/pkgs/main/";
const TunaAnacondaPkgsMainBaseUrl = "https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main/";
const CondaForgeBaseUrl = "https://conda.anaconda.org/conda-forge/";
const TunaCondaForgeBaseUrl = "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/";
const PrimaryPyPISimpleUrl = "https://pypi.org/simple/";
const TunaPyPISimpleUrl = "https://pypi.tuna.tsinghua.edu.cn/simple/";
const ElectronReleaseBaseUrl = "https://github.com/electron/electron/releases/download/";
const ElectronMirrorBaseUrls = [
    "https://npmmirror.com/mirrors/electron/",
];
const RequiresPythonIdentifier = "<Python from Requires-Python>";
// The renderer animates progress width for 180ms; keep a completed file visible
// for one short beat after the animation can actually reach 100%.
const CompletedDownloadStageHoldMs = 100;
const PackageInstallStageTitle = "Installing";
const RuntimeReplacementProgressStep = "Applying Runtime";
const RuntimeReplacementFixedDetailStepCount = 3;
const DynamicPipInstallDetailReserveStepCount = 16;
const WheelhouseMetadataPrefetchConcurrency = 8;
const PackageDownloadFallbackSpeedBytesPerSecond = 128 * 1024;
const PackageDownloadFallbackLowSpeedWindowMs = 8_000;
const PackageDownloadFallbackMinimumReceivedBytes = 1 * 1024 * 1024;
const ExplicitNetworkFailureCodes = new Set([
    "EAI_AGAIN",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "ERR_SOCKET_CLOSED",
    "ERR_STREAM_PREMATURE_CLOSE",
    "EHOSTDOWN",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "UND_ERR_SOCKET",
]);
const ExplicitNetworkFailurePattern = /\b(EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTDOWN|EHOSTUNREACH|ENETDOWN|ENETUNREACH|ENOTFOUND|EPIPE|getaddrinfo|NameResolutionError|Failed to establish a new connection|nodename nor servname provided|Name or service not known|Temporary failure in name resolution|Network is unreachable|No route to host|Connection refused|Connection reset|Connection aborted|Client network socket disconnected before secure TLS connection was established|Could not resolve host)\b/i;

const RuntimeBootstrapProgressSteps = [
    "prepareRuntime",
    "downloadPython",
    "expandRuntime",
    "installRuntime",
    "preparePackage",
    "bootstrapPip",
    "downloadPackage",
    "installPackage",
    "optimizeRuntime",
    "applyRuntime",
    "checkElectron",
    "cache",
] as const;

const ElectronUpdateProgressSteps = [
    "downloadElectron",
    "expandElectron",
    "installElectron",
] as const;

type RuntimeBootstrapProgressStep = typeof RuntimeBootstrapProgressSteps[number];
type ElectronUpdateProgressStep = typeof ElectronUpdateProgressSteps[number];

function progressStepStart(steps: readonly string[], step: string): number {
    const index = steps.indexOf(step);
    if (index < 0) throw new Error(`Unknown progress step: ${step}`);
    return index / steps.length;
}

function progressStepEnd(steps: readonly string[], step: string): number {
    const index = steps.indexOf(step);
    if (index < 0) throw new Error(`Unknown progress step: ${step}`);
    return (index + 1) / steps.length;
}

function progressStepValue(steps: readonly string[], step: string, fraction: number): number {
    const start = progressStepStart(steps, step);
    return start + (progressStepEnd(steps, step) - start) * clamp01(fraction);
}

function runtimeStepStart(step: RuntimeBootstrapProgressStep): number {
    return progressStepStart(RuntimeBootstrapProgressSteps, step);
}

function runtimeStepEnd(step: RuntimeBootstrapProgressStep): number {
    return progressStepEnd(RuntimeBootstrapProgressSteps, step);
}

function runtimeStepProgress(step: RuntimeBootstrapProgressStep, fraction: number): number {
    return progressStepValue(RuntimeBootstrapProgressSteps, step, fraction);
}

const RuntimeStageProgressSegments = new Map<string, readonly RuntimeBootstrapProgressStep[]>([
    ["Preparing Runtime", ["prepareRuntime"]],
    ["Downloading Python", ["downloadPython"]],
    ["Runtime Download Skipped", ["downloadPython"]],
    ["Expanding Runtime", ["expandRuntime"]],
    ["Runtime Expanded", ["expandRuntime"]],
    ["Installing Runtime", ["installRuntime"]],
    ["Runtime Installed", ["installRuntime"]],
    ["Preparing Package", ["preparePackage"]],
    ["Bootstrapping pip", ["bootstrapPip"]],
    ["Pip Ready", ["bootstrapPip"]],
    [PackageInstallStageTitle, ["downloadPackage", "installPackage"]],
    ["Installing Label Studio", ["downloadPackage", "installPackage"]],
    ["Label Studio Installed", ["downloadPackage", "installPackage"]],
    ["Optimizing Runtime", ["optimizeRuntime"]],
    ["Runtime Optimized", ["optimizeRuntime"]],
    ["Checking Electron", ["checkElectron"]],
    ["Updating Electron", ["checkElectron"]],
    ["Electron Ready", ["checkElectron"]],
    ["Reclaiming Cache", ["cache"]],
    ["Cache Preserved", ["cache"]],
    ["Runtime Ready", ["cache"]],
]);

function runtimeStageMainProgressFraction(title: string, progress: number): number | undefined {
    const segments = RuntimeStageProgressSegments.get(title);
    if (!segments?.length) return undefined;
    const start = runtimeStepStart(segments[0]);
    const end = runtimeStepEnd(segments[segments.length - 1]);
    const epsilon = Number.EPSILON * 16;
    if (progress < start - epsilon || progress > end + epsilon || end <= start) return undefined;
    return clamp01((progress - start) / (end - start));
}

function runtimeReplacementMainProgressFraction(phase: string, completedEntries: number, totalEntries: number): number {
    const fileSteps = Math.max(0, Math.floor(totalEntries));
    const completedFileSteps = Math.min(fileSteps, Math.max(0, Math.floor(completedEntries)));
    const totalDetailSteps = RuntimeReplacementFixedDetailStepCount + fileSteps;

    if (phase === "complete") return 1;
    if (phase === "activate") return (fileSteps + 2) / totalDetailSteps;
    return (1 + completedFileSteps) / totalDetailSteps;
}

function electronStepStart(step: ElectronUpdateProgressStep): number {
    return progressStepStart(ElectronUpdateProgressSteps, step);
}

function electronStepEnd(step: ElectronUpdateProgressStep): number {
    return progressStepEnd(ElectronUpdateProgressSteps, step);
}

function electronStepProgress(step: ElectronUpdateProgressStep, fraction: number): number {
    return progressStepValue(ElectronUpdateProgressSteps, step, fraction);
}

const ElectronStageProgressSegments = new Map<string, readonly ElectronUpdateProgressStep[]>([
    ["Downloading Electron", ["downloadElectron"]],
    ["Expanding Electron", ["expandElectron"]],
    ["Installing Electron", ["installElectron"]],
    ["Electron Updated", ["installElectron"]],
    ["Electron Update Ready", ["installElectron"]],
]);

function electronStageMainProgressFraction(title: string, progress: number): number | undefined {
    const segments = ElectronStageProgressSegments.get(title);
    if (!segments?.length) return undefined;
    const start = electronStepStart(segments[0]);
    const end = electronStepEnd(segments[segments.length - 1]);
    const epsilon = Number.EPSILON * 16;
    if (progress < start - epsilon || progress > end + epsilon || end <= start) return undefined;
    return clamp01((progress - start) / (end - start));
}

type RuntimeInstallResult = "completed" | "skipped";

export class RuntimeBootstrapService extends EventEmitter {
    private currentProcess?: ChildProcessWithoutNullStreams;
    private activeDownloadTask?: ManagedDownloadTask;
    private activeRuntimeOperationAbortController?: AbortController;
    private downloadPauseRequested = false;
    private downloadPauseAllowed = false;
    private downloadSkipRequested = false;
    private lastRuntimeOperationSkipped = false;
    private downloadResumeResolvers = new Set<() => void>();
    private recentOutput: string[] = [];
    private stdoutAccumulator = new LineAccumulator();
    private stderrAccumulator = new LineAccumulator();
    private activeProgressRange: [number, number] = [0, 1];
    private lastProcessEmissionByKey = new Map<string, number>();
    private pipInstallDetailProgressStates = new Map<string, PipInstallDetailProgressState>();
    private lastRuntimeValidationError = "";
    private electronRuntimeReplacementPending = false;
    private electronRuntimeReplacement?: WindowsElectronRuntimeReplacement;
    private anacondaMainRepodataPromises = new Map<string, Promise<CondaRepodataCatalog>>();
    private condaRepodataPromises = new Map<string, Promise<CondaRepodataCatalog>>();
    private pyPIProjectPromises = new Map<string, Promise<PyPIProject>>();
    private sourceArchiveMetadataPromises = new Map<string, Promise<SourceArchiveMetadata>>();
    private wheelArtifactMetadataPromises = new Map<string, Promise<PythonCoreMetadata>>();
    private supportedWheelTagsCache = new Map<string, WheelTag[]>();
    private supportedWheelTagIndexesCache = new Map<string, Map<string, number>>();
    private pyPIWheelMetadataUnavailable = false;
    private preferTunaPyPI = false;
    private preferTunaPyPIArtifactFiles = false;
    private pipDownloadProgress?: PipDownloadProgressState;
    private pipInstallMainFraction = 0;
    private stageHoldTimer?: NodeJS.Timeout;
    private heldStage?: LaunchStage;
    private heldCompletionStages: LaunchStage[] = [];
    private downloadCompletionHoldUntil = 0;
    private stageSequence = 0;
    transientStageUpdate?: (stage: LaunchStage) => void;
    private readonly updateService = new UpdateService();
    private runtimeReaderCount = 0;
    private runtimeWriterActive = false;
    private readonly runtimeReaderWaiters: Array<() => void> = [];
    private readonly runtimeWriterWaiters: Array<() => void> = [];
    private managedRuntimeMutationPrepared = false;
    private packageInstallerPrepared = false;
    private pendingRuntimeReplacement?: ManagedRuntimeReplacementSnapshot;
    private readonly pendingRuntimeReplacementFinalizers: ManagedRuntimeReplacementFinalizer[] = [];
    private readonly pendingRuntimeInstallationCacheCleanup = new Set<RuntimeInstallationCacheKind>();
    beforeManagedRuntimeMutation?: (kind: ManagedRuntimeMutationKind) => Promise<void>;

    async ensureRuntime(
        mode: BootstrapMode = BootstrapMode.ensureAll,
        progressRange: [number, number] = [0, 1],
        targetPackageVersion?: string,
    ): Promise<void> {
        await this.withRuntimeMutationLock(async () => {
            await this.ensureRuntimeUnlocked(mode, progressRange, targetPackageVersion);
        });
    }

    hasPendingRuntimeReplacement(): boolean {
        return Boolean(this.pendingRuntimeReplacement || this.pendingRuntimeReplacementFinalizers.length > 0);
    }

    adoptPendingRuntimeReplacementFinalizer(finalizer: ManagedRuntimeReplacementFinalizer): void {
        if (this.pendingRuntimeReplacement) {
            throw new Error("A local managed runtime replacement is already waiting for startup validation.");
        }
        this.pendingRuntimeReplacementFinalizers.push(finalizer);
    }

    async commitPendingRuntimeReplacement(): Promise<void> {
        await this.withRuntimeMutationLock(async () => {
            const hadPendingRuntimeReplacement = this.hasPendingRuntimeReplacement();
            await this.commitPendingRuntimeReplacementUnlocked();
            while (this.pendingRuntimeReplacementFinalizers.length > 0) {
                const finalizer = this.pendingRuntimeReplacementFinalizers.pop();
                if (!finalizer) break;
                await finalizer.commit();
            }
            this.updateService.invalidateVersionCache();
            if (hadPendingRuntimeReplacement && AppPaths.shouldReclaimRuntimeCache()) {
                const cacheKinds = [...this.pendingRuntimeInstallationCacheCleanup];
                await this.reclaimRuntimeInstallationCaches(cacheKinds);
                for (const cacheKind of cacheKinds) {
                    this.pendingRuntimeInstallationCacheCleanup.delete(cacheKind);
                }
            }
        });
    }

    async rollbackPendingRuntimeReplacement(): Promise<void> {
        await this.withRuntimeMutationLock(async () => {
            const rollbackErrors: unknown[] = [];
            const cacheKinds = [...this.pendingRuntimeInstallationCacheCleanup];
            try {
                await this.rollbackPendingRuntimeReplacementUnlocked();
            } catch (error) {
                rollbackErrors.push(error);
            }
            while (this.pendingRuntimeReplacementFinalizers.length > 0) {
                const finalizer = this.pendingRuntimeReplacementFinalizers.pop();
                if (!finalizer) break;
                try {
                    await finalizer.rollback();
                } catch (error) {
                    rollbackErrors.push(error);
                }
            }
            if (rollbackErrors.length === 0 && AppPaths.shouldReclaimRuntimeCache()) {
                await this.reclaimRuntimeInstallationCaches(cacheKinds);
                this.pendingRuntimeInstallationCacheCleanup.clear();
            }
            this.updateService.invalidateVersionCache();
            if (rollbackErrors.length > 0) {
                throw new Error(rollbackErrors.map((error, index) => {
                    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
                    return `Rollback ${index + 1} failed:\n${detail}`;
                }).join("\n\n"));
            }
        });
    }

    private async ensureRuntimeUnlocked(
        mode: BootstrapMode,
        progressRange: [number, number],
        targetPackageVersion?: string,
    ): Promise<void> {
        const operationAbortController = new AbortController();
        this.activeRuntimeOperationAbortController = operationAbortController;
        await this.updateService.waitForRuntimeReadersToSettle();
        this.activeProgressRange = progressRange;
        this.recentOutput = [];
        this.stdoutAccumulator = new LineAccumulator();
        this.stderrAccumulator = new LineAccumulator();
        this.lastProcessEmissionByKey.clear();
        this.pipInstallDetailProgressStates.clear();
        this.electronRuntimeReplacementPending = false;
        this.electronRuntimeReplacement = undefined;
        this.downloadPauseRequested = false;
        this.downloadPauseAllowed = false;
        this.downloadSkipRequested = false;
        this.lastRuntimeOperationSkipped = false;
        this.managedRuntimeMutationPrepared = false;
        this.packageInstallerPrepared = false;
        this.resolveDownloadResumeWaiters();
        this.stageSequence += 1;
        this.clearHeldStage();

        AppPaths.downloadCacheDirectory();
        const pythonCacheDirectory = AppPaths.pythonDownloadCacheDirectory();
        const runtimeRoot = AppPaths.bundledRuntimeRoot();

        try {
            await this.emitBootstrapStage(
                "Preparing Runtime",
                "Checking the managed runtime state for this app.",
                runtimeStepStart("prepareRuntime"),
                false,
                undefined,
                undefined,
            );

            switch (mode) {
                case BootstrapMode.ensureElectron:
                    await this.ensureElectronRuntime(false, electronStepStart("downloadElectron"), electronStepEnd("installElectron"));
                    break;
                case BootstrapMode.updateElectron:
                    await this.runInstallationStageWithFailureCacheCleanup(
                        ["electron"],
                        async () => await this.updateElectronDependency(),
                    );
                    if (!this.lastRuntimeOperationSkipped) {
                        await this.completeInstallationCacheStage("electron");
                    }
                    break;
                case BootstrapMode.ensureAll:
                case BootstrapMode.ensurePackage: {
                    const installedCacheKinds = await this.ensurePackageRuntime(pythonCacheDirectory, runtimeRoot);
                    await this.completeInstallationCacheStage(...installedCacheKinds);
                    if (!this.lastRuntimeOperationSkipped) {
                        await this.ensureElectronRuntime(false, runtimeStepStart("checkElectron"), runtimeStepEnd("checkElectron"));
                    }
                    break;
                }
                case BootstrapMode.updatePackage:
                    await this.runInstallationStageWithFailureCacheCleanup(
                        ["package"],
                        async () => await this.updatePackage(runtimeRoot, targetPackageVersion),
                    );
                    if (!this.lastRuntimeOperationSkipped) {
                        await this.completeInstallationCacheStage("package");
                    }
                    break;
                case BootstrapMode.updatePython:
                    await this.runInstallationStageWithFailureCacheCleanup(
                        ["python", "package"],
                        async () => await this.updatePython(pythonCacheDirectory, runtimeRoot),
                    );
                    if (!this.lastRuntimeOperationSkipped) {
                        await this.completeInstallationCacheStage("python", "package");
                    }
                    break;
                case BootstrapMode.updateAll:
                    await this.runInstallationStageWithFailureCacheCleanup(
                        ["python", "package"],
                        async () => await this.updateAll(pythonCacheDirectory, runtimeRoot),
                    );
                    if (!this.lastRuntimeOperationSkipped) {
                        await this.completeInstallationCacheStage("python", "package");
                    }
                    await this.ensureElectronRuntime(true, runtimeStepStart("checkElectron"), runtimeStepEnd("checkElectron"));
                    break;
            }

            if (this.lastRuntimeOperationSkipped) return;

            this.updateService.invalidateVersionCache();

            if (AppPaths.shouldReclaimRuntimeCache()) {
                const cleanupDeferred = this.pendingRuntimeInstallationCacheCleanup.size > 0
                    || this.electronRuntimeReplacementPending;
                await this.emitBootstrapStage(
                    "Reclaiming Cache",
                    cleanupDeferred
                        ? "The installed stage cache will be removed after the updated files are validated."
                        : "Installed stage caches were removed after each installation completed.",
                    runtimeStepStart("cache"),
                    false,
                    undefined,
                    undefined,
                );
            } else {
                await this.emitBootstrapStage(
                    "Cache Preserved",
                    "Keeping downloaded runtime and package cache files for development.",
                    runtimeStepStart("cache"),
                    false,
                    undefined,
                    undefined,
                );
            }
            await this.emitBootstrapStage(
                "Runtime Ready",
                "The managed Python runtime and Label Studio package are ready.",
                runtimeStepEnd("cache"),
                false,
                undefined,
                undefined,
            );
            this.flushHeldStage();
        } catch (error) {
            if (!this.lastRuntimeOperationSkipped) {
                if (this.pendingRuntimeReplacement && this.pendingRuntimeReplacementFinalizers.length === 0) {
                    try {
                        await this.rollbackPendingRuntimeReplacementUnlocked();
                        const cacheKinds = [...this.pendingRuntimeInstallationCacheCleanup];
                        await this.reclaimRuntimeInstallationCaches(cacheKinds);
                        this.pendingRuntimeInstallationCacheCleanup.clear();
                    } catch (rollbackError) {
                        const originalDetail = error instanceof Error ? error.stack ?? error.message : String(error);
                        const rollbackDetail = rollbackError instanceof Error ? rollbackError.stack ?? rollbackError.message : String(rollbackError);
                        throw new Error(`Runtime bootstrap failed and the previous managed runtime could not be restored.\n\nBootstrap failure:\n${originalDetail}\n\nRollback failure:\n${rollbackDetail}`);
                    }
                }
                throw error;
            }
        } finally {
            if (this.activeRuntimeOperationAbortController === operationAbortController) {
                this.activeRuntimeOperationAbortController = undefined;
            }
            this.clearHeldStage();
            this.transientStageUpdate = undefined;
            this.activeProgressRange = [0, 1];
            this.currentProcess = undefined;
            this.activeDownloadTask = undefined;
            this.downloadPauseRequested = false;
            this.downloadSkipRequested = false;
            this.resolveDownloadResumeWaiters();
        }
    }

    async fetchVersions(): Promise<import("./updateService").RuntimeVersions> {
        return await this.withRuntimeReadLock(async () => await this.updateService.fetchVersions());
    }

    async waitForRuntimeReadersToSettle(): Promise<void> {
        await this.withRuntimeMutationLock(async () => {
            await this.updateService.waitForRuntimeReadersToSettle();
        });
    }

    async withRuntimeMutationLock<T>(operation: () => Promise<T>): Promise<T> {
        await this.acquireRuntimeWriteLock();
        try {
            await this.updateService.waitForRuntimeReadersToSettle();
            return await operation();
        } finally {
            this.releaseRuntimeWriteLock();
        }
    }

    versionSnapshot(): import("./updateService").RuntimeVersions {
        return this.updateService.versionSnapshot();
    }

    primeVersionCache(): void {
        void this.fetchVersions().catch(() => {
            // Version reads already have local fallbacks. A failed warm-up is retried by callers.
        });
    }

    invalidateVersionCache(): void {
        this.updateService.invalidateVersionCache();
    }

    hasPendingElectronRuntimeReplacement(): boolean {
        return process.platform === "win32" && this.electronRuntimeReplacementPending;
    }

    electronUpdateDiagnosticLogPath(): string {
        return AppPaths.electronUpdateApplyLogFile();
    }

    recordElectronUpdateDiagnostic(message: string): void {
        this.appendElectronUpdateLog(`[main] ${message}`);
    }

    async startPendingElectronRuntimeReplacementInstaller(): Promise<void> {
        if (process.platform !== "win32") return;

        const replacement = this.electronRuntimeReplacement;
        this.appendElectronUpdateLog(`[main] Starting pending Windows Electron installer. pid=${process.pid} source=${replacement?.sourceRoot ?? "missing"}`);
        if (!replacement) {
            await this.cleanupFailedInstallationCacheStage(["electron"]);
            throw new Error("No pending Electron runtime update was found.");
        }
        if (!fs.existsSync(replacement.sourceRoot)) {
            await this.cleanupFailedInstallationCacheStage(["electron"]);
            throw new Error(`The expanded Electron runtime does not exist: ${replacement.sourceRoot}`);
        }
        const installerExecutable = AppPaths.windowsInstallerExecutable();
        if (!fs.existsSync(installerExecutable)) {
            await this.cleanupFailedInstallationCacheStage(["electron"]);
            throw new Error(`The packaged Label Studio installer executable does not exist: ${installerExecutable}`);
        }

        this.appendElectronUpdateLog("[main] Creating installer readiness IPC server.");
        let readyPipe: WindowsElectronInstallerReadyPipe;
        try {
            readyPipe = await this.createWindowsElectronInstallerReadyPipe();
        } catch (error) {
            await this.cleanupFailedInstallationCacheStage(["electron"]);
            throw error;
        }
        this.appendElectronUpdateLog(`[main] Installer readiness IPC server is listening. pipe=${readyPipe.pipeName}`);
        let child: ReturnType<typeof spawn> | undefined;
        try {
            this.appendElectronUpdateLog(`[main] Spawning branded Windows installer. executable=${installerExecutable}`);
            const installerArguments = [
                "--cache-root",
                replacement.cacheRoot,
                "--source-root",
                replacement.sourceRoot,
                "--staging-root",
                replacement.stagingRoot,
                "--target-root",
                replacement.targetRoot,
                "--source-executable-name",
                replacement.sourceExecutableName,
                "--target-executable",
                replacement.targetExecutable,
                "--expected-version",
                replacement.expectedVersion,
                "--parent-pid",
                String(process.pid),
                "--ready-pipe",
                readyPipe.pipeName,
                "--active-pipe",
                replacement.activePipeName,
                "--diagnostic-log",
                AppPaths.electronUpdateApplyLogFile(),
            ];
            if (replacement.needsElevation) installerArguments.push("--needs-elevation");
            child = spawn(installerExecutable, installerArguments, {
                stdio: "ignore",
                windowsHide: true,
                detached: true,
            });
        } catch (error) {
            this.appendElectronUpdateLog(`[main] Windows installer launcher spawn threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
            await readyPipe.close();
            await this.cleanupFailedInstallationCacheStage(["electron"]);
            throw error;
        }

        if (!child.pid) {
            this.appendElectronUpdateLog("[main] Windows installer launcher returned no process id.");
            await readyPipe.close();
            await this.cleanupFailedInstallationCacheStage(["electron"]);
            throw new Error("Failed to start the Windows Electron installer.");
        }

        this.electronRuntimeReplacementPending = true;
        this.appendElectronUpdateLog(`Started Windows Electron installer after user confirmation. installer=${installerExecutable} installerPid=${child.pid}`);

        try {
            await this.waitForWindowsElectronInstallerReady(child, installerExecutable, readyPipe.ready);
            this.appendElectronUpdateLog(`Windows Electron installer confirmed ownership of the replacement. installer=${installerExecutable} installerPid=${child.pid}`);
        } catch (error) {
            this.electronRuntimeReplacementPending = false;
            this.appendElectronUpdateLog(`Windows Electron installer did not become ready: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        } finally {
            this.appendElectronUpdateLog("[main] Releasing installer launcher streams and readiness IPC server.");
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            await readyPipe.close();
            this.appendElectronUpdateLog("[main] Installer readiness IPC server closed.");
        }
    }

    private async createWindowsElectronInstallerReadyPipe(): Promise<WindowsElectronInstallerReadyPipe> {
        const pipeName = `label-studio-electron-installer-ready-${process.pid}-${randomUUID()}`;
        const server = net.createServer();
        const sockets = new Set<net.Socket>();

        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                this.appendElectronUpdateLog(`[main-ipc] Readiness server failed before listening: ${error.stack ?? error.message}`);
                server.removeListener("listening", onListening);
                reject(error);
            };
            const onListening = (): void => {
                this.appendElectronUpdateLog(`[main-ipc] Readiness server listening. pipe=${pipeName}`);
                server.removeListener("error", onError);
                resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(`\\\\.\\pipe\\${pipeName}`);
        });

        let readySettled = false;
        let resolveReady!: () => void;
        let rejectReady!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });

        server.on("connection", socket => {
            this.appendElectronUpdateLog(`[main-ipc] Readiness client connected. pipe=${pipeName}`);
            sockets.add(socket);
            let response = "";
            socket.setEncoding("utf8");
            socket.once("close", () => {
                sockets.delete(socket);
                this.appendElectronUpdateLog(`[main-ipc] Readiness client disconnected. pipe=${pipeName}`);
            });
            socket.on("data", chunk => {
                response += chunk;
                const newline = response.indexOf("\n");
                if (newline < 0 || readySettled) return;
                const message = response.slice(0, newline).trim();
                this.appendElectronUpdateLog(`[main-ipc] Readiness response received: ${message || "empty"}`);
                if (message === WindowsElectronInstallerActiveResponse) {
                    readySettled = true;
                    resolveReady();
                } else {
                    readySettled = true;
                    rejectReady(new Error(`The Windows Electron installer sent an invalid IPC readiness response: ${message || "empty"}.`));
                }
                socket.destroy();
            });
            socket.once("error", error => {
                this.appendElectronUpdateLog(`[main-ipc] Readiness client error: ${error.stack ?? error.message}`);
                if (readySettled) return;
                readySettled = true;
                rejectReady(error);
            });
        });
        server.once("error", error => {
            this.appendElectronUpdateLog(`[main-ipc] Readiness server error: ${error.stack ?? error.message}`);
            if (readySettled) return;
            readySettled = true;
            rejectReady(error);
        });

        return {
            pipeName,
            ready,
            close: async () => {
                this.appendElectronUpdateLog(`[main-ipc] Closing readiness server. pipe=${pipeName} connections=${sockets.size}`);
                for (const socket of sockets) socket.destroy();
                sockets.clear();
                await new Promise<void>(resolve => {
                    if (!server.listening) {
                        resolve();
                        return;
                    }
                    server.close(() => resolve());
                });
                this.appendElectronUpdateLog(`[main-ipc] Readiness server close completed. pipe=${pipeName}`);
            },
        };
    }

    private async waitForWindowsElectronInstallerReady(
        child: ReturnType<typeof spawn>,
        helperPath: string,
        ready: Promise<void>,
    ): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            let settled = false;

            const finish = (error?: Error): void => {
                if (settled) return;
                settled = true;
                child.removeListener("error", onError);
                child.removeListener("close", onClose);
                if (error) reject(error);
                else resolve();
            };
            const updateLogTail = (): string => {
                try {
                    const lines = fs.readFileSync(AppPaths.electronUpdateApplyLogFile(), "utf8").trim().split(/\r?\n/);
                    return lines.slice(-8).join("\n");
                } catch {
                    return "";
                }
            };
            const failure = (reason: string): Error => {
                const logTail = updateLogTail();
                return new Error(logTail ? `${reason}\n\n${logTail}` : reason);
            };
            const onError = (error: Error): void => {
                this.appendElectronUpdateLog(`[main] Windows installer process error: ${error.stack ?? error.message}`);
                finish(failure(`The Windows Electron installer could not be started: ${error.message}`));
            };
            const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
                this.appendElectronUpdateLog(`[main] Windows installer closed. code=${code ?? "null"} signal=${signal ?? "null"}`);
                finish(failure(`The Windows Electron installer closed before its IPC endpoint became ready (status ${code ?? signal ?? "unknown"}).`));
            };

            child.once("error", onError);
            child.once("close", onClose);
            void ready.then(
                () => {
                    this.appendElectronUpdateLog("[main] Windows installer readiness promise resolved.");
                    finish();
                },
                error => {
                    this.appendElectronUpdateLog(`[main] Windows installer readiness promise rejected: ${error.stack ?? error.message}`);
                    finish(failure(`The Windows Electron installer IPC handshake failed: ${error.message}`));
                },
            );
            this.appendElectronUpdateLog(`Waiting for Windows Electron installer IPC readiness. installer=${helperPath} installerPid=${child.pid}`);
        });
    }

    shouldRetryPyPIWithMirrorAfterFailure(error: unknown): boolean {
        void error;
        // File downloads switch mirrors at the artifact URL layer. Do not rerun
        // the resolver against mirror metadata because mirror JSON can lag PyPI.
        return false;
    }

    forcePreferTunaPyPI(reason?: string): void {
        this.preferTunaPyPIForCurrentRun();
        if (reason) this.appendRecentOutput(reason);
    }

    async refreshVersionCache(): Promise<import("./updateService").RuntimeVersions> {
        return await this.withRuntimeReadLock(async () => await this.updateService.refreshVersionCache());
    }

    appVersionString(): string {
        return this.updateService.appVersionString();
    }

    async checkElectron(): Promise<import("./updateService").ElectronCheckResult> {
        return await this.updateService.checkElectron();
    }

    async checkPackage(): Promise<import("./updateService").PackageCheckResult> {
        return await this.withRuntimeReadLock(async () => await this.updateService.checkPackage());
    }

    async checkPython(): Promise<import("./updateService").PythonCheckResult> {
        return await this.withRuntimeReadLock(async () => await this.updateService.checkPython());
    }

    hasUsableElectronRuntime(): boolean {
        return Boolean(process.versions.electron);
    }

    toggleCurrentDownloadPause(): boolean {
        this.traceDownload("toggle-request", {
            requestedBefore: this.downloadPauseRequested,
            activeTask: this.activeDownloadTask?.snapshot(),
            hasProcess: Boolean(this.currentProcess && this.currentProcess.exitCode === null && this.currentProcess.signalCode === null),
        });
        return this.setCurrentDownloadPaused(!this.downloadPauseRequested);
    }

    setCurrentDownloadPaused(paused: boolean): boolean {
        if (paused && !this.downloadPauseAllowed) {
            this.traceDownload("set-paused-ignored-outside-download-stage", { actualPaused: false });
            this.setCurrentDownloadPaused(false);
            return false;
        }

        const proc = this.currentProcess;
        this.traceDownload("set-paused-request", {
            requested: paused,
            activeTask: this.activeDownloadTask?.snapshot(),
            hasProcess: Boolean(proc && proc.exitCode === null && proc.signalCode === null),
        });
        if (!this.activeDownloadTask && proc && proc.exitCode === null && proc.signalCode === null) {
            if (process.platform === "win32") {
                this.downloadPauseRequested = false;
                if (!paused) this.resolveDownloadResumeWaiters();
                this.traceDownload("set-paused-process-unsupported", { actualPaused: false });
                return false;
            }
            try {
                proc.kill(paused ? "SIGSTOP" : "SIGCONT");
                this.downloadPauseRequested = paused;
                if (!paused) this.resolveDownloadResumeWaiters();
                this.traceDownload("set-paused-process", { actualPaused: paused });
                return paused;
            } catch {
                this.downloadPauseRequested = false;
                this.resolveDownloadResumeWaiters();
                this.traceDownload("set-paused-process-failed", { actualPaused: false });
                return false;
            }
        }

        if (paused) {
            this.downloadPauseRequested = true;
            // A completed-file hold may already contain progress for the next file.
            // Discard it so pausing freezes both the network task and the visible file.
            this.clearHeldStage();
            if (!this.activeDownloadTask) {
                this.traceDownload("set-paused-no-active-task", { actualPaused: true });
                return true;
            }
            this.activeDownloadTask.pause();
            this.traceDownload("set-paused-active-task", { actualPaused: true, activeTask: this.activeDownloadTask.snapshot() });
            return true;
        }
        this.downloadPauseRequested = false;
        this.resolveDownloadResumeWaiters();
        this.activeDownloadTask?.resumeIfPaused();
        this.traceDownload("set-paused-resume", { actualPaused: false, activeTask: this.activeDownloadTask?.snapshot() });
        return false;
    }

    pauseCurrentDownload(): boolean {
        return this.setCurrentDownloadPaused(true);
    }

    resumeCurrentDownload(): void {
        this.setCurrentDownloadPaused(false);
    }

    cancelCurrentDownloadAndSkip(): void {
        // Cancel the active transfer and end this bootstrap operation without
        // treating the user's choice as a network or installation failure.
        this.downloadPauseRequested = false;
        this.downloadPauseAllowed = false;
        this.downloadSkipRequested = true;
        this.lastRuntimeOperationSkipped = true;
        this.activeRuntimeOperationAbortController?.abort();
        this.resolveDownloadResumeWaiters();
        if (this.activeDownloadTask) {
            this.activeDownloadTask.cancelForSkip();
            return;
        }
        const proc = this.currentProcess;
        this.currentProcess = undefined;
        if (proc && proc.exitCode === null && proc.signalCode === null) {
            try { proc.kill("SIGTERM"); } catch { /* best effort */ }
        }
    }

    wasLastRuntimeOperationSkipped(): boolean {
        return this.lastRuntimeOperationSkipped;
    }

    stop(): void {
        this.downloadPauseRequested = false;
        this.downloadPauseAllowed = false;
        this.downloadSkipRequested = true;
        this.resolveDownloadResumeWaiters();
        this.activeDownloadTask?.cancelForShutdown();
        this.activeDownloadTask = undefined;

        const proc = this.currentProcess;
        this.currentProcess = undefined;
        if (proc && proc.exitCode === null && proc.signalCode === null) {
            try { proc.kill('SIGTERM'); } catch { /* best effort */ }
        }

        this.stageSequence += 1;
        this.clearHeldStage();
    }

    private async ensurePackageRuntime(
        pythonCacheDirectory: string,
        runtimeRoot: string,
    ): Promise<RuntimeInstallationCacheKind[]> {
        let cacheKinds: RuntimeInstallationCacheKind[] = ["package"];
        try {
            const pkg = await this.latestPackageDownload();
            const runtimeValid = await this.validateRuntime(runtimeRoot);

            if (!runtimeValid || !(await this.embeddedPythonSatisfies(pkg.requiresPython, runtimeRoot))) {
                cacheKinds = ["python", "package"];
                const targetPython = await this.packageTargetPythonVersion(pkg.requiresPython);
                const result = await this.installPythonAndPackageAttempt(targetPython, pkg, pythonCacheDirectory, runtimeRoot);
                if (result === "skipped") {
                    await this.cleanupFailedInstallationCacheStage(cacheKinds);
                    return [];
                }
                return cacheKinds;
            }

            if (!(await this.packageInstalled(runtimeRoot))) {
                const result = await this.installPackageWithPreparedFileTransaction(pkg, runtimeRoot, false);
                if (result === "skipped") {
                    await this.cleanupFailedInstallationCacheStage(cacheKinds);
                    return [];
                }
                return cacheKinds;
            }

            return [];
        } catch (error) {
            await this.cleanupFailedInstallationCacheStage(cacheKinds);
            throw error;
        }
    }

    private async updatePackage(
        runtimeRoot: string,
        targetPackageVersion?: string,
    ): Promise<void> {
        const requestedVersion = this.requestedPackageVersion(targetPackageVersion);
        const pkg = requestedVersion
            ? await this.packageDownload(requestedVersion)
            : await this.latestPackageDownload();
        const runtimeValid = await this.validateRuntime(runtimeRoot);
        const pythonSatisfiesPackage = runtimeValid
            ? await this.embeddedPythonSatisfies(pkg.requiresPython, runtimeRoot)
            : false;

        if (!runtimeValid) {
            throw new Error(
                "The Label Studio package cannot be updated because the managed Python runtime is not usable. "
                + "Update Python separately before updating the package.",
            );
        }
        if (!pythonSatisfiesPackage) {
            const currentPython = await this.currentPythonVersion(runtimeRoot).catch(() => "Unknown");
            throw new Error(
                `Label Studio ${pkg.version} requires Python ${pkg.requiresPython || "with a compatible version"}, `
                + `but the managed runtime is Python ${currentPython}. Update Python separately; package update will not replace it.`,
            );
        }

        const result = await this.installPackageWithPreparedFileTransaction(pkg, runtimeRoot, true);
        if (result === "skipped") return;
        await this.assertInstalledPackageVersion(runtimeRoot, pkg.version);
    }

    private requestedPackageVersion(version: string | undefined): string | undefined {
        const normalized = version?.trim();
        return normalized && normalized !== "Unknown" && normalized !== "Not installed"
            ? normalized
            : undefined;
    }

    private async assertInstalledPackageVersion(runtimeRoot: string, expectedVersion: string): Promise<void> {
        const installed = (await this.readInstalledPythonDistributions(runtimeRoot)).get("label-studio") ?? [];
        const metadataVersions = installed
            .map((distribution) => distribution.version);
        if (!metadataVersions.includes(expectedVersion)) {
            const actualVersion = await this.currentPackageVersion(runtimeRoot).catch(() => "Not installed");
            throw new Error(
                `Label Studio package installation did not reach the requested version. `
                + `Expected ${expectedVersion}, but the managed runtime reports ${actualVersion}.`,
            );
        }

        const actualVersion = await this.currentPackageVersion(runtimeRoot);
        if (actualVersion !== expectedVersion) {
            throw new Error(
                `Label Studio package installation did not reach the requested version. `
                + `Expected ${expectedVersion}, but the managed runtime reports ${actualVersion}.`,
            );
        }

        const staleVersions = [...new Set(metadataVersions.filter((version) => version !== expectedVersion))];
        if (staleVersions.length > 0) {
            throw new Error(`Older Label Studio package metadata remains installed: ${staleVersions.join(", ")}.`);
        }
        await this.assertLabelStudioServerEntrypoint(runtimeRoot);
    }

    private async updatePython(pythonCacheDirectory: string, runtimeRoot: string): Promise<void> {
        const existingPackageVersion = await this.currentPackageVersion(runtimeRoot).catch(() => undefined);
        const pkg = existingPackageVersion
            ? (await this.packageDownload(existingPackageVersion).catch(() => undefined)) ?? (await this.latestPackageDownload())
            : await this.latestPackageDownload();
        const pythonVersion = await this.latestPythonVersion();
        await this.installPythonAndPackageAttempt(pythonVersion, pkg, pythonCacheDirectory, runtimeRoot);
    }

    private async updateAll(pythonCacheDirectory: string, runtimeRoot: string): Promise<void> {
        const pythonVersion = await this.latestPythonVersion();
        const pkg = await this.latestPackageDownload();
        await this.installPythonAndPackageAttempt(pythonVersion, pkg, pythonCacheDirectory, runtimeRoot);
    }

    private async installPythonAndPackageAttempt(
        pythonVersion: string,
        pkg: PackageDownloadInfo,
        pythonCacheDirectory: string,
        runtimeRoot: string,
        mutationKind: ManagedRuntimeMutationKind = "python",
    ): Promise<RuntimeInstallResult> {
        const runtimeParent = path.dirname(runtimeRoot);
        const stagingRoot = path.join(pythonCacheDirectory, `runtime.installing-${randomUUID()}`);
        const backupRoot = path.join(runtimeParent, `${path.basename(runtimeRoot)}.backup-${randomUUID()}`);
        const hadRuntime = this.directoryHasEntries(runtimeRoot);

        try {
            const didInstallRuntime = await this.installRuntime(pythonVersion, pythonCacheDirectory, stagingRoot);
            if (didInstallRuntime === "skipped") {
                this.lastRuntimeOperationSkipped = true;
                await fs.promises.rm(stagingRoot, { recursive: true, force: true });
                return "skipped";
            }
            const packageResult = await this.installPackageWithManagedDownload(pkg, stagingRoot, true);
            if (packageResult === "skipped") {
                this.lastRuntimeOperationSkipped = true;
                await fs.promises.rm(stagingRoot, { recursive: true, force: true });
                return "skipped";
            }
            await this.replaceRuntime(stagingRoot, runtimeRoot, backupRoot, hadRuntime, mutationKind);
            return "completed";
        } catch (error) {
            await this.removeRuntimeSwapPathBestEffort(stagingRoot);
            if (fs.existsSync(backupRoot)) {
                await this.restoreRuntimeBackup(backupRoot, runtimeRoot, hadRuntime);
            }
            throw error;
        }
    }

    private async installPackageWithPreparedFileTransaction(
        pkg: PackageDownloadInfo,
        runtimeRoot: string,
        upgrade: boolean,
    ): Promise<RuntimeInstallResult> {
        const stagingParent = AppPaths.packageDownloadCacheDirectory();
        await fs.promises.mkdir(stagingParent, { recursive: true });
        const stagingRoot = path.join(stagingParent, `runtime.installing-${randomUUID()}`);

        try {
            await this.emitBootstrapStage(
                PackageInstallStageTitle,
                "Preparing package files in the background.",
                runtimeStepStart("installPackage"),
                false,
                undefined,
                undefined,
            );
            await this.copyRuntimePathForRuntimeSwap(runtimeRoot, stagingRoot);
            const result = await this.installPackageWithManagedDownload(pkg, stagingRoot, upgrade);
            if (result === "skipped") {
                this.lastRuntimeOperationSkipped = true;
                await this.removeRuntimeSwapPathBestEffort(stagingRoot);
                return "skipped";
            }
            await this.assertInstalledPackageVersion(stagingRoot, pkg.version);
            await this.replacePackageFilesFromPreparedRuntime(stagingRoot, runtimeRoot, pkg.version);
            return "completed";
        } catch (error) {
            await this.removeRuntimeSwapPathBestEffort(stagingRoot);
            throw error;
        }
    }

    private async replacePackageFilesFromPreparedRuntime(
        stagedRuntime: string,
        runtimeRoot: string,
        expectedPackageVersion: string,
    ): Promise<void> {
        const packageNames = await this.packageReplacementNamesFromPreparedRuntime(
            stagedRuntime,
            runtimeRoot,
            expectedPackageVersion,
        );
        if (packageNames.length === 0) {
            await this.assertInstalledPackageVersion(runtimeRoot, expectedPackageVersion);
            await this.removeRuntimeSwapPathBestEffort(stagedRuntime);
            await this.emitBootstrapStage(
                "Label Studio Installed",
                "Installed package files already match the prepared runtime.",
                runtimeStepEnd("installPackage"),
                false,
                undefined,
                undefined,
            );
            return;
        }

        await this.prepareForManagedRuntimeMutation("package");
        await this.emitPackageFileReplacementStage("Installing prepared package files into the active runtime.", 0);
        try {
            this.assertDirectoryWritable(runtimeRoot, "install Python packages");
        } catch (error) {
            if (!(error instanceof WindowsRuntimeElevationRequiredError) && !(error instanceof LinuxRuntimeElevationRequiredError)) throw error;
            await this.emitPackageFileReplacementStage(
                "Waiting for administrator permission to install the prepared package files.",
                0,
            );
            const finalizer = await runPlatformPackageReplacement({
                stagedRuntime,
                runtimeRoot,
                packageNames,
            }, progress => {
                const count = progress.totalEntries > 0
                    ? `${Math.min(progress.completedEntries, progress.totalEntries)}/${progress.totalEntries}`
                    : `${progress.completedEntries}`;
                const detail = progress.phase === "backup"
                    ? "Backing up currently installed package files."
                    : progress.phase === "complete"
                        ? "The prepared package files are installed."
                        : `Installing prepared package files in the background (${count}).`;
                void this.emitPackageFileReplacementStage(
                    detail,
                    runtimeReplacementMainProgressFraction(
                        progress.phase,
                        progress.completedEntries,
                        progress.totalEntries,
                    ),
                );
            });
            if (finalizer) this.adoptPendingRuntimeReplacementFinalizer(finalizer);
            await this.removeRuntimeSwapPathBestEffort(stagedRuntime);
            await this.emitPackageFileReplacementStage("The prepared package files are installed.", 1);
            return;
        }

        const finalizer = await this.applyPackageFilesLocally(stagedRuntime, runtimeRoot, packageNames);
        if (finalizer) this.adoptPendingRuntimeReplacementFinalizer(finalizer);
        await this.removeRuntimeSwapPathBestEffort(stagedRuntime);
        await this.emitPackageFileReplacementStage("The prepared package files are installed.", 1);
    }

    private async packageReplacementNamesFromPreparedRuntime(
        stagedRuntime: string,
        runtimeRoot: string,
        expectedPackageVersion: string,
    ): Promise<string[]> {
        const retainedRuntimeTools = new Set(["pip", "setuptools", "wheel"]);
        // Base the replacement set on the metadata files that will actually be
        // copied. This enumerates only direct site-packages children, not the
        // runtime tree.
        const staged = await this.readInstalledPythonDistributionsFromFilesystem(stagedRuntime);
        const active = await this.readInstalledPythonDistributionsFromFilesystem(runtimeRoot);
        const stagedPackageVersions = staged.get("label-studio")?.map((distribution) => distribution.version) ?? [];
        if (!stagedPackageVersions.includes(expectedPackageVersion)) {
            throw new Error(
                `The prepared runtime does not contain the requested Label Studio version ${expectedPackageVersion}.`,
            );
        }
        const names = new Set<string>();
        for (const name of staged.keys()) {
            if (!retainedRuntimeTools.has(name)) names.add(name);
        }
        for (const name of active.keys()) {
            if (!retainedRuntimeTools.has(name)) names.add(name);
        }

        const replacements = [...names]
            .filter((name) =>
                this.installedDistributionVersionSignature(staged.get(name) ?? [])
                !== this.installedDistributionVersionSignature(active.get(name) ?? []))
            .sort((left, right) => left.localeCompare(right));
        this.appendRuntimeBootstrapDiagnostic(
            `Package replacement comparison completed. expected=${expectedPackageVersion} `
            + `stagedLabelStudio=${this.installedDistributionVersionSignature(staged.get("label-studio") ?? []) || "missing"} `
            + `activeLabelStudio=${this.installedDistributionVersionSignature(active.get("label-studio") ?? []) || "missing"} `
            + `replacementCount=${replacements.length}`,
        );
        return replacements;
    }

    private installedDistributionVersionSignature(distributions: InstalledPythonDistribution[]): string {
        return distributions
            .map((distribution) => distribution.version)
            .sort((left, right) => this.comparePackageVersions(left, right))
            .join("\u0000");
    }

    private async applyPackageFilesLocally(
        stagedRuntime: string,
        runtimeRoot: string,
        packageNames: Iterable<string>,
    ): Promise<ManagedRuntimeReplacementFinalizer | undefined> {
        const backupRoot = path.join(AppPaths.packageDownloadCacheDirectory(), `package.backup-${randomUUID()}`);
        const normalizedNames = new Set([...packageNames].map((name) => this.normalizePackageName(name)).filter(Boolean));
        let applied = false;
        try {
            await this.backupActivePackageFiles(runtimeRoot, normalizedNames, backupRoot);
            await this.removeActivePackageFiles(runtimeRoot, normalizedNames);
            await this.copyPreparedPackageFiles(stagedRuntime, runtimeRoot, normalizedNames);
            applied = true;
            return {
                commit: async () => {
                    await fs.promises.rm(backupRoot, { recursive: true, force: true });
                },
                rollback: async () => {
                    await this.rollbackLocalPackageFiles(runtimeRoot, normalizedNames, backupRoot);
                },
            };
        } catch (error) {
            if (!applied) {
                await this.rollbackLocalPackageFiles(runtimeRoot, normalizedNames, backupRoot).catch((rollbackError) => {
                    const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                    this.appendRecentOutput(`Package file rollback failed: ${detail}`);
                });
            }
            throw error;
        }
    }

    private async backupActivePackageFiles(
        runtimeRoot: string,
        packageNames: Set<string>,
        backupRoot: string,
    ): Promise<void> {
        await fs.promises.rm(backupRoot, { recursive: true, force: true });
        const installed = await this.readInstalledPythonDistributions(runtimeRoot);
        const seen = new Set<string>();
        for (const name of packageNames) {
            for (const distribution of installed.get(name) ?? []) {
                await this.copyRuntimeRelativePaths(
                    runtimeRoot,
                    backupRoot,
                    await this.packageDistributionPaths(distribution, runtimeRoot),
                    seen,
                );
            }
        }
    }

    private async removeActivePackageFiles(
        runtimeRoot: string,
        packageNames: Set<string>,
    ): Promise<void> {
        const installed = await this.readInstalledPythonDistributions(runtimeRoot);
        const protectedPaths = new Set<string>();
        for (const [name, distributions] of installed) {
            if (packageNames.has(name)) continue;
            for (const distribution of distributions) {
                for (const filePath of await this.installedDistributionRecordPaths(distribution, runtimeRoot)) {
                    protectedPaths.add(await this.filesystemPathIdentity(filePath));
                }
            }
        }
        for (const name of packageNames) {
            for (const distribution of installed.get(name) ?? []) {
                await this.removeInstalledDistributionRecordFiles(
                    distribution,
                    await this.installedDistributionRecordPaths(distribution, runtimeRoot),
                    protectedPaths,
                );
            }
        }
    }

    private async copyPreparedPackageFiles(
        stagedRuntime: string,
        runtimeRoot: string,
        packageNames: Set<string>,
    ): Promise<void> {
        const staged = await this.readInstalledPythonDistributions(stagedRuntime);
        const seen = new Set<string>();
        for (const name of packageNames) {
            for (const distribution of staged.get(name) ?? []) {
                await this.copyRuntimeRelativePaths(
                    stagedRuntime,
                    runtimeRoot,
                    await this.packageDistributionPaths(distribution, stagedRuntime),
                    seen,
                );
            }
        }
    }

    private async rollbackLocalPackageFiles(
        runtimeRoot: string,
        packageNames: Set<string>,
        backupRoot: string,
    ): Promise<void> {
        await this.removeActivePackageFiles(runtimeRoot, packageNames);
        if (fs.existsSync(backupRoot)) {
            await this.copyTreeContents(backupRoot, runtimeRoot);
            await fs.promises.rm(backupRoot, { recursive: true, force: true });
        }
        this.updateService.invalidateVersionCache();
    }

    private async packageDistributionPaths(
        distribution: InstalledPythonDistribution,
        runtimeRoot: string,
    ): Promise<string[]> {
        const paths = new Map<string, string>();
        const add = async (filePath: string): Promise<void> => {
            if (!this.pathIsWithin(runtimeRoot, filePath) || path.resolve(filePath) === path.resolve(runtimeRoot)) return;
            paths.set(await this.filesystemPathIdentity(filePath), filePath);
        };
        await add(distribution.distInfoPath);
        for (const filePath of await this.installedDistributionRecordPaths(distribution, runtimeRoot)) {
            await add(filePath);
        }
        return [...paths.values()];
    }

    private async copyRuntimeRelativePaths(
        sourceRoot: string,
        targetRoot: string,
        sourcePaths: string[],
        seenTargets: Set<string>,
    ): Promise<void> {
        for (const sourcePath of sourcePaths) {
            let stat: fs.Stats;
            try {
                stat = await fs.promises.lstat(sourcePath);
            } catch (error) {
                if (this.fileSystemErrorCode(error) === "ENOENT") continue;
                throw error;
            }
            const relative = path.relative(sourceRoot, sourcePath);
            const targetPath = this.safePathWithin(targetRoot, relative);
            if (!relative || !targetPath) continue;
            const targetIdentity = await this.filesystemPathIdentity(targetPath);
            if (seenTargets.has(targetIdentity)) continue;
            seenTargets.add(targetIdentity);
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
                await fs.promises.cp(sourcePath, targetPath, { recursive: true, force: true, verbatimSymlinks: true });
            } else {
                await fs.promises.cp(sourcePath, targetPath, { force: true, verbatimSymlinks: true });
            }
        }
    }

    private async copyTreeContents(sourceRoot: string, targetRoot: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true });
        } catch (error) {
            if (this.fileSystemErrorCode(error) === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            const sourcePath = path.join(sourceRoot, entry.name);
            const targetPath = path.join(targetRoot, entry.name);
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.promises.cp(sourcePath, targetPath, { recursive: true, force: true, verbatimSymlinks: true });
        }
    }

    private async emitPackageFileReplacementStage(detail: string, fraction: number): Promise<void> {
        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            detail,
            runtimeStepProgress("installPackage", 0.9 + 0.1 * clamp01(fraction)),
            false,
            undefined,
            undefined,
            fraction,
            "Applying Package",
        );
    }

    private async replaceRuntime(
        stagedRuntime: string,
        runtimeRoot: string,
        backupRoot: string,
        hadRuntime: boolean,
        mutationKind: ManagedRuntimeMutationKind = "python",
    ): Promise<void> {
        await this.waitForDownloadResume();
        if (this.downloadSkipRequested) throw new ManagedRuntimeMutationCancelledError();
        await this.prepareForManagedRuntimeMutation(mutationKind);
        await this.emitRuntimeReplacementStage(
            "Preparing to replace the managed Python runtime.",
            0,
        );
        try {
            this.assertDirectoryWritable(path.dirname(runtimeRoot), "replace the managed Python runtime");
        } catch (error) {
            if (!(error instanceof WindowsRuntimeElevationRequiredError) && !(error instanceof LinuxRuntimeElevationRequiredError)) throw error;
            await this.emitRuntimeReplacementStage(
                "All downloads are complete. Waiting for administrator permission to replace the prepared runtime files.",
                0,
            );
            const finalizer = await runPlatformRuntimeReplacement({ stagedRuntime, runtimeRoot }, progress => {
                const count = progress.totalEntries > 0
                    ? `${Math.min(progress.completedEntries, progress.totalEntries)}/${progress.totalEntries}`
                    : `${progress.completedEntries}`;
                const detail = progress.phase === "activate"
                    ? "Activating the prepared runtime files."
                    : progress.phase === "complete"
                        ? "The prepared runtime files are installed."
                        : `Installing prepared runtime files in the background (${count}).`;
                void this.emitRuntimeReplacementStage(
                    detail,
                    runtimeReplacementMainProgressFraction(
                        progress.phase,
                        progress.completedEntries,
                        progress.totalEntries,
                    ),
                );
            });
            if (finalizer) this.adoptPendingRuntimeReplacementFinalizer(finalizer);
            await this.removeRuntimeSwapPathBestEffort(stagedRuntime);
            await this.emitRuntimeReplacementStage(
                "The prepared runtime files are installed.",
                1,
            );
            return;
        }

        if (!hadRuntime) {
            await this.removePathForRuntimeSwap(runtimeRoot);
            await this.emitRuntimeReplacementStage(
                "The runtime destination is ready.",
                1 / RuntimeReplacementFixedDetailStepCount,
            );
            await this.activateRuntimePath(stagedRuntime, runtimeRoot);
            await this.emitRuntimeReplacementStage(
                "The prepared runtime files are active.",
                2 / RuntimeReplacementFixedDetailStepCount,
            );
            await this.emitRuntimeReplacementStage("The prepared runtime files are installed.", 1);
            return;
        }

        const pendingReplacement = this.pendingRuntimeReplacement;
        if (pendingReplacement) {
            if (path.resolve(pendingReplacement.runtimeRoot) !== path.resolve(runtimeRoot)) {
                throw new Error("A different managed runtime replacement is already waiting for startup validation.");
            }
            await this.removePathForRuntimeSwap(runtimeRoot);
            await this.emitRuntimeReplacementStage(
                "The previous pending runtime is ready to be replaced.",
                1 / RuntimeReplacementFixedDetailStepCount,
            );
            await this.activateRuntimePath(stagedRuntime, runtimeRoot);
            await this.emitRuntimeReplacementStage(
                "The prepared runtime files are active.",
                2 / RuntimeReplacementFixedDetailStepCount,
            );
            await this.emitRuntimeReplacementStage("The prepared runtime files are installed.", 1);
            return;
        }

        await this.removePathForRuntimeSwap(backupRoot);
        await this.emitRuntimeReplacementStage("Preparing the runtime backup location.", 0.25);
        await this.renamePathForRuntimeSwap(runtimeRoot, backupRoot, "backup existing managed Python runtime");
        await this.emitRuntimeReplacementStage("The previous runtime is backed up.", 0.5);
        try {
            await this.activateRuntimePath(stagedRuntime, runtimeRoot);
            await this.emitRuntimeReplacementStage("The prepared runtime files are active.", 0.75);
            this.pendingRuntimeReplacement = { runtimeRoot, backupRoot, hadRuntime: true };
            await this.emitRuntimeReplacementStage("The prepared runtime files are installed.", 1);
        } catch (error) {
            if (!fs.existsSync(runtimeRoot) && fs.existsSync(backupRoot)) {
                await this.renamePathForRuntimeSwap(backupRoot, runtimeRoot, "restore managed Python runtime backup");
            }
            throw error;
        }
    }

    private async emitRuntimeReplacementStage(detail: string, fraction: number): Promise<void> {
        await this.emitBootstrapStage(
            "Installing Runtime",
            detail,
            runtimeStepProgress("applyRuntime", fraction),
            false,
            undefined,
            undefined,
            fraction,
            RuntimeReplacementProgressStep,
        );
    }

    // The Linux privileged entry point only accepts a prepared local tree. It
    // never calls ensureRuntime, the dependency resolver, pip, or a downloader.
    async applyPreparedRuntimeReplacement(plan: PreparedRuntimeReplacement): Promise<void> {
        if (path.resolve(plan.runtimeRoot) !== path.resolve(AppPaths.bundledRuntimeRoot())) {
            throw new Error("The runtime replacement target does not belong to this application.");
        }
        const relative = path.relative(plan.runtimeRoot, plan.stagedRuntime);
        if (!path.isAbsolute(plan.stagedRuntime) || !relative.startsWith(`..${path.sep}`) || !this.directoryHasEntries(plan.stagedRuntime)) {
            throw new Error("The prepared runtime must be a nonempty directory outside the installed runtime.");
        }
        const backupRoot = `${plan.runtimeRoot}.backup-${randomUUID()}`;
        this.assertDirectoryWritable(path.dirname(plan.runtimeRoot), "replace prepared runtime files");
        await this.withRuntimeMutationLock(async () => {
            await this.replaceRuntime(plan.stagedRuntime, plan.runtimeRoot, backupRoot, this.directoryHasEntries(plan.runtimeRoot));
        });
    }

    async applyPreparedPackageReplacement(plan: PreparedPackageReplacement): Promise<void> {
        if (path.resolve(plan.runtimeRoot) !== path.resolve(AppPaths.bundledRuntimeRoot())) {
            throw new Error("The package replacement target does not belong to this application.");
        }
        const relative = path.relative(plan.runtimeRoot, plan.stagedRuntime);
        if (!path.isAbsolute(plan.stagedRuntime) || !relative.startsWith(`..${path.sep}`) || !this.directoryHasEntries(plan.stagedRuntime)) {
            throw new Error("The prepared package source must be a nonempty runtime directory outside the installed runtime.");
        }
        const packageNames = plan.packageNames
            .map((name) => this.normalizePackageName(name))
            .filter(Boolean);
        if (packageNames.length === 0) throw new Error("No package names were provided for package replacement.");
        this.assertDirectoryWritable(plan.runtimeRoot, "install prepared Python package files");
        await this.withRuntimeMutationLock(async () => {
            const finalizer = await this.applyPackageFilesLocally(
                plan.stagedRuntime,
                plan.runtimeRoot,
                new Set(packageNames),
            );
            if (finalizer) this.adoptPendingRuntimeReplacementFinalizer(finalizer);
        });
    }

    private async restoreRuntimeBackup(backupRoot: string, runtimeRoot: string, hadRuntime: boolean): Promise<void> {
        if (!hadRuntime) return;
        if (!fs.existsSync(backupRoot)) return;
        await this.removePathForRuntimeSwap(runtimeRoot);
        await this.renamePathForRuntimeSwap(backupRoot, runtimeRoot, "restore managed Python runtime backup");
        if (this.pendingRuntimeReplacement?.backupRoot === backupRoot) this.pendingRuntimeReplacement = undefined;
        this.updateService.invalidateVersionCache();
    }

    private async commitPendingRuntimeReplacementUnlocked(): Promise<void> {
        const pending = this.pendingRuntimeReplacement;
        if (!pending) return;
        await this.removePathForRuntimeSwap(pending.backupRoot);
        this.pendingRuntimeReplacement = undefined;
        this.updateService.invalidateVersionCache();
    }

    private async rollbackPendingRuntimeReplacementUnlocked(): Promise<void> {
        const pending = this.pendingRuntimeReplacement;
        if (!pending) return;
        await this.restoreRuntimeBackup(pending.backupRoot, pending.runtimeRoot, pending.hadRuntime);
    }

    private async activateRuntimePath(stagedRuntime: string, runtimeRoot: string): Promise<void> {
        try {
            await this.renamePathForRuntimeSwap(stagedRuntime, runtimeRoot, "activate managed Python runtime");
        } catch (renameError) {
            const renameCode = renameError instanceof Error && "code" in renameError
                ? String((renameError as NodeJS.ErrnoException).code ?? "")
                : "";
            if (process.platform !== "win32" && renameCode !== "EXDEV") throw renameError;

            try {
                await this.copyRuntimePathForRuntimeSwap(stagedRuntime, runtimeRoot);
                await this.removeRuntimeSwapPathBestEffort(stagedRuntime);
            } catch (copyError) {
                const renameDetail = renameError instanceof Error ? renameError.message : String(renameError);
                const copyDetail = copyError instanceof Error ? copyError.message : String(copyError);
                throw new Error(
                    `The managed Python runtime could not be activated by rename or copy.\n\nRename failed:\n${renameDetail}\n\nCopy failed:\n${copyDetail}`,
                );
            }
        }
    }

    private async removePathForRuntimeSwap(targetPath: string): Promise<void> {
        await this.runWindowsTransientFileSystemOperation(
            `remove ${targetPath}`,
            async () => await fs.promises.rm(targetPath, { recursive: true, force: true }),
        );
    }

    private async copyRuntimePathForRuntimeSwap(sourcePath: string, targetPath: string): Promise<void> {
        await this.removePathForRuntimeSwap(targetPath);
        await this.runWindowsTransientFileSystemOperation(
            `copy ${sourcePath} -> ${targetPath}`,
            async () => await fs.promises.cp(sourcePath, targetPath, { recursive: true, force: true, verbatimSymlinks: true }),
        );
    }

    private async removeRuntimeSwapPathBestEffort(targetPath: string): Promise<void> {
        try {
            await this.removePathForRuntimeSwap(targetPath);
        } catch (error) {
            this.appendRecentOutput(`Failed to clean runtime swap path ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async terminateStaleWindowsRuntimeProcesses(runtimeRoot: string): Promise<void> {
        if (process.platform !== "win32") return;

        let installerExecutable: string;
        try {
            installerExecutable = AppPaths.windowsInstallerExecutable();
        } catch (error) {
            throw new Error(`Windows could not locate the managed runtime process terminator.\n\n${error instanceof Error ? error.message : String(error)}`);
        }
        if (!fs.existsSync(installerExecutable)) {
            throw new Error(`Windows could not locate the managed runtime process terminator: ${installerExecutable}`);
        }

        await new Promise<void>((resolve, reject) => {
            const child = spawn(installerExecutable, [
                "--terminate-managed-runtime-processes",
                "--runtime-root",
                runtimeRoot,
            ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
            let errorOutput = "";
            child.stderr.on("data", chunk => { errorOutput += Buffer.from(chunk).toString("utf8"); });
            let settled = false;
            child.once("error", error => {
                if (settled) return;
                settled = true;
                reject(error);
            });
            child.once("close", status => {
                if (settled) return;
                settled = true;
                if (status === 0) resolve();
                else reject(new Error(
                    `Windows could not stop a process that is using the managed Python runtime.\n\n`
                    + (errorOutput.trim() || `status ${status ?? "unknown"}`),
                ));
            });
        });
    }

    private async renamePathForRuntimeSwap(sourcePath: string, targetPath: string, purpose: string): Promise<void> {
        await this.runWindowsTransientFileSystemOperation(
            `${purpose}: ${sourcePath} -> ${targetPath}`,
            async () => await fs.promises.rename(sourcePath, targetPath),
            async () => await this.terminateStaleWindowsRuntimeProcesses(sourcePath),
        );
    }

    private async runWindowsTransientFileSystemOperation(
        label: string,
        operation: () => void | Promise<void>,
        recoverAfterFailure?: () => void | Promise<void>,
    ): Promise<void> {
        const retryDelays = process.platform === "win32"
            ? [0, 100, 250, 500, 1000, 2000, 4000, 8000, 12000]
            : [0];
        let lastError: unknown;

        let recovered = false;
        for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
            const delayMs = retryDelays[attempt];
            if (delayMs > 0) await this.delay(delayMs);

            try {
                await operation();
                return;
            } catch (error) {
                lastError = error;
                if (process.platform !== "win32" || !this.isTransientWindowsFileSystemError(error)) {
                    throw error;
                }
                if (!recovered && recoverAfterFailure) {
                    recovered = true;
                    await recoverAfterFailure();
                }
            }
        }

        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`Windows could not ${label} after retrying transient filesystem errors.\n\n${detail}`);
    }

    private isTransientWindowsFileSystemError(error: unknown): boolean {
        if (!error || typeof error !== "object") return false;
        const code = "code" in error ? String((error as { code?: unknown }).code) : "";
        return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
    }

    private async delay(ms: number): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }

    private async yieldToEventLoop(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    private async pathExists(targetPath: string): Promise<boolean> {
        try {
            await fs.promises.access(targetPath);
            return true;
        } catch {
            return false;
        }
    }

    private assertDirectoryWritable(directory: string, purpose: string): void {
        try {
            fs.mkdirSync(directory, { recursive: true });
            const probe = path.join(directory, `.label-studio-write-test-${process.pid}-${randomUUID()}`);
            fs.mkdirSync(probe);
            fs.rmSync(probe, { recursive: true, force: true });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (app.isPackaged && process.platform === "win32") {
                throw new WindowsRuntimeElevationRequiredError(directory, purpose, detail);
            }
            if (app.isPackaged && process.platform === "linux") {
                throw new LinuxRuntimeElevationRequiredError(directory, purpose, detail);
            }
            throw error;
        }
    }

    private async installRuntime(
        version: string,
        cacheDirectory: string,
        runtimeRoot: string,
    ): Promise<RuntimeInstallResult> {
        if (process.platform !== "darwin") {
            return await this.installAnacondaRuntime(version, cacheDirectory, runtimeRoot);
        }

        const series = this.pythonSeries(version);
        const packageName = await this.pythonPackageName(version);
        const packageUrl = `https://www.python.org/ftp/python/${version}/${packageName}`;
        const packagePath = path.join(cacheDirectory, packageName);
        const expandedDirectory = path.join(cacheDirectory, `python-${version}-expanded`);

        await this.emitBootstrapStage(
            "Downloading Python",
            `Downloading the embedded Python ${version} runtime package.`,
            fs.existsSync(packagePath) ? runtimeStepEnd("downloadPython") : runtimeStepStart("downloadPython"),
            true,
            fs.existsSync(packagePath) ? 1 : 0,
            fs.existsSync(packagePath) ? "Download complete" : "Preparing download",
        );

        if (!fs.existsSync(packagePath)) {
            const result = await this.downloadFile(
                packageUrl,
                packagePath,
                undefined,
                "Downloading Python",
                `Downloading the embedded Python ${version} runtime package.`,
                runtimeStepStart("downloadPython"),
                runtimeStepEnd("downloadPython"),
            );
            if (result === "skipped") {
                await this.emitBootstrapStage(
                    "Runtime Download Skipped",
                    "Using the existing embedded Python runtime.",
                    runtimeStepEnd("downloadPython"),
                    false,
                    undefined,
                    undefined,
                );
                return "skipped";
            }
            await this.emitBootstrapStage(
                "Downloading Python",
                `Downloaded the embedded Python ${version} runtime package.`,
                runtimeStepEnd("downloadPython"),
                true,
                1,
                "Download complete",
            );
        } else {
            await this.emitBootstrapStage(
                "Downloading Python",
                `Using the cached embedded Python ${version} runtime package.`,
                runtimeStepEnd("downloadPython"),
                false,
                undefined,
                undefined,
            );
        }

        await this.emitBootstrapStage(
            "Expanding Runtime",
            "Expanding the official Python installer payload.",
            runtimeStepStart("expandRuntime"),
            false,
            undefined,
            undefined,
        );
        await fs.promises.rm(expandedDirectory, { recursive: true, force: true });
        await this.runLocalProcess("/usr/sbin/pkgutil", ["--expand-full", packagePath, expandedDirectory], AppPaths.projectRoot());
        await this.emitBootstrapStage(
            "Runtime Expanded",
            "The official Python installer payload is expanded.",
            runtimeStepEnd("expandRuntime"),
            false,
            undefined,
            undefined,
        );

        const payloadVersion = path.join(expandedDirectory, "Python_Framework.pkg", "Payload", "Versions", series);
        if (!fs.existsSync(payloadVersion)) {
            throw new Error(`Missing Python installer payload: ${payloadVersion}`);
        }

        this.assertDirectoryWritable(path.dirname(runtimeRoot), "install the managed Python runtime");

        await this.emitBootstrapStage(
            "Installing Runtime",
            "Installing the managed Python runtime for Label Studio.",
            runtimeStepStart("installRuntime"),
            false,
            undefined,
            undefined,
        );
        await fs.promises.rm(runtimeRoot, { recursive: true, force: true });
        const frameworkVersions = path.join(runtimeRoot, "Library", "Frameworks", "Python.framework", "Versions");
        await fs.promises.mkdir(frameworkVersions, { recursive: true });
        await fs.promises.cp(payloadVersion, path.join(frameworkVersions, series), { recursive: true, verbatimSymlinks: true });

        const runtimePythonSource = path.join(frameworkVersions, series, "Resources", "Python.app", "Contents", "MacOS", "Python");
        const runtimePythonTarget = path.join(runtimeRoot, "bin", "Python");
        await fs.promises.mkdir(path.dirname(runtimePythonTarget), { recursive: true });
        await fs.promises.rm(runtimePythonTarget, { force: true });
        await fs.promises.copyFile(runtimePythonSource, runtimePythonTarget);
        await fs.promises.chmod(runtimePythonTarget, 0o755);

        await fs.promises.rm(path.join(frameworkVersions, series, "Resources", "Python.app"), { recursive: true, force: true });

        this.recreateSymlink(path.join(frameworkVersions, "Current"), series);
        const frameworkRoot = path.join(runtimeRoot, "Library", "Frameworks", "Python.framework");
        this.recreateSymlink(path.join(frameworkRoot, "Headers"), "Versions/Current/Headers");
        this.recreateSymlink(path.join(frameworkRoot, "Python"), "Versions/Current/Python");
        this.recreateSymlink(path.join(frameworkRoot, "Resources"), "Versions/Current/Resources");
        this.recreateSymlink(path.join(runtimeRoot, "bin", `python${series}`), `../Library/Frameworks/Python.framework/Versions/${series}/bin/python${series}`);
        this.recreateSymlink(path.join(runtimeRoot, "bin", "python3"), `../Library/Frameworks/Python.framework/Versions/${series}/bin/python3`);
        // Do not create a top-level bin/python symlink. On the default macOS
        // case-insensitive filesystem it aliases bin/Python and replaces the
        // copied app entrypoint with the framework symlink.

        await this.repairPythonRuntimeLoadPaths(runtimeRoot);
        await this.signRuntimePython(runtimeRoot);
        if (!(await this.validateRuntime(runtimeRoot))) {
            throw new Error(this.runtimeValidationFailureMessage());
        }
        await this.emitBootstrapStage(
            "Runtime Installed",
            "The managed Python runtime is installed.",
            runtimeStepEnd("installRuntime"),
            false,
            undefined,
            undefined,
        );
        return "completed";
    }

    private async installAnacondaRuntime(
        version: string,
        cacheDirectory: string,
        runtimeRoot: string,
    ): Promise<RuntimeInstallResult> {
        const plan = await this.resolveAnacondaRuntimePackagePlan(version);
        const runtimePackageCacheDirectory = AppPaths.ensureDirectory(path.join(cacheDirectory, "anaconda-main"));
        const allPackagesCached = plan.every((candidate) =>
            fs.existsSync(path.join(runtimePackageCacheDirectory, candidate.subdir, candidate.filename))
        );

        const archivePaths: Array<{ candidate: CondaPackageCandidate; archivePath: string }> = [];

        if (allPackagesCached) {
            for (const candidate of plan) {
                archivePaths.push({
                    candidate,
                    archivePath: path.join(runtimePackageCacheDirectory, candidate.subdir, candidate.filename),
                });
            }
        } else {
            await this.emitBootstrapStage(
                "Downloading Python",
                `Downloading the embedded Python ${version} runtime package.`,
                allPackagesCached ? runtimeStepEnd("downloadPython") : runtimeStepStart("downloadPython"),
                true,
                0,
                allPackagesCached ? "Download complete" : "Preparing download",
            );

            for (let index = 0; index < plan.length; index += 1) {
                const candidate = plan[index];
                archivePaths.push({
                    candidate,
                    archivePath: await this.downloadAnacondaRuntimePackage(candidate, runtimePackageCacheDirectory, index, plan.length),
                });
            }

            await this.emitBootstrapStage(
                "Downloading Python",
                `Downloaded the embedded Python ${version} runtime package.`,
                runtimeStepEnd("downloadPython"),
                true,
                1,
                "Download complete",
            );
        }

        this.assertDirectoryWritable(path.dirname(runtimeRoot), "install the managed Python runtime");
        await this.emitBootstrapStage(
            "Expanding Runtime",
            "Expanding the Python runtime packages.",
            runtimeStepStart("expandRuntime"),
            false,
            undefined,
            undefined,
        );
        await fs.promises.rm(runtimeRoot, { recursive: true, force: true });
        await fs.promises.mkdir(runtimeRoot, { recursive: true });
        for (let index = 0; index < archivePaths.length; index += 1) {
            const item = archivePaths[index];
            await this.extractCondaRuntimePackageArchive(item.candidate, item.archivePath, runtimeRoot, index, archivePaths.length);
        }
        await fs.promises.rm(path.join(runtimeRoot, "info"), { recursive: true, force: true });
        await this.emitBootstrapStage(
            "Runtime Expanded",
            "The Python runtime packages are expanded.",
            runtimeStepEnd("expandRuntime"),
            false,
            undefined,
            undefined,
        );
        await this.emitBootstrapStage(
            "Installing Runtime",
            "Installing the managed Python runtime for Label Studio.",
            runtimeStepStart("installRuntime"),
            false,
            undefined,
            undefined,
        );
        this.prepareAnacondaRuntimeFiles(runtimeRoot);

        if (!(await this.validateRuntime(runtimeRoot))) {
            throw new Error(this.runtimeValidationFailureMessage());
        }
        await this.emitBootstrapStage(
            "Runtime Installed",
            "The managed Python runtime is installed.",
            runtimeStepEnd("installRuntime"),
            false,
            undefined,
            undefined,
        );
        return "completed";
    }

    private async resolveAnacondaRuntimePackagePlan(version: string): Promise<CondaPackageCandidate[]> {
        const platformSubdir = this.anacondaRuntimePlatformSubdir();
        const subdirs = platformSubdir === "noarch" ? ["noarch"] : [platformSubdir, "noarch"];
        const selected = new Map<string, CondaPackageCandidate>();
        const visiting = new Set<string>();
        const ordered: CondaPackageCandidate[] = [];

        await this.resolveAnacondaRuntimePackageRecursive(
            { name: "python", constraints: `==${version}` },
            subdirs,
            version,
            selected,
            visiting,
            ordered,
        );

        return ordered;
    }

    private async resolveAnacondaRuntimePackageRecursive(
        spec: CondaDependencySpec,
        subdirs: string[],
        pythonVersion: string,
        selected: Map<string, CondaPackageCandidate>,
        visiting: Set<string>,
        ordered: CondaPackageCandidate[],
    ): Promise<void> {
        const normalizedName = this.normalizePackageName(spec.name);
        if (normalizedName.startsWith("__")) return;

        const existing = selected.get(normalizedName);
        if (existing) {
            if (!this.condaVersionSatisfiesConstraints(existing.version, spec.constraints)) {
                throw new Error(`Conflicting Python runtime package constraints for ${normalizedName}: selected ${existing.version}, required ${spec.constraints}.`);
            }
            return;
        }

        if (visiting.has(normalizedName)) return;
        visiting.add(normalizedName);

        const candidate = await this.findAnacondaRuntimePackageCandidate(normalizedName, spec.constraints, subdirs, pythonVersion);
        for (const dependency of candidate.depends) {
            const dependencySpec = this.parseCondaDependency(dependency);
            if (!dependencySpec || dependencySpec.name.startsWith("__")) continue;
            await this.resolveAnacondaRuntimePackageRecursive(dependencySpec, subdirs, pythonVersion, selected, visiting, ordered);
        }

        visiting.delete(normalizedName);
        selected.set(normalizedName, candidate);
        ordered.push(candidate);
    }

    private async findAnacondaRuntimePackageCandidate(
        name: string,
        constraints: string,
        subdirs: string[],
        pythonVersion: string,
    ): Promise<CondaPackageCandidate> {
        const normalizedName = this.normalizePackageName(name);
        for (const subdir of subdirs) {
            const repodata = await this.anacondaMainRepodata(subdir);
            const indexedRecords = await repodata.packageRecords(normalizedName);
            const candidates: CondaPackageCandidate[] = [];
            for (let index = 0; index < indexedRecords.length; index += 1) {
                const record = indexedRecords[index];
                if (!record) continue;
                const candidate = this.anacondaRuntimePackageCandidateFromRecord(record.filename, subdir, record);
                if (
                    candidate
                    && this.condaVersionSatisfiesConstraints(candidate.version, constraints)
                    && this.condaPackageMatchesPython(candidate, pythonVersion)
                ) {
                    candidates.push(candidate);
                }
                if ((index + 1) % 500 === 0) await this.yieldToEventLoop();
            }
            candidates.sort((left, right) => {
                const versionCompare = this.compareVersionNumbers(right.version, left.version);
                if (versionCompare !== 0) return versionCompare;
                return right.buildNumber - left.buildNumber;
            });

            const chosen = candidates[0];
            if (chosen) return chosen;
        }

        throw new Error(`Unable to find Python runtime package ${name}${constraints ? ` ${constraints}` : ""} for ${process.platform}-${process.arch}.`);
    }

    private anacondaRuntimePackageCandidateFromRecord(
        filename: string,
        subdir: string,
        record: CondaPackageRecord,
    ): CondaPackageCandidate | undefined {
        if (!record.name || !record.version) return undefined;
        return {
            name: record.name,
            version: record.version,
            filename,
            subdir,
            url: new URL(`${subdir}/${filename}`, AnacondaPkgsMainBaseUrl).toString(),
            fallbackUrls: [new URL(`${subdir}/${filename}`, TunaAnacondaPkgsMainBaseUrl).toString()],
            size: record.size,
            depends: record.depends ?? [],
            buildNumber: record.build_number ?? 0,
        };
    }

    private async downloadAnacondaRuntimePackage(
        candidate: CondaPackageCandidate,
        cacheDirectory: string,
        index: number,
        total: number,
    ): Promise<string> {
        const packageDirectory = AppPaths.ensureDirectory(path.join(cacheDirectory, candidate.subdir));
        const archivePath = path.join(packageDirectory, candidate.filename);
        const progressStart = runtimeStepProgress("downloadPython", total > 0 ? index / total : 0);
        const progressEnd = runtimeStepProgress("downloadPython", total > 0 ? (index + 1) / total : 1);
        const mainProgressEnd = total > 0 ? (index + 1) / total : 1;

        if ((await this.waitForDownloadResume()) === "skipped") {
            throw new Error(`Python runtime package download was cancelled before ${candidate.name} was available.`);
        }

        if (fs.existsSync(archivePath)) {
            await this.emitBootstrapStage(
                "Downloading Python",
                `Using cached ${candidate.name} ${candidate.version}.`,
                progressEnd,
                true,
                1,
                candidate.size
                    ? `${this.formatByteCount(candidate.size)} / ${this.formatByteCount(candidate.size)}`
                    : "Using cached package file",
                mainProgressEnd,
            );
            return archivePath;
        }

        const result = await this.downloadFileWithFallback(
            [candidate.url, ...candidate.fallbackUrls],
            archivePath,
            candidate.size,
            "Downloading Python",
            `Downloading ${candidate.name} ${candidate.version}.`,
            progressStart,
            progressEnd,
            (progress) => total > 0 ? (index + clamp01(progress.fraction)) / total : progress.fraction,
        );
        if (result === "skipped") {
            throw new Error(`Python runtime package download was cancelled before ${candidate.name} was available.`);
        }
        return archivePath;
    }

    private async extractCondaRuntimePackageArchive(
        candidate: CondaPackageCandidate,
        archivePath: string,
        runtimeRoot: string,
        index: number,
        total: number,
    ): Promise<void> {
        const progressStart = runtimeStepProgress("expandRuntime", total > 0 ? index / total : 0);
        const progressEnd = runtimeStepProgress("expandRuntime", total > 0 ? (index + 1) / total : 1);

        await this.emitBootstrapStage(
            "Expanding Runtime",
            `Expanding ${candidate.name} ${candidate.version}.`,
            progressStart,
            false,
            undefined,
            undefined,
        );

        await this.extractCondaTarBz2Archive(archivePath, runtimeRoot, fraction => {
            const progress = progressStart + (progressEnd - progressStart) * fraction;
            void this.emitBootstrapStage(
                "Expanding Runtime",
                `Expanding ${candidate.name} ${candidate.version}.`,
                progress,
                false,
                undefined,
                undefined,
            );
        });

        await this.emitBootstrapStage(
            "Expanding Runtime",
            `Expanded ${candidate.name} ${candidate.version}.`,
            progressEnd,
            false,
            undefined,
            undefined,
        );
    }

    private async extractCondaTarBz2Archive(
        archivePath: string,
        destinationRoot: string,
        onProgress?: (fraction: number) => void,
    ): Promise<void> {
        await fs.promises.mkdir(destinationRoot, { recursive: true });
        const archiveSize = (await fs.promises.stat(archivePath)).size;
        this.appendRuntimeBootstrapDiagnostic(
            `Archive extraction started. archive=${archivePath} bytes=${archiveSize} destination=${destinationRoot} extractor=${process.platform === "win32" ? "embedded-bzip2-tar" : "system-tar"}`,
        );

        try {
            if (process.platform === "win32") {
                await extractCondaTarBz2InBackground(
                    archivePath,
                    destinationRoot,
                    this.activeRuntimeOperationAbortController?.signal,
                    onProgress,
                );
            } else {
                await this.runLocalProcess(
                    "tar",
                    ["-xjf", archivePath, "-C", destinationRoot],
                    AppPaths.projectRoot(),
                );
            }
        } catch (error) {
            this.appendRuntimeBootstrapDiagnostic(
                `Archive extraction failed. archive=${archivePath}\n${error instanceof Error ? error.stack || error.message : String(error)}`,
            );
            throw error;
        }

        this.appendRuntimeBootstrapDiagnostic(`Archive extraction completed. archive=${archivePath}`);
        await fs.promises.rm(path.join(destinationRoot, "info"), { recursive: true, force: true });
    }

    private appendRuntimeBootstrapDiagnostic(message: string): void {
        try {
            const logPath = AppPaths.runtimeBootstrapLogFile();
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
        } catch {
            // Logging is diagnostic only and must never affect extraction.
        }
    }

    private prepareAnacondaRuntimeFiles(runtimeRoot: string): void {
        const runtimePython = this.runtimePython(runtimeRoot);
        if (!fs.existsSync(runtimePython)) {
            throw new Error(`Missing Python runtime executable after install: ${runtimePython}`);
        }
        try { fs.chmodSync(runtimePython, 0o755); } catch { /* ignore */ }
    }

    private recreateSymlink(linkPath: string, destination: string): void {
        fs.rmSync(linkPath, { force: true, recursive: true });
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        fs.symlinkSync(destination, linkPath);
    }

    private async signRuntimePython(runtimeRoot: string): Promise<void> {
        await this.signMachOFile(this.runtimePython(runtimeRoot));
    }

    private async signMachOFile(file: string): Promise<void> {
        if (process.platform !== "darwin") return;
        if (!fs.existsSync(file)) return;
        try {
            // Swift parity: first remove any existing signature with allowFailure=true,
            // then apply an ad-hoc signature.  The remove step matters for official
            // python.org payloads that may carry a signature copied out of Python.app.
            await this.runLocalProcess("/usr/bin/codesign", ["--remove-signature", file], AppPaths.projectRoot(), true);
            await this.runLocalProcess("/usr/bin/codesign", ["--force", "--sign", "-", file], AppPaths.projectRoot());
        } catch (error) {
            this.appendRecentOutput(`${path.basename(file)} ad-hoc signing skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async repairPythonRuntimeLoadPaths(runtimeRoot: string): Promise<boolean> {
        if (process.platform !== "darwin") return false;
        const series = this.runtimeFrameworkSeries(runtimeRoot);
        if (!series) return false;

        let repaired = false;

        for (const file of await this.runtimeMachOCandidates(runtimeRoot, series)) {
            try {
                const linkedLibraries = await this.runLocalProcess("/usr/bin/otool", ["-L", file], AppPaths.projectRoot(), true);
                const changes = this.runtimeLoadPathChanges(file, linkedLibraries, runtimeRoot, series);
                if (changes.length === 0) continue;

                for (const change of changes) {
                    await this.runLocalProcess(
                        "/usr/bin/install_name_tool",
                        change.kind === "id"
                            ? ["-id", change.to, file]
                            : ["-change", change.from, change.to, file],
                        AppPaths.projectRoot(),
                    );
                }
                await this.signMachOFile(file);
                repaired = true;
            } catch (error) {
                this.appendRecentOutput(`${path.basename(file)} load path repair skipped: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        return repaired;
    }

    private async runtimeMachOCandidates(runtimeRoot: string, series: string): Promise<string[]> {
        const candidates = new Set<string>();
        const frameworkVersionRoot = path.join(runtimeRoot, "Library", "Frameworks", "Python.framework", "Versions", series);
        const add = async (file: string): Promise<void> => {
            try {
                const stat = await fs.promises.stat(file);
                if (stat.isFile()) candidates.add(file);
            } catch { /* ignore */ }
        };
        const walk = async (directory: string): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(directory, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const child = path.join(directory, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    await walk(child);
                    continue;
                }
                if (!entry.isFile()) continue;
                if (await this.isRuntimeMachOCandidate(child)) candidates.add(child);
            }
        };

        await add(this.runtimePython(runtimeRoot));
        await add(path.join(frameworkVersionRoot, "Python"));
        await walk(path.join(frameworkVersionRoot, "bin"));
        await walk(path.join(frameworkVersionRoot, "lib"));
        return [...candidates].sort();
    }

    private async isRuntimeMachOCandidate(file: string): Promise<boolean> {
        const basename = path.basename(file);
        const ext = path.extname(file);
        if (ext === ".so" || ext === ".dylib") return true;
        if (basename === "Python") return true;
        if (/^python\d+(?:\.\d+)?$/.test(basename)) return true;

        try {
            const stat = await fs.promises.stat(file);
            return (stat.mode & 0o111) !== 0 && file.includes(`${path.sep}bin${path.sep}`);
        } catch {
            return false;
        }
    }

    private runtimeLoadPathChanges(
        file: string,
        otoolOutput: string,
        runtimeRoot: string,
        series: string,
    ): { kind: "change" | "id"; from: string; to: string }[] {
        const absolutePrefix = `/Library/Frameworks/Python.framework/Versions/${series}/`;
        const bundledPrefix = path.join(runtimeRoot, "Library", "Frameworks", "Python.framework", "Versions", series);
        const dependencies = otoolOutput
            .split(/\r?\n/)
            .slice(1)
            .map((line) => line.trim().match(/^(\S+)/)?.[1])
            .filter((value): value is string => Boolean(value));
        const changes: { kind: "change" | "id"; from: string; to: string }[] = [];
        const seen = new Set<string>();

        dependencies.forEach((dependency, index) => {
            if (!dependency.startsWith(absolutePrefix) || seen.has(dependency)) return;
            seen.add(dependency);
            const suffix = dependency.slice(absolutePrefix.length).split("/").filter(Boolean);
            if (suffix.length === 0) return;
            const bundledTarget = path.join(bundledPrefix, ...suffix);
            if (!fs.existsSync(bundledTarget)) return;
            const kind = this.canSetInstallNameId(file) && index === 0 ? "id" : "change";
            changes.push({ kind, from: dependency, to: this.loaderPathReference(file, bundledTarget) });
        });

        return changes;
    }

    private canSetInstallNameId(file: string): boolean {
        const basename = path.basename(file);
        return path.extname(file) === ".dylib" || basename === "Python";
    }

    private loaderPathReference(fromFile: string, targetFile: string): string {
        const relative = path.relative(path.dirname(fromFile), targetFile).split(path.sep).join(path.posix.sep);
        return `@loader_path/${relative || path.basename(targetFile)}`;
    }

    private runtimeFrameworkSeries(runtimeRoot: string): string | undefined {
        const versionsRoot = path.join(runtimeRoot, "Library", "Frameworks", "Python.framework", "Versions");
        const current = path.join(versionsRoot, "Current");

        try {
            const target = fs.readlinkSync(current);
            const name = path.basename(target);
            if (/^\d+\.\d+$/.test(name)) return name;
        } catch { /* fall through */ }

        try {
            return fs.readdirSync(versionsRoot)
                .filter((entry) => /^\d+\.\d+$/.test(entry))
                .sort((left, right) => this.compareVersionNumbers(right, left))[0];
        } catch {
            return undefined;
        }
    }

    private async validateRuntime(runtimeRoot: string): Promise<boolean> {
        const runtimePython = this.runtimePython(runtimeRoot);
        if (!AppPaths.isExecutable(runtimePython)) return false;
        if (await this.runtimeHealthCheck(runtimeRoot)) return true;
        try {
            if (await this.repairPythonRuntimeLoadPaths(runtimeRoot)) {
                await this.signRuntimePython(runtimeRoot);
            }
            return await this.runtimeHealthCheck(runtimeRoot);
        } catch {
            return false;
        }
    }

    private async runtimeHealthCheck(runtimeRoot: string): Promise<boolean> {
        try {
            const output = await this.runRuntimePythonProcess(
                ["-c", "import ssl; import platform; print(platform.python_version())"],
                this.runtimePythonDir(runtimeRoot),
                AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
                true,
            );
            const ok = output.trim().length > 0;
            if (ok) this.lastRuntimeValidationError = "";
            return ok;
        } catch (error) {
            this.lastRuntimeValidationError = error instanceof Error ? error.message : String(error);
            return false;
        }
    }

    private runtimeValidationFailureMessage(): string {
        const detail = this.lastRuntimeValidationError.trim();
        return detail
            ? `The embedded Python runtime was installed but failed validation.\n\n${detail}`
            : "The embedded Python runtime was installed but failed validation.";
    }

    async hasValidRuntime(runtimeRoot = AppPaths.bundledRuntimeRoot()): Promise<boolean> {
        return await this.withRuntimeReadLock(async () => await this.validateRuntime(runtimeRoot));
    }

    async hasUsablePackage(runtimeRoot = AppPaths.bundledRuntimeRoot()): Promise<boolean> {
        return await this.withRuntimeReadLock(async () => await this.packageInstalled(runtimeRoot));
    }

    async packageUpdateRequiresRuntimeReplacement(targetPackageVersion?: string): Promise<boolean> {
        void targetPackageVersion;
        return false;
    }

    private async embeddedPythonSatisfies(requiresPython: string, runtimeRoot: string): Promise<boolean> {
        const version = await this.currentPythonVersion(runtimeRoot).catch(() => "");
        return this.pythonVersionSatisfies(version, requiresPython);
    }

    private async packageInstalled(runtimeRoot: string): Promise<boolean> {
        const version = await this.currentPackageVersion(runtimeRoot).catch(() => "Not installed");
        if (!version || version === "Not installed") return false;
        return await this.labelStudioServerEntrypointAvailable(runtimeRoot);
    }

    private async hasLabelStudioPackageFiles(runtimeRoot: string): Promise<boolean> {
        if (((await this.readInstalledPythonDistributions(runtimeRoot)).get("label-studio")?.length ?? 0) > 0) {
            return true;
        }

        for (const sitePackagesDirectory of this.runtimeSitePackagesDirectories(runtimeRoot)) {
            if (
                await this.pathExists(path.join(sitePackagesDirectory, "label_studio"))
                || await this.pathExists(path.join(sitePackagesDirectory, "label_studio.py"))
            ) {
                return true;
            }

            try {
                if ((await fs.promises.readdir(sitePackagesDirectory)).some((entry) =>
                    /^label[-_.]studio-\d.*\.(?:dist|egg)-info$/i.test(entry)
                )) {
                    return true;
                }
            } catch {
                // An unreadable package directory is not safe to treat as empty.
                return true;
            }
        }

        const entryPointDirectories = [path.join(runtimeRoot, "Scripts"), path.join(runtimeRoot, "bin")];
        const entryPointNames = ["label-studio", "label-studio.exe", "label-studio-script.py"];
        for (const directory of entryPointDirectories) {
            for (const name of entryPointNames) {
                if (await this.pathExists(path.join(directory, name))) return true;
            }
        }
        return false;
    }

    private async labelStudioServerEntrypointAvailable(runtimeRoot: string): Promise<boolean> {
        try {
            const output = await this.runRuntimePythonProcess(
                ["-c", "from label_studio.server import main; assert callable(main); print('ready')"],
                this.runtimePythonDir(runtimeRoot),
                AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
                true,
            );
            return output.trim().split(/\r?\n/).includes("ready");
        } catch {
            return false;
        }
    }

    private async assertLabelStudioServerEntrypoint(runtimeRoot: string): Promise<void> {
        if (await this.labelStudioServerEntrypointAvailable(runtimeRoot)) return;
        throw new Error("The installed Label Studio package does not provide an importable label_studio.server:main entry point.");
    }

    private async currentPackageVersion(runtimeRoot: string): Promise<string> {
        const output = await this.runRuntimePythonProcess(
            ["-m", "pip", "show", "label-studio"],
            this.runtimePythonDir(runtimeRoot),
            AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
            true,
        );
        for (const line of output.split(/\r?\n/)) {
            if (line.startsWith("Version:")) return line.split(":", 2)[1]?.trim() ?? "Not installed";
        }
        return "Not installed";
    }

    private async readInstalledPythonDistributions(runtimeRoot: string): Promise<Map<string, InstalledPythonDistribution[]>> {
        try {
            return await this.readInstalledPythonDistributionsFromImportlib(runtimeRoot);
        } catch (error) {
            this.appendRecentOutput(`Installed package metadata query via Python failed: ${error instanceof Error ? error.message : String(error)}`);
            return await this.readInstalledPythonDistributionsFromFilesystem(runtimeRoot);
        }
    }

    private async readInstalledPythonDistributionVersions(runtimeRoot: string): Promise<Map<string, InstalledPythonDistribution[]>> {
        const distributions = new Map<string, InstalledPythonDistribution[]>();
        for (const sitePackagesDirectory of this.runtimeSitePackagesDirectories(runtimeRoot)) {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(sitePackagesDirectory, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (!/\.(?:dist|egg)-info$/i.test(entry.name)) continue;
                // const identity = this.parseInstalledDistributionDirectoryName(entry.name);
                const identity = await this.parseInstalledDistributionInformation(path.join(sitePackagesDirectory, entry.name));
                if (!identity) continue;
                const records = distributions.get(identity.name) ?? [];
                records.push({
                    name: identity.name,
                    version: identity.version,
                    sitePackagesDirectory,
                    distInfoPath: path.join(sitePackagesDirectory, entry.name),
                    requiresPython: "",
                    requiresDist: [],
                });
                distributions.set(identity.name, records);
            }
        }
        this.sortInstalledPythonDistributions(distributions);
        return distributions;
    }

    private async readInstalledPythonDistributionsFromImportlib(runtimeRoot: string): Promise<Map<string, InstalledPythonDistribution[]>> {
        const sitePackagesDirectories = this.runtimeSitePackagesDirectories(runtimeRoot);
        if (sitePackagesDirectories.length === 0) return new Map();

        const script = [
            "import importlib.metadata as metadata",
            "import json",
            "import os",
            "import sys",
            "paths = json.loads(sys.argv[1])",
            "records = []",
            "for dist in metadata.distributions(path=paths):",
            "    meta = dist.metadata",
            "    name = meta.get('Name') or ''",
            "    version = dist.version or meta.get('Version') or ''",
            "    if not name or not version:",
            "        continue",
            "    dist_info_path = ''",
            "    raw_path = getattr(dist, '_path', None)",
            "    if raw_path:",
            "        dist_info_path = os.fspath(raw_path)",
            "    if not dist_info_path:",
            "        try:",
            "            files = list(dist.files or [])",
            "        except Exception:",
            "            files = []",
            "        for file in files:",
            "            normalized = str(file).replace('\\\\', '/')",
            "            if normalized.endswith('.dist-info/METADATA') or normalized.endswith('.egg-info/PKG-INFO'):",
            "                try:",
            "                    dist_info_path = os.path.dirname(os.fspath(dist.locate_file(file)))",
            "                except Exception:",
            "                    dist_info_path = ''",
            "                if dist_info_path:",
            "                    break",
            "    site_packages_directory = ''",
            "    normalized_info = dist_info_path.replace('\\\\', '/')",
            "    marker = '/site-packages/'",
            "    marker_index = normalized_info.lower().rfind(marker)",
            "    if marker_index >= 0:",
            "        site_packages_directory = dist_info_path[:marker_index + len(marker) - 1]",
            "    records.append({",
            "        'name': name,",
            "        'version': version,",
            "        'sitePackagesDirectory': site_packages_directory,",
            "        'distInfoPath': dist_info_path,",
            "        'requiresPython': meta.get('Requires-Python') or '',",
            "        'requiresDist': meta.get_all('Requires-Dist') or [],",
            "    })",
            "print(json.dumps(records, separators=(',', ':')))",
        ].join("\n");
        const output = await this.runRuntimePythonProcess(
            ["-c", script, JSON.stringify(sitePackagesDirectories)],
            this.runtimePythonDir(runtimeRoot),
            AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
            true,
        );
        const snapshots = this.parseInstalledPythonDistributionSnapshots(output);
        return this.installedPythonDistributionMapFromSnapshots(snapshots, runtimeRoot);
    }

    private parseInstalledPythonDistributionSnapshots(output: string): InstalledPythonDistributionSnapshot[] {
        const candidate = output
            .trim()
            .split(/\r?\n/)
            .reverse()
            .find((line) => line.trim().startsWith("[") && line.trim().endsWith("]"));
        if (!candidate) {
            throw new Error("The managed Python metadata query returned no JSON result.");
        }
        const parsed = JSON.parse(candidate) as unknown;
        return Array.isArray(parsed) ? parsed as InstalledPythonDistributionSnapshot[] : [];
    }

    private installedPythonDistributionMapFromSnapshots(
        snapshots: InstalledPythonDistributionSnapshot[],
        runtimeRoot: string,
    ): Map<string, InstalledPythonDistribution[]> {
        const distributions = new Map<string, InstalledPythonDistribution[]>();
        for (const snapshot of snapshots) {
            const normalizedName = this.normalizePackageName(String(snapshot.name ?? ""));
            const version = String(snapshot.version ?? "").trim();
            if (!normalizedName || !version) continue;
            const distInfoPath = String(snapshot.distInfoPath ?? "").trim();
            const sitePackagesDirectory = String(snapshot.sitePackagesDirectory ?? "").trim()
                || this.sitePackagesDirectoryForDistributionPath(distInfoPath, runtimeRoot);
            const records = distributions.get(normalizedName) ?? [];
            records.push({
                name: normalizedName,
                version,
                sitePackagesDirectory,
                distInfoPath,
                requiresPython: String(snapshot.requiresPython ?? ""),
                requiresDist: Array.isArray(snapshot.requiresDist)
                    ? snapshot.requiresDist.map((value) => String(value)).filter(Boolean)
                    : [],
            });
            distributions.set(normalizedName, records);
        }
        this.sortInstalledPythonDistributions(distributions);
        return distributions;
    }

    private sitePackagesDirectoryForDistributionPath(distInfoPath: string, runtimeRoot: string): string {
        if (!distInfoPath) return "";
        const normalizedInfo = path.resolve(distInfoPath);
        for (const sitePackagesDirectory of this.runtimeSitePackagesDirectories(runtimeRoot)) {
            const normalizedSitePackagesDirectory = path.resolve(sitePackagesDirectory);
            const relative = path.relative(normalizedSitePackagesDirectory, normalizedInfo);
            if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return sitePackagesDirectory;
        }
        return "";
    }

    private sortInstalledPythonDistributions(distributions: Map<string, InstalledPythonDistribution[]>): void {
        for (const [name, records] of distributions) {
            distributions.set(name, records.sort((left, right) => this.comparePackageVersions(right.version, left.version)));
        }
    }

    private async readInstalledPythonDistributionsFromFilesystem(runtimeRoot: string): Promise<Map<string, InstalledPythonDistribution[]>> {
        const distributions = new Map<string, InstalledPythonDistribution[]>();
        const seenDistributionPaths = new Set<string>();
        for (const sitePackagesDirectory of this.runtimeSitePackagesDirectories(runtimeRoot)) {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(sitePackagesDirectory, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                const isDistInfo = entry.name.toLowerCase().endsWith(".dist-info");
                const isEggInfo = entry.name.toLowerCase().endsWith(".egg-info");
                if (!isDistInfo && !isEggInfo) continue;
                if (!entry.isDirectory() && !entry.isSymbolicLink() && !(isEggInfo && entry.isFile())) continue;

                const distInfoPath = path.join(sitePackagesDirectory, entry.name);
                const distInfoIdentityString = await this.filesystemPathIdentity(distInfoPath);
                if (seenDistributionPaths.has(distInfoIdentityString)) continue;
                const metadataPath = entry.isFile()
                    ? distInfoPath
                    : path.join(distInfoPath, isDistInfo ? "METADATA" : "PKG-INFO");
                let metadataText = "";
                try {
                    metadataText = await fs.promises.readFile(metadataPath, "utf8");
                } catch {
                    // A failed installation can leave the metadata directory without
                    // METADATA. Its normalized directory name is still sufficient to
                    // identify and remove an obsolete distribution.
                }

                const metadata = this.parseInstalledDistributionMetadata(metadataText);
                // const distInfoIdentity = this.parseInstalledDistributionDirectoryName(entry.name);
                const distInfoIdentity = await this.parseInstalledDistributionInformation(path.join(sitePackagesDirectory, entry.name));
                const normalizedName = metadata?.name ?? distInfoIdentity?.name;
                const version = metadata?.version ?? distInfoIdentity?.version;
                if (!normalizedName || !version) continue;
                seenDistributionPaths.add(distInfoIdentityString);
                const records = distributions.get(normalizedName) ?? [];
                records.push({
                    name: normalizedName,
                    version,
                    sitePackagesDirectory,
                    distInfoPath,
                    requiresPython: metadata?.requiresPython ?? "",
                    requiresDist: metadata?.requiresDist ?? [],
                });
                distributions.set(normalizedName, records);
            }
        }

        this.sortInstalledPythonDistributions(distributions);
        return distributions;
    }

    private parseInstalledDistributionMetadata(text: string): InstalledPythonDistribution | undefined {
        const name = text.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
        const version = text.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
        if (!name || !version) return undefined;
        const coreMetadata = this.parsePythonCoreMetadata(text);
        return {
            name: this.normalizePackageName(name),
            version,
            sitePackagesDirectory: "",
            distInfoPath: "",
            requiresPython: coreMetadata.requiresPython,
            requiresDist: coreMetadata.requiresDist,
        };
    }

    private parseInstalledDistributionDirectoryName(directoryName: string): { name: string; version: string } | undefined {
        const stem = directoryName.replace(/\.(?:dist|egg)-info$/i, "");
        const parts = stem.split("-");
        for (let index = 1; index < parts.length; index += 1) {
            const version = parts[index] ?? "";
            if (!/^\d+(?:[A-Za-z0-9_.!+~]*)?$/.test(version)) continue;
            const name = this.normalizePackageName(parts.slice(0, index).join("-"));
            if (name) return { name, version };
        }
        return undefined;
    }

    private async parseInstalledDistributionInformation(
        distInfoPath: string
    ): Promise<{ name: string; version: string } | undefined> {
        try {
            const metadataText = await fs.promises.readFile(
                path.join(distInfoPath, "METADATA"),
                "utf8",
            );

            const metadata = this.parseInstalledDistributionMetadata(metadataText);

            if (!metadata) return undefined;

            return {
                name: metadata.name,
                version: metadata.version,
            };
        } catch {
            return undefined;
        }
    }

    private runtimeSitePackagesDirectories(runtimeRoot: string): string[] {
        const directories = new Set<string>();
        directories.add(path.join(runtimeRoot, "Lib", "site-packages"));
        directories.add(path.join(runtimeRoot, "lib", "site-packages"));

        const libRoot = path.join(runtimeRoot, "lib");
        for (const pythonDirectory of this.childDirectoriesMatching(libRoot, /^python\d+(?:\.\d+)?$/)) {
            directories.add(path.join(libRoot, pythonDirectory, "site-packages"));
        }

        const frameworkVersions = path.join(runtimeRoot, "Library", "Frameworks", "Python.framework", "Versions");
        for (const versionDirectory of this.childDirectoriesMatching(frameworkVersions, /^(?:Current|\d+(?:\.\d+)*)$/)) {
            const frameworkLib = path.join(frameworkVersions, versionDirectory, "lib");
            for (const pythonDirectory of this.childDirectoriesMatching(frameworkLib, /^python\d+(?:\.\d+)?$/)) {
                directories.add(path.join(frameworkLib, pythonDirectory, "site-packages"));
            }
        }

        return [...directories].filter((directory) => fs.existsSync(directory));
    }

    private installedDistributionSatisfiesArtifact(
        artifact: WheelhouseArtifact,
        installedDistributions: Map<string, InstalledPythonDistribution[]>,
    ): boolean {
        return Boolean(this.installedWheelhouseArtifactFor(artifact, installedDistributions));
    }

    private installedWheelhouseArtifactFor(
        artifact: WheelhouseArtifact,
        installedDistributions: Map<string, InstalledPythonDistribution[]>,
        pythonVersion?: string,
    ): WheelhouseArtifact | undefined {
        const normalizedName = this.normalizePackageName(artifact.name);
        const installed = installedDistributions.get(normalizedName) ?? [];
        const distribution = installed.find((record) =>
            record.version === artifact.version
            && (pythonVersion == null || this.pythonVersionSatisfies(pythonVersion, record.requiresPython ?? "")));
        if (!distribution) return undefined;

        return {
            name: normalizedName,
            version: distribution.version,
            url: `installed://${encodeURIComponent(normalizedName)}@${encodeURIComponent(distribution.version)}`,
            filename: "",
            requested: artifact.requested,
            installed: true,
            installedMetadata: {
                requiresPython: distribution.requiresPython,
                requiresDist: [...distribution.requiresDist],
            },
        };
    }

    private installedDistributionsWithAuthoritativePackageVersion(
        installedDistributions: Map<string, InstalledPythonDistribution[]>,
        packageName: string,
        actualVersion: string,
    ): Map<string, InstalledPythonDistribution[]> {
        const authoritative = new Map(installedDistributions);
        const normalizedName = this.normalizePackageName(packageName);
        const records = (installedDistributions.get(normalizedName) ?? [])
            .filter((distribution) => distribution.version === actualVersion);
        if (records.length > 0) {
            authoritative.set(normalizedName, records);
        } else {
            authoritative.delete(normalizedName);
        }
        return authoritative;
    }

    private async ensureElectronRuntime(updateIfInstalled: boolean, progressStart: number, progressEnd: number): Promise<void> {
        const verb = updateIfInstalled ? "Updating" : "Checking";
        await this.emitBootstrapStage(
            `${verb} Electron`,
            "Electron is provided by the app bundle; no separate Chromium runtime is required.",
            progressStart,
            false,
            undefined,
            undefined,
        );
        await this.emitBootstrapStage(
            "Electron Ready",
            `Embedded Electron ${process.versions.electron} is ready.`,
            progressEnd,
            false,
            undefined,
            undefined,
        );
    }

    private async installPackageWithManagedDownload(
        pkg: PackageDownloadInfo,
        runtimeRoot: string,
        upgrade: boolean,
    ): Promise<RuntimeInstallResult> {
        const packageCacheDirectory = AppPaths.packageDownloadCacheDirectory();
        const wheelhouseDirectory = this.wheelhouseDirectory(pkg.version, packageCacheDirectory);
        await fs.promises.mkdir(wheelhouseDirectory, { recursive: true });

        await this.emitBootstrapStage(
            "Preparing Package",
            "Checking whether label-studio is already installed in the managed runtime.",
            runtimeStepStart("preparePackage"),
            false,
            undefined,
            undefined,
        );

        const spec = pkg.version && pkg.version !== "Unknown" ? `label-studio==${pkg.version}` : "label-studio";
        const seedArtifact = this.packageDownloadSeedArtifact(pkg);
        let downloaded: WheelhouseResolveDownloadResult;
        let installedWithFallback = false;
        try {
            downloaded = await this.resolveAndDownloadWheelhouseArtifacts(spec, upgrade, runtimeRoot, wheelhouseDirectory, undefined, seedArtifact);
        } catch (downloadError) {
            const resolverFallbackArtifacts = this.condaFallbackArtifactsFromWheelhouseResolutionFailure(downloadError);
            if (resolverFallbackArtifacts.length > 0) {
                await this.installPackageAfterWheelhouseResolutionFailure(
                    downloadError,
                    resolverFallbackArtifacts,
                    spec,
                    runtimeRoot,
                    upgrade,
                );
                installedWithFallback = true;
                downloaded = {
                    artifacts: [],
                    resolvedVersions: new Map([["label-studio", pkg.version]]),
                    resolutionComplete: false,
                    result: "completed",
                };
            } else {
                if (this.isExplicitNetworkFailure(downloadError)) {
                    this.appendRecentOutput("PyPI metadata resolution failed before package file downloads could switch to a mirror.");
                }
                throw downloadError instanceof Error ? downloadError : new Error(String(downloadError));
            }
        }
        let artifacts = downloaded.artifacts;
        if (downloaded.result === "skipped") {
            this.lastRuntimeOperationSkipped = true;
            return "skipped";
        }
        if ((await this.waitForDownloadResume()) === "skipped") {
            this.lastRuntimeOperationSkipped = true;
            return "skipped";
        }

        if (!installedWithFallback) {
            try {
                if (artifacts.length > 0) {
                    await this.installPackageFromWheelhouse(artifacts, wheelhouseDirectory, runtimeRoot, upgrade);
                } else {
                    await this.emitBootstrapStage(
                        "Label Studio Installed",
                        "Installed package files already satisfy the embedded runtime.",
                        runtimeStepEnd("installPackage"),
                        false,
                        undefined,
                        undefined,
                    );
                }
            } catch (error) {
                if (!this.isPipBuildFailure(error)) throw error;

                const fallbackArtifacts = this.condaFallbackArtifactsFromWheelhouseFailure(error, artifacts);
                if (fallbackArtifacts.length === 0) throw error;

                const installedFromConda = await this.installCondaForgeFallbackPackages(fallbackArtifacts, runtimeRoot);
                if (installedFromConda.size === 0) throw error;

                artifacts = artifacts.filter((artifact) => !installedFromConda.has(this.packageKey(artifact.name, artifact.version)));
                const result = await this.downloadWheelhouseArtifacts(artifacts, wheelhouseDirectory, runtimeRoot);
                if (result === "skipped") {
                    this.lastRuntimeOperationSkipped = true;
                    return "skipped";
                }
                if ((await this.waitForDownloadResume()) === "skipped") {
                    this.lastRuntimeOperationSkipped = true;
                    return "skipped";
                }
                if (artifacts.length > 0) {
                    await this.installPackageFromWheelhouse(artifacts, wheelhouseDirectory, runtimeRoot, upgrade);
                }
            }
        }

        await this.ensureRequestedPackageVersion(pkg, artifacts, wheelhouseDirectory, runtimeRoot);
        const resolvedVersions = new Map(downloaded.resolvedVersions);
        resolvedVersions.set("label-studio", pkg.version);
        await this.reconcileInstalledDistributionVersions(
            runtimeRoot,
            resolvedVersions,
            downloaded.resolutionComplete,
        );
        await this.assertInstalledPackageVersion(runtimeRoot, pkg.version);

        await this.emitBootstrapStage(
            "Optimizing Runtime",
            "Validating static assets for the embedded Label Studio runtime.",
            runtimeStepStart("optimizeRuntime"),
            false,
            undefined,
            undefined,
        );
        if (!(await this.packagedStaticAssetsAreReady(runtimeRoot))) {
            const optimizationEnvironment = {
                ...AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
                LATEST_VERSION_CHECK: "false",
            };
            await this.runRuntimePythonProcess(
                [
                    "-c",
                    'from label_studio.server import _setup_env; from django.core.management import call_command; _setup_env(); call_command("collectstatic", "--no-input")',
                ],
                this.runtimePythonDir(runtimeRoot),
                optimizationEnvironment,
                false,
                runtimeStepStart("optimizeRuntime"),
                runtimeStepEnd("optimizeRuntime"),
                "Optimizing Runtime",
            );
        }

        await this.emitBootstrapStage(
            "Runtime Optimized",
            "Embedded static assets are ready.",
            runtimeStepEnd("optimizeRuntime"),
            false,
            undefined,
            undefined,
        );
        return "completed";
    }

    private async packagedStaticAssetsAreReady(runtimeRoot: string): Promise<boolean> {
        for (const sitePackagesDirectory of this.runtimeSitePackagesDirectories(runtimeRoot)) {
            const staticRoot = path.join(sitePackagesDirectory, "label_studio", "core", "static_build");
            const manifestPath = path.join(staticRoot, "staticfiles.json");
            try {
                const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as {
                    paths?: Record<string, unknown>;
                };
                const generatedPaths = Object.values(manifest.paths ?? {});
                if (generatedPaths.length === 0) continue;

                let allGeneratedFilesExist = true;
                for (let index = 0; index < generatedPaths.length; index += 64) {
                    const batch = generatedPaths.slice(index, index + 64);
                    const results = await Promise.all(batch.map(async (relativePath) => {
                        if (typeof relativePath !== "string" || relativePath.length === 0) return false;
                        const filePath = this.safePathWithin(staticRoot, relativePath.replace(/\//g, path.sep));
                        if (!filePath) return false;
                        try {
                            return (await fs.promises.stat(filePath)).isFile();
                        } catch {
                            return false;
                        }
                    }));
                    if (results.some((exists) => !exists)) {
                        allGeneratedFilesExist = false;
                        break;
                    }
                }
                if (allGeneratedFilesExist) return true;
            } catch {
                // A missing, invalid, or incomplete manifest requires a real collectstatic run.
            }
        }
        return false;
    }

    private wheelhouseDirectory(_version: string, cacheDirectory: string): string {
        void _version;
        return AppPaths.ensureDirectory(path.join(cacheDirectory, "wheelhouse"));
    }

    private packageDownloadSeedArtifact(pkg: PackageDownloadInfo): WheelhouseArtifact | undefined {
        if (!pkg.url || !pkg.filename) return undefined;
        return {
            name: "label-studio",
            version: pkg.version && pkg.version !== "Unknown" ? pkg.version : "unknown",
            url: pkg.url,
            filename: pkg.filename,
            requested: true,
            size: pkg.size,
        };
    }

    private wheelhouseArtifactDownloadIdentity(artifact: WheelhouseArtifact): string {
        return [
            this.normalizePackageName(artifact.name),
            artifact.version,
            artifact.filename.toLowerCase(),
        ].join("\u0000");
    }

    private wheelhouseArtifactsIncludingRequiredSeed(
        artifacts: WheelhouseArtifact[],
        seedArtifact: WheelhouseArtifact | undefined,
        seedArtifactAlreadyInstalled: boolean,
    ): WheelhouseArtifact[] {
        if (!seedArtifact || seedArtifactAlreadyInstalled) return artifacts;

        const normalizedSeed = this.normalizeWheelhouseArtifact(seedArtifact);
        const seedName = this.normalizePackageName(normalizedSeed.name);
        return [
            normalizedSeed,
            ...artifacts.filter((artifact) =>
                this.normalizePackageName(artifact.name) !== seedName),
        ];
    }

    private async ensureRequestedPackageVersion(
        pkg: PackageDownloadInfo,
        artifacts: WheelhouseArtifact[],
        wheelhouseDirectory: string,
        runtimeRoot: string,
    ): Promise<void> {
        const actualVersion = await this.currentPackageVersion(runtimeRoot).catch(() => "Not installed");
        const installedTargetMetadata = (await this.readInstalledPythonDistributions(runtimeRoot))
            .get("label-studio")
            ?.some((distribution) => distribution.version === pkg.version) ?? false;
        if (actualVersion === pkg.version && installedTargetMetadata) return;

        const initialError = new Error(
            `Label Studio package installation did not create metadata for the requested version ${pkg.version}.`,
        );
        try {
            const seedArtifact = this.packageDownloadSeedArtifact(pkg);
            if (!seedArtifact) throw initialError;

            const resolvedTarget = artifacts.find((artifact) =>
                this.normalizePackageName(artifact.name) === "label-studio"
                && artifact.version === pkg.version);
            const targetArtifact = this.normalizeWheelhouseArtifact(resolvedTarget ?? seedArtifact);
            targetArtifact.requested = true;

            this.traceDownload("requested-package-repair", {
                expectedVersion: pkg.version,
                filename: targetArtifact.filename,
                reason: initialError instanceof Error ? initialError.message : String(initialError),
            });

            const downloadResult = await this.downloadWheelhouseArtifacts(
                [targetArtifact],
                wheelhouseDirectory,
                runtimeRoot,
            );
            if (downloadResult === "skipped") throw initialError;

            await this.installPackageFromWheelhouse(
                [targetArtifact],
                wheelhouseDirectory,
                runtimeRoot,
                true,
            );
            const repairedTargetMetadata = (await this.readInstalledPythonDistributions(runtimeRoot))
                .get("label-studio")
                ?.some((distribution) => distribution.version === pkg.version) ?? false;
            const repairedActualVersion = await this.currentPackageVersion(runtimeRoot).catch(() => "Not installed");
            if (!repairedTargetMetadata || repairedActualVersion !== pkg.version) throw initialError;
        } catch (error) {
            throw error instanceof Error ? error : initialError;
        }
    }

    private async resolveAndDownloadWheelhouseArtifacts(
        spec: string,
        upgrade: boolean,
        runtimeRoot: string,
        wheelhouseDirectory: string,
        indexUrl?: string,
        seedArtifact?: WheelhouseArtifact,
    ): Promise<WheelhouseResolveDownloadResult> {
        void upgrade;
        const effectiveIndexUrl = indexUrl ?? (this.preferTunaPyPI ? TunaPyPISimpleUrl : PrimaryPyPISimpleUrl);
        await this.emitBootstrapStage(
            "Preparing Package",
            "Checking the managed Python version.",
            runtimeStepProgress("preparePackage", 0.15),
            false,
            undefined,
            undefined,
        );
        const pythonVersion = await this.currentPythonVersion(runtimeRoot);
        const planPath = path.join(
            wheelhouseDirectory,
            `pip-plan-${spec.replace(/[^A-Za-z0-9._-]/g, "_")}-python-${pythonVersion.replace(/[^A-Za-z0-9._-]/g, "_")}-${process.platform}-${process.arch}-${effectiveIndexUrl === TunaPyPISimpleUrl ? "mirror" : "primary"}.json`,
        );
        await this.emitBootstrapStage(
            "Preparing Package",
            "Reading installed package versions from the managed runtime.",
            runtimeStepProgress("preparePackage", 0.35),
            false,
            undefined,
            undefined,
        );
        const scannedInstalledDistributions = await this.readInstalledPythonDistributionVersions(runtimeRoot);
        const actualSeedVersion = seedArtifact
            ? await this.currentPackageVersion(runtimeRoot).catch(() => "Not installed")
            : "Not installed";
        const installedDistributions = seedArtifact
            ? this.installedDistributionsWithAuthoritativePackageVersion(
                scannedInstalledDistributions,
                seedArtifact.name,
                actualSeedVersion,
            )
            : scannedInstalledDistributions;

        const seedArtifactAlreadyInstalled = Boolean(
            seedArtifact
            && actualSeedVersion === seedArtifact.version
            && this.installedDistributionSatisfiesArtifact(seedArtifact, installedDistributions),
        );
        const queue: Array<{ artifact: WheelhouseArtifact; streamIndex: number }> = [];
        const queuedArtifacts = new Set<string>();
        let finalArtifacts: WheelhouseArtifact[] | undefined;
        let finalURLs: Set<string> | undefined;
        let resolverDone = false;
        let resolverFailed = false;
        let streamIndex = 0;
        let wakeDownloader: (() => void) | undefined;

        const wake = (): void => {
            const resolver = wakeDownloader;
            wakeDownloader = undefined;
            resolver?.();
        };
        const waitForQueue = async (): Promise<void> => {
            await new Promise<void>((resolve) => {
                wakeDownloader = resolve;
            });
        };
        const enqueue = (artifact: WheelhouseArtifact): void => {
            const normalized = this.normalizeWheelhouseArtifact(artifact);
            const identity = this.wheelhouseArtifactDownloadIdentity(normalized);
            if (queuedArtifacts.has(identity)) return;
            queuedArtifacts.add(identity);
            queue.push({ artifact: normalized, streamIndex });
            streamIndex += 1;
            wake();
        };

        if (seedArtifact && !seedArtifactAlreadyInstalled) enqueue(seedArtifact);

        await this.emitBootstrapStage(
            "Preparing Package",
            "Resolving the package dependency plan.",
            runtimeStepProgress("preparePackage", 0.65),
            false,
            undefined,
            undefined,
        );
        const resolverPromise = this.runTypescriptWheelhouseResolver(
            spec,
            pythonVersion,
            effectiveIndexUrl,
            installedDistributions,
            planPath,
            enqueue,
        ).then((resolution) => {
            const resolvedArtifacts = this.wheelhouseArtifactsIncludingRequiredSeed(
                resolution.artifacts,
                seedArtifact,
                seedArtifactAlreadyInstalled,
            );
            const resolvedVersions = new Map(resolution.resolvedVersions);
            if (seedArtifact) {
                resolvedVersions.set(this.normalizePackageName(seedArtifact.name), seedArtifact.version);
            }
            finalArtifacts = resolvedArtifacts;
            finalURLs = new Set(resolvedArtifacts.map((artifact) => artifact.url));
            for (const artifact of resolvedArtifacts) enqueue(artifact);
            resolverDone = true;
            wake();
            return { artifacts: resolvedArtifacts, resolvedVersions };
        }, (error) => {
            resolverDone = true;
            resolverFailed = true;
            this.traceDownload("resolver-error-wait-current-download", {
                error: error instanceof Error ? error.message : String(error),
                activeTask: this.activeDownloadTask?.snapshot(),
            });
            wake();
            throw error;
        });

        const downloadPromise = (async (): Promise<"completed" | "skipped"> => {
            while (true) {
                if (this.downloadPauseRequested) {
                    this.traceDownload("artifact-queue-paused", { queued: queue.length, resolverDone });
                    if ((await this.waitForDownloadResume()) === "skipped") return "skipped";
                }
                const next = queue.shift();
                if (!next) {
                    if (resolverDone) return "completed";
                    await waitForQueue();
                    continue;
                }
                if (resolverFailed) {
                    this.traceDownload("artifact-queue-stop-after-resolver-error", { queued: queue.length });
                    return "completed";
                }

                if (finalURLs && !finalURLs.has(next.artifact.url)) continue;
                const finalIndex = finalArtifacts?.findIndex((artifact) => artifact.url === next.artifact.url);
                const progressIndex = finalIndex != null && finalIndex >= 0 ? finalIndex : next.streamIndex;
                this.traceDownload("artifact-next", {
                    name: next.artifact.name,
                    version: next.artifact.version,
                    filename: next.artifact.filename,
                    streamIndex: next.streamIndex,
                    progressIndex,
                    queued: queue.length,
                    resolverDone,
                });
                const result = await this.downloadWheelhouseArtifact(
                    next.artifact,
                    progressIndex,
                    () => {
                        if (finalArtifacts) return { total: Math.max(finalArtifacts.length, 1), complete: true };
                        return { total: Math.max(streamIndex + 2, progressIndex + 2, 4), complete: false };
                    },
                    wheelhouseDirectory,
                    runtimeRoot,
                );
                this.traceDownload("artifact-result", {
                    name: next.artifact.name,
                    version: next.artifact.version,
                    filename: next.artifact.filename,
                    result,
                    pausedRequested: this.downloadPauseRequested,
                });
                if (result === "skipped") return "skipped";
                if (resolverFailed) {
                    this.traceDownload("artifact-stop-after-current-download-for-resolver-error", {
                        name: next.artifact.name,
                        version: next.artifact.version,
                        filename: next.artifact.filename,
                    });
                    return "completed";
                }
            }
        })();

        const [resolverOutcome, downloadOutcome] = await Promise.allSettled([resolverPromise, downloadPromise]);

        if (resolverOutcome.status === "rejected") {
            throw resolverOutcome.reason instanceof Error ? resolverOutcome.reason : new Error(String(resolverOutcome.reason));
        }
        if (downloadOutcome.status === "rejected") {
            throw downloadOutcome.reason instanceof Error ? downloadOutcome.reason : new Error(String(downloadOutcome.reason));
        }
        if (downloadOutcome.value === "skipped") {
            return {
                artifacts: finalArtifacts ?? [],
                resolvedVersions: resolverOutcome.value.resolvedVersions,
                resolutionComplete: true,
                result: "skipped",
            };
        }

        return {
            artifacts: resolverOutcome.value.artifacts,
            resolvedVersions: resolverOutcome.value.resolvedVersions,
            resolutionComplete: true,
            result: downloadOutcome.value,
        };
    }

    private async runTypescriptWheelhouseResolver(
        spec: string,
        pythonVersion: string,
        indexUrl: string,
        installedDistributions: Map<string, InstalledPythonDistribution[]>,
        planPath: string,
        onArtifact: (artifact: WheelhouseArtifact) => void,
    ): Promise<WheelhouseResolverResult> {
        this.throwIfRuntimeOperationCancelled();
        const initial = this.parsePythonRequirement(spec);
        if (!initial) throw new Error(`Unable to parse package requirement: ${spec}`);

        const context: WheelhouseResolverContext = {
            pythonVersion,
            indexUrl,
            onArtifact,
            emittedArtifacts: new Set<string>(),
            installedDistributions,
            maxRounds: 200000,
            states: [],
            conflictCounts: new Map<string, number>(),
            conflictPromoted: new Set<string>(),
            optimisticBackjumpingRatio: 0.1,
        };
        const resolvedState = await this.resolveWheelhouseResolution([initial], context);
        this.throwIfRuntimeOperationCancelled();

        const artifacts = this.uniqueWheelhouseArtifactsForDownload([...resolvedState.mapping.values()], context)
            .sort((left, right) => {
                if (left.requested !== right.requested) return left.requested ? 1 : -1;
                return left.name.localeCompare(right.name);
            });

        const resolvedVersions = new Map<string, string>();
        for (const artifact of resolvedState.mapping.values()) {
            if (artifact.synthetic) continue;
            const name = this.normalizePackageName(artifact.name);
            const existingVersion = resolvedVersions.get(name);
            if (existingVersion && existingVersion !== artifact.version) {
                throw new Error(
                    `Wheelhouse resolver selected multiple versions for ${name}: ${existingVersion} and ${artifact.version}.`,
                );
            }
            resolvedVersions.set(name, artifact.version);
        }

        this.throwIfRuntimeOperationCancelled();
        await fs.promises.writeFile(planPath, JSON.stringify({
            version: 1,
            artifacts,
            resolvedVersions: Object.fromEntries([...resolvedVersions].sort(([left], [right]) => left.localeCompare(right))),
        }, null, 2), "utf8");
        return { artifacts, resolvedVersions };
    }

    private async resolveWheelhouseResolution(
        requirements: ParsedPythonRequirement[],
        context: WheelhouseResolverContext,
    ): Promise<WheelhouseResolutionState> {
        if (context.states.length > 0) throw new Error("Wheelhouse resolver is already resolved.");

        context.states = [{
            mapping: new Map<string, WheelhouseArtifact>(),
            criteria: new Map<string, WheelhouseCriterion>(),
            backtrackCauses: [],
        }];
        const rootRequirements = requirements
            .flatMap((requirement, rootIndex) => this.expandWheelhouseRequirementForCriteria(requirement)
                .map((expandedRequirement, index) => ({
                    requirement: expandedRequirement,
                    requested: index === 0,
                    requestedOrder: index === 0 ? rootIndex : Number.POSITIVE_INFINITY,
                })))
            .sort((left, right) => Number(this.wheelhouseRequirementHasExtrasIdentifier(left.requirement))
                - Number(this.wheelhouseRequirementHasExtrasIdentifier(right.requirement)));
        for (const { requirement, requested, requestedOrder } of rootRequirements) {
            try {
                await this.addWheelhouseRequirementToCriteria(this.currentWheelhouseResolutionState(context).criteria, requirement, undefined, requested, context, requestedOrder, false);
            } catch (error) {
                if (error instanceof WheelhouseRequirementsConflictedError) {
                    throw new WheelhouseResolutionImpossibleError(error.criterion.information);
                }
                throw error;
            }
        }
        this.pushWheelhouseResolutionState(context);

        let optimisticRoundsCutoff: number | undefined;
        let optimisticBackjumpingStartRound: number | undefined;

        for (let roundIndex = 0; roundIndex < context.maxRounds; roundIndex += 1) {
            if (roundIndex > 0 && roundIndex % 10 === 0) await this.yieldToEventLoop();
            this.throwIfRuntimeOperationCancelled();
            if (context.optimisticBackjumpingRatio && context.saveStates) {
                if (optimisticBackjumpingStartRound == null) {
                    optimisticBackjumpingStartRound = roundIndex;
                    optimisticRoundsCutoff = Math.trunc((context.maxRounds - roundIndex) * context.optimisticBackjumpingRatio);
                    if (optimisticRoundsCutoff <= 0) {
                        this.rollbackWheelhouseResolutionStates(context);
                        continue;
                    }
                } else if (optimisticRoundsCutoff != null && roundIndex - optimisticBackjumpingStartRound >= optimisticRoundsCutoff) {
                    this.rollbackWheelhouseResolutionStates(context);
                    continue;
                }
            }

            const state = this.currentWheelhouseResolutionState(context);
            const unsatisfiedNames = [...state.criteria.entries()]
                .filter(([name, criterion]) => !this.isCurrentWheelhousePinSatisfying(name, criterion, context))
                .map(([name]) => name);

            if (unsatisfiedNames.length === 0) return state;

            const satisfiedNames = new Set([...state.criteria.keys()].filter((name) => !unsatisfiedNames.includes(name)));
            const narrowedNames = unsatisfiedNames.length > 1
                ? this.narrowWheelhouseRequirementSelection(unsatisfiedNames, context)
                : unsatisfiedNames;
            if (narrowedNames.length === 0) throw new Error("narrowWheelhouseRequirementSelection returned 0 names.");

            const name = narrowedNames.length > 1
                ? [...narrowedNames].sort((left, right) => this.compareWheelhouseRequirementPreference(left, right, context))[0]
                : narrowedNames[0];
            if (!name) throw new Error("Wheelhouse resolver selected an empty requirement name.");

            const failureCriterion = await this.attemptToPinWheelhouseCriterion(name, context);
            if (failureCriterion.length > 0) {
                const causes = this.extractWheelhouseCauses(failureCriterion);
                let success: boolean;
                let failedOptimisticBackjumping = false;
                try {
                    success = await this.backjumpWheelhouseResolution(causes, context);
                } catch (error) {
                    if (error instanceof WheelhouseResolutionImpossibleError && context.optimisticBackjumpingRatio && context.saveStates) {
                        failedOptimisticBackjumping = true;
                        success = false;
                    } else {
                        throw error;
                    }
                }

                if (failedOptimisticBackjumping && context.saveStates) {
                    this.rollbackWheelhouseResolutionStates(context);
                } else {
                    this.currentWheelhouseResolutionState(context).backtrackCauses = [...causes];
                    if (!success) throw new WheelhouseResolutionImpossibleError(this.currentWheelhouseResolutionState(context).backtrackCauses);
                }
            } else {
                const updatedState = this.currentWheelhouseResolutionState(context);
                const newlyUnsatisfiedNames = new Set(
                    [...updatedState.criteria.entries()]
                        .filter(([name, criterion]) => satisfiedNames.has(name) && !this.isCurrentWheelhousePinSatisfying(name, criterion, context))
                        .map(([name]) => name),
                );
                this.removeInformationFromWheelhouseCriteria(updatedState.criteria, newlyUnsatisfiedNames);
                this.pushWheelhouseResolutionState(context);
            }
        }

        throw new Error(`Wheelhouse resolver exceeded ${context.maxRounds} rounds.`);
    }

    private currentWheelhouseResolutionState(context: WheelhouseResolverContext): WheelhouseResolutionState {
        const state = context.states[context.states.length - 1];
        if (!state) throw new Error("Wheelhouse resolver state is not initialized.");
        return state;
    }

    private cloneWheelhouseResolutionState(state: WheelhouseResolutionState): WheelhouseResolutionState {
        return {
            mapping: new Map(state.mapping),
            criteria: this.cloneWheelhouseCriteria(state.criteria),
            backtrackCauses: [...state.backtrackCauses],
        };
    }

    private cloneWheelhouseCriteria(criteria: Map<string, WheelhouseCriterion>): Map<string, WheelhouseCriterion> {
        const cloned = new Map<string, WheelhouseCriterion>();
        for (const [name, criterion] of criteria) {
            cloned.set(name, {
                candidates: criterion.candidates,
                information: criterion.information,
                incompatibilities: [...criterion.incompatibilities],
            });
        }
        return cloned;
    }

    private pushWheelhouseResolutionState(context: WheelhouseResolverContext): void {
        const base = this.currentWheelhouseResolutionState(context);
        context.states.push(this.cloneWheelhouseResolutionState(base));
    }

    private saveWheelhouseResolutionStates(context: WheelhouseResolverContext): void {
        if (context.saveStates) return;
        context.saveStates = context.states.map((state) => this.cloneWheelhouseResolutionState(state));
    }

    private rollbackWheelhouseResolutionStates(context: WheelhouseResolverContext): void {
        context.optimisticBackjumpingRatio = 0;
        if (!context.saveStates) return;
        context.states = context.saveStates.map((state) => this.cloneWheelhouseResolutionState(state));
        context.saveStates = undefined;
    }

    private async addWheelhouseRequirementToCriteria(
        criteria: Map<string, WheelhouseCriterion>,
        requirement: ParsedPythonRequirement,
        parent: WheelhouseArtifact | undefined,
        requested: boolean,
        context: WheelhouseResolverContext,
        requestedOrder = requested ? 0 : Number.POSITIVE_INFINITY,
        expand = true,
    ): Promise<void> {
        this.throwIfRuntimeOperationCancelled();
        const expandedRequirements = expand ? this.expandWheelhouseRequirementForCriteria(requirement) : [requirement];
        if (expand && expandedRequirements.length > 1) {
            for (let index = 0; index < expandedRequirements.length; index += 1) {
                const expandedRequirement = expandedRequirements[index];
                if (!expandedRequirement) continue;
                await this.addWheelhouseRequirementToCriteria(
                    criteria,
                    expandedRequirement,
                    parent,
                    requested && index === 0,
                    context,
                    requested && index === 0 ? requestedOrder : Number.POSITIVE_INFINITY,
                    false,
                );
            }
            return;
        }

        const identifier = this.wheelhouseIdentifierForRequirement(requirement);
        if (!identifier || this.shouldSkipWheelhouseDependency(identifier)) return;

        const existing = criteria.get(identifier);
        const incompatibilities = existing ? [...existing.incompatibilities] : [];
        const information = existing
            ? [...existing.information, { requirement, parent, requested, requestedOrder }]
            : [{ requirement, parent, requested, requestedOrder }];
        const candidates = await this.findWheelhouseMatches(identifier, information, incompatibilities, context);
        const criterion: WheelhouseCriterion = {
            candidates,
            information,
            incompatibilities,
        };
        if (criterion.candidates.length === 0) throw new WheelhouseRequirementsConflictedError(criterion);
        criteria.set(identifier, criterion);
    }

    private expandWheelhouseRequirementForCriteria(requirement: ParsedPythonRequirement): ParsedPythonRequirement[] {
        if (requirement.candidate || requirement.extras.length === 0 || (!requirement.specifier && !requirement.url)) {
            return [requirement];
        }

        return [
            {
                ...requirement,
                extras: [],
            },
            requirement,
        ];
    }

    private wheelhouseRequirementHasExtrasIdentifier(requirement: ParsedPythonRequirement): boolean {
        if (requirement.name === RequiresPythonIdentifier) return false;
        return this.wheelhouseIdentifierForRequirement(requirement) !== this.normalizePackageName(requirement.name);
    }

    private removeInformationFromWheelhouseCriteria(criteria: Map<string, WheelhouseCriterion>, parents: Set<string>): void {
        if (parents.size === 0) return;
        for (const [key, criterion] of criteria) {
            criteria.set(key, {
                candidates: criterion.candidates,
                information: criterion.information.filter((information) => !information.parent || !parents.has(this.wheelhouseIdentifierForArtifact(information.parent))),
                incompatibilities: criterion.incompatibilities,
            });
        }
    }

    private compareWheelhouseRequirementPreference(leftName: string, rightName: string, context: WheelhouseResolverContext): number {
        const left = this.wheelhouseRequirementPreference(leftName, context);
        const right = this.wheelhouseRequirementPreference(rightName, context);
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
            const leftValue = left[index];
            const rightValue = right[index];
            if (leftValue === rightValue) continue;
            if (typeof leftValue === "number" && typeof rightValue === "number") return leftValue - rightValue;
            return String(leftValue).localeCompare(String(rightValue));
        }
        return 0;
    }

    private wheelhouseRequirementPreference(name: string, context: WheelhouseResolverContext): Array<string | number> {
        const criterion = this.currentWheelhouseResolutionState(context).criteria.get(name);
        const information = criterion?.information ?? [];
        const requirementState = this.wheelhouseRequirementStateFromInformation(information);
        const direct = Boolean(requirementState.directUrl);
        const pinned = requirementState.constraints.some((specifier) => this.pythonSpecifierSetHasExactPin(specifier));
        const upperBounded = requirementState.constraints.some((specifier) => this.pythonSpecifierSetHasUpperBound(specifier));
        const unfree = requirementState.constraints.some((specifier) => this.splitSpecifierClauses(specifier).length > 0);
        const requestedOrder = information
            .filter((entry) => entry.requested)
            .reduce((minimum, entry) => Math.min(minimum, entry.requestedOrder), Number.POSITIVE_INFINITY);
        const conflictPromoted = context.conflictPromoted.has(name);
        return [
            conflictPromoted ? 0 : 1,
            direct ? 0 : 1,
            pinned ? 0 : 1,
            upperBounded ? 0 : 1,
            requestedOrder,
            unfree ? 0 : 1,
            name,
        ];
    }

    private narrowWheelhouseRequirementSelection(names: string[], context: WheelhouseResolverContext): string[] {
        if (names.includes(RequiresPythonIdentifier)) return [RequiresPythonIdentifier];

        const backtrackIdentifiers = new Set<string>();
        for (const cause of this.currentWheelhouseResolutionState(context).backtrackCauses) {
            const requirementName = this.wheelhouseIdentifierForRequirement(cause.requirement);
            if (requirementName) backtrackIdentifiers.add(requirementName);
            if (cause.parent) {
                const parentName = this.wheelhouseIdentifierForArtifact(cause.parent);
                if (parentName) backtrackIdentifiers.add(parentName);
            }
        }

        const resolutions = this.currentWheelhouseResolutionState(context).mapping;
        for (const identifier of backtrackIdentifiers) {
            if (resolutions.has(identifier)) continue;
            const count = (context.conflictCounts.get(identifier) ?? 0) + 1;
            context.conflictCounts.set(identifier, count);
            if (count >= 5) context.conflictPromoted.add(identifier);
        }

        const currentBacktrackCauses = names.filter((name) => backtrackIdentifiers.has(name));
        if (currentBacktrackCauses.length > 0) return currentBacktrackCauses;

        const promoted = names.filter((name) => context.conflictPromoted.has(name));
        return promoted.length > 0 ? promoted : names;
    }

    private isCurrentWheelhousePinSatisfying(name: string, criterion: WheelhouseCriterion, context: WheelhouseResolverContext): boolean {
        const candidate = this.currentWheelhouseResolutionState(context).mapping.get(name);
        return Boolean(candidate) && criterion.information.every((information) =>
            candidate ? this.wheelhouseRequirementIsSatisfiedBy(information.requirement, candidate) : false);
    }

    private async getUpdatedWheelhouseCriteria(
        name: string,
        candidate: WheelhouseArtifact,
        context: WheelhouseResolverContext,
    ): Promise<Map<string, WheelhouseCriterion>> {
        this.throwIfRuntimeOperationCancelled();
        const criteria = this.cloneWheelhouseCriteria(this.currentWheelhouseResolutionState(context).criteria);
        const criterion = this.currentWheelhouseResolutionState(context).criteria.get(name);
        const dependencies = await this.getWheelhouseDependencies(candidate, criterion, context);
        await this.prefetchWheelhouseProjects(dependencies, context);
        for (const dependency of dependencies) {
            await this.addWheelhouseRequirementToCriteria(criteria, dependency, candidate, false, context);
        }
        return criteria;
    }

    private async prefetchWheelhouseProjects(
        requirements: ParsedPythonRequirement[],
        context: WheelhouseResolverContext,
    ): Promise<void> {
        const names = [...new Set(requirements
            .filter((requirement) =>
                !requirement.candidate
                && !requirement.url
                && requirement.name !== RequiresPythonIdentifier
                && !this.shouldSkipWheelhouseDependency(requirement.name))
            .map((requirement) => this.normalizePackageName(requirement.name))
            .filter(Boolean))];
        if (names.length === 0) return;

        let nextIndex = 0;
        const workerCount = Math.min(WheelhouseMetadataPrefetchConcurrency, names.length);
        await Promise.all(Array.from({ length: workerCount }, async () => {
            while (nextIndex < names.length) {
                const index = nextIndex;
                nextIndex += 1;
                const packageName = names[index];
                if (!packageName) continue;
                this.throwIfRuntimeOperationCancelled();
                await this.fetchPyPIProjectByName(packageName, context.indexUrl);
            }
        }));
    }

    private async attemptToPinWheelhouseCriterion(name: string, context: WheelhouseResolverContext): Promise<WheelhouseCriterion[]> {
        this.throwIfRuntimeOperationCancelled();
        const criterion = this.currentWheelhouseResolutionState(context).criteria.get(name);
        if (!criterion) throw new Error(`Missing wheelhouse criterion for ${name}.`);

        const causes: WheelhouseCriterion[] = [];
        for (const candidate of criterion.candidates) {
            this.throwIfRuntimeOperationCancelled();
            let criteria: Map<string, WheelhouseCriterion>;
            try {
                criteria = await this.getUpdatedWheelhouseCriteria(name, candidate, context);
            } catch (error) {
                if (error instanceof WheelhouseRequirementsConflictedError) {
                    causes.push(error.criterion);
                    continue;
                }
                if (error instanceof WheelhouseMetadataInvalidError) {
                    criterion.incompatibilities.push(candidate);
                    causes.push({
                        candidates: [],
                        information: criterion.information,
                        incompatibilities: [...criterion.incompatibilities],
                    });
                    continue;
                }
                throw error;
            }

            const satisfied = criterion.information.every((information) =>
                this.wheelhouseRequirementIsSatisfiedBy(information.requirement, candidate));
            if (!satisfied) {
                throw new Error(`Candidate ${candidate.name} ${candidate.version} does not satisfy its wheelhouse criterion.`);
            }

            const state = this.currentWheelhouseResolutionState(context);
            state.criteria = criteria;
            state.mapping.delete(name);
            state.mapping.set(name, candidate);
            this.emitWheelhouseArtifact(context, candidate);
            return [];
        }
        return causes.length > 0 ? causes : [criterion];
    }

    private async patchWheelhouseCriteria(
        incompatibilitiesFromBroken: Array<[string, WheelhouseArtifact[]]>,
        context: WheelhouseResolverContext,
    ): Promise<boolean> {
        const state = this.currentWheelhouseResolutionState(context);
        for (const [name, incompatibilities] of incompatibilitiesFromBroken) {
            if (incompatibilities.length === 0) continue;
            const criterion = state.criteria.get(name);
            if (!criterion) continue;

            const candidates = await this.findWheelhouseMatches(name, criterion.information, incompatibilities, context);
            if (candidates.length === 0) return false;
            const mergedIncompatibilities = [...incompatibilities, ...criterion.incompatibilities];
            state.criteria.set(name, {
                candidates,
                information: [...criterion.information],
                incompatibilities: mergedIncompatibilities,
            });
        }
        return true;
    }

    private async backjumpWheelhouseResolution(
        causes: WheelhouseRequirementInformation[],
        context: WheelhouseResolverContext,
    ): Promise<boolean> {
        const incompatibleDeps = new Set<string>();
        for (const cause of causes) {
            const requirementName = this.wheelhouseIdentifierForRequirement(cause.requirement);
            if (requirementName) incompatibleDeps.add(requirementName);
            if (cause.parent) {
                const parentName = this.wheelhouseIdentifierForArtifact(cause.parent);
                if (parentName) incompatibleDeps.add(parentName);
            }
        }

        while (context.states.length >= 3) {
            await this.yieldToEventLoop();
            context.states.pop();

            let brokenState = this.currentWheelhouseResolutionState(context);
            let brokenName = "";
            let brokenCandidate: WheelhouseArtifact | undefined;

            while (true) {
                await this.yieldToEventLoop();
                const poppedState = context.states.pop();
                if (!poppedState) throw new WheelhouseResolutionImpossibleError(causes);
                brokenState = poppedState;
                const poppedMapping = this.popLastWheelhouseMapping(brokenState.mapping);
                if (!poppedMapping) throw new WheelhouseResolutionImpossibleError(causes);
                brokenName = poppedMapping[0];
                brokenCandidate = poppedMapping[1];

                if (!context.optimisticBackjumpingRatio && !incompatibleDeps.has(brokenName)) break;
                if (context.optimisticBackjumpingRatio && !context.saveStates && !incompatibleDeps.has(brokenName)) {
                    this.saveWheelhouseResolutionStates(context);
                }

                const currentDependencies = new Set(
                    (await this.getWheelhouseDependencies(brokenCandidate, brokenState.criteria.get(brokenName), context))
                        .map((requirement) => this.wheelhouseIdentifierForRequirement(requirement))
                        .filter(Boolean),
                );
                if (![...currentDependencies].every((dependency) => !incompatibleDeps.has(dependency))) break;
                if (brokenState.mapping.size === 0) break;
                if (context.states.length <= 1) throw new WheelhouseResolutionImpossibleError(causes);
            }

            const incompatibilitiesFromBroken: Array<[string, WheelhouseArtifact[]]> = [...brokenState.criteria.entries()]
                .map(([name, criterion]) => [name, [...criterion.incompatibilities]]);
            if (brokenCandidate) {
                incompatibilitiesFromBroken.push([brokenName, [brokenCandidate]]);
            }

            this.pushWheelhouseResolutionState(context);
            const success = await this.patchWheelhouseCriteria(incompatibilitiesFromBroken, context);
            if (success) return true;
        }
        return false;
    }

    private extractWheelhouseCauses(criteria: WheelhouseCriterion[]): WheelhouseRequirementInformation[] {
        const seen = new Set<WheelhouseRequirementInformation>();
        const causes: WheelhouseRequirementInformation[] = [];
        for (const criterion of criteria) {
            for (const information of criterion.information) {
                if (seen.has(information)) continue;
                seen.add(information);
                causes.push(information);
            }
        }
        return causes;
    }

    private popLastWheelhouseMapping(mapping: Map<string, WheelhouseArtifact>): [string, WheelhouseArtifact] | undefined {
        const entries = [...mapping.entries()];
        const last = entries[entries.length - 1];
        if (!last) return undefined;
        mapping.delete(last[0]);
        return last;
    }

    private async findWheelhouseMatches(
        identifier: string,
        information: WheelhouseRequirementInformation[],
        incompatibilities: WheelhouseArtifact[],
        context: WheelhouseResolverContext,
    ): Promise<WheelhouseArtifact[]> {
        if (identifier === RequiresPythonIdentifier) {
            const requirementState = this.wheelhouseRequirementStateFromInformation(information);
            const candidate: WheelhouseArtifact = {
                name: RequiresPythonIdentifier,
                version: context.pythonVersion,
                url: `python-runtime://${context.pythonVersion}`,
                filename: "",
                requested: false,
                resolverName: RequiresPythonIdentifier,
                synthetic: true,
            };
            return this.wheelhouseArtifactSatisfiesRequirementState(candidate, requirementState)
                && !incompatibilities.some((incompatible) => this.wheelhouseArtifactsSame(candidate, incompatible))
                ? [candidate]
                : [];
        }

        const baseName = this.wheelhouseBaseNameFromIdentifier(identifier);
        const resolverExtras = this.wheelhouseExtrasFromIdentifier(identifier);
        const baseInformation = resolverExtras.length > 0
            ? this.currentWheelhouseResolutionState(context).criteria.get(baseName)?.information ?? []
            : [];
        const requirementState = this.wheelhouseRequirementStateFromInformation([...baseInformation, ...information]);
        if (requirementState.directUrl === "__conflict__") return [];

        const candidates = requirementState.directUrl
            ? [this.resolveDirectWheelhouseArtifact(baseName, requirementState.directUrl, requirementState.requested)]
            : requirementState.explicitCandidates.length > 0
                ? requirementState.explicitCandidates
                : await this.findPyPIWheelhouseArtifacts(baseName, requirementState.constraints, context.pythonVersion, context.indexUrl, requirementState.requested);
        return candidates
            .map((candidate) => this.withWheelhouseResolverIdentity(candidate, identifier, resolverExtras))
            .filter((candidate) =>
                this.wheelhouseArtifactSatisfiesRequirementState(candidate, requirementState)
                && !incompatibilities.some((incompatible) => this.wheelhouseArtifactsSame(candidate, incompatible)));
    }

    private wheelhouseRequirementStateFromInformation(information: WheelhouseRequirementInformation[]): WheelhouseRequirementState {
        const constraints: string[] = [];
        const extras = new Set<string>();
        const sources: WheelhouseRequirementSource[] = [];
        const directUrls = new Set<string>();
        const explicitCandidates: WheelhouseArtifact[] = [];
        let requested = false;

        for (const entry of information) {
            const requirement = entry.requirement;
            if (requirement.url) directUrls.add(requirement.url);
            if (requirement.candidate) explicitCandidates.push(requirement.candidate);
            if (requirement.specifier && !constraints.includes(requirement.specifier)) constraints.push(requirement.specifier);
            for (const extra of requirement.extras) {
                const normalizedExtra = this.normalizePackageExtra(extra);
                if (normalizedExtra) extras.add(normalizedExtra);
            }
            if (entry.parent) {
                sources.push({
                    parentName: entry.parent.name,
                    parentVersion: entry.parent.version,
                    rawRequirement: `${requirement.name}${requirement.specifier}`,
                });
            }
            requested ||= entry.requested;
        }

        return {
            constraints,
            directUrl: directUrls.size > 1 ? "__conflict__" : [...directUrls][0],
            explicitCandidates,
            extras,
            requested,
            sources,
        };
    }

    private pythonSpecifierSetHasUpperBound(specifier: string): boolean {
        return this.splitSpecifierClauses(specifier).some((clause) => {
            const match = clause.match(/^(===|==|!=|~=|>=|<=|>|<)\s*(.+)$/);
            if (!match?.[1] || !match[2]) return false;
            return match[1] === "<" || match[1] === "<=" || match[1] === "~=" || (match[1] === "==" && match[2].includes("*"));
        });
    }

    private wheelhouseArtifactSatisfiesRequirementState(artifact: WheelhouseArtifact, state: WheelhouseRequirementState): boolean {
        if (state.directUrl && state.directUrl !== "__conflict__" && artifact.url !== state.directUrl) return false;
        return this.pythonPackageVersionSatisfies(artifact.version, state.constraints.join(","));
    }

    private wheelhouseRequirementIsSatisfiedBy(requirement: ParsedPythonRequirement, artifact: WheelhouseArtifact): boolean {
        if (this.wheelhouseIdentifierForRequirement(requirement) !== this.wheelhouseIdentifierForArtifact(artifact)) return false;
        if (requirement.url && requirement.url !== artifact.url) return false;
        return this.pythonPackageVersionSatisfies(artifact.version, requirement.specifier);
    }

    private wheelhouseArtifactsSame(left: WheelhouseArtifact, right: WheelhouseArtifact): boolean {
        if (left.url && right.url) return left.url === right.url;
        return this.normalizePackageName(left.name) === this.normalizePackageName(right.name)
            && left.version === right.version
            && left.filename === right.filename;
    }

    private wheelhouseIdentifierForRequirement(requirement: ParsedPythonRequirement): string {
        if (requirement.name === RequiresPythonIdentifier) return RequiresPythonIdentifier;
        const name = this.normalizePackageName(requirement.name);
        const extras = this.normalizeUniquePackageExtras(requirement.extras);
        return extras.length > 0 ? `${name}[${extras.join(",")}]` : name;
    }

    private wheelhouseIdentifierForArtifact(artifact: WheelhouseArtifact): string {
        if (artifact.resolverName === RequiresPythonIdentifier || artifact.name === RequiresPythonIdentifier) return RequiresPythonIdentifier;
        return artifact.resolverName || this.normalizePackageName(artifact.name);
    }

    private wheelhouseBaseNameFromIdentifier(identifier: string): string {
        return this.normalizePackageName(identifier.split("[", 1)[0] ?? identifier);
    }

    private wheelhouseExtrasFromIdentifier(identifier: string): string[] {
        const match = identifier.match(/\[([^\]]*)\]$/);
        if (!match?.[1]) return [];
        return this.normalizeUniquePackageExtras(match[1].split(","));
    }

    private normalizeUniquePackageExtras(extras: string[]): string[] {
        return [...new Set(extras.map((extra) => this.normalizePackageExtra(extra)).filter(Boolean))].sort();
    }

    private withWheelhouseResolverIdentity(artifact: WheelhouseArtifact, resolverName: string, resolverExtras: string[]): WheelhouseArtifact {
        const normalizedResolverName = resolverExtras.length > 0
            ? `${this.normalizePackageName(artifact.name)}[${resolverExtras.join(",")}]`
            : this.normalizePackageName(artifact.name);
        return {
            ...artifact,
            resolverName: resolverName || normalizedResolverName,
            resolverExtras: [...resolverExtras],
        };
    }

    private async getWheelhouseDependencies(
        artifact: WheelhouseArtifact,
        criterion: WheelhouseCriterion | undefined,
        context: WheelhouseResolverContext,
    ): Promise<ParsedPythonRequirement[]> {
        this.throwIfRuntimeOperationCancelled();
        if (artifact.synthetic) return [];

        const extras = this.wheelhouseRequirementStateFromInformation(criterion?.information ?? []).extras;
        const sourceMetadata = this.isSourceArchiveFilename(artifact.filename)
            ? await this.sourceArchiveMetadata(artifact)
            : undefined;
        const wheelMetadata = !sourceMetadata && artifact.filename.toLowerCase().endsWith(".whl")
            ? artifact.coreMetadata ?? await this.wheelArtifactMetadata(artifact)
            : undefined;
        const requiresPython = sourceMetadata?.requiresPython || wheelMetadata?.requiresPython || "";
        const requiresDist = sourceMetadata?.requiresDist.length
            ? sourceMetadata.requiresDist
            : wheelMetadata?.requiresDist ?? [];
        const dependencies: ParsedPythonRequirement[] = [];
        if (requiresPython) {
            const specifier = this.parsePythonSpecifierSet(requiresPython);
            if (specifier == null) {
                throw new WheelhouseMetadataInvalidError(artifact, `${artifact.filename} has invalid Requires-Python metadata: ${requiresPython}`);
            }
            dependencies.push({
                name: RequiresPythonIdentifier,
                extras: [],
                specifier,
                marker: "",
            });
        }
        if ((artifact.resolverExtras?.length ?? 0) > 0) {
            const baseCandidate: WheelhouseArtifact = {
                ...artifact,
                resolverName: this.normalizePackageName(artifact.name),
                resolverExtras: [],
            };
            dependencies.push({
                name: artifact.name,
                extras: [],
                specifier: "",
                candidate: baseCandidate,
                marker: "",
            });
        }
        for (const rawRequirement of sourceMetadata?.buildRequires ?? []) {
            const dependency = this.parsePythonRequirement(rawRequirement);
            if (!dependency) {
                throw new WheelhouseMetadataInvalidError(artifact, `${artifact.filename} has invalid build requirement metadata: ${rawRequirement}`);
            }
            if (!this.pythonMarkerMatches(dependency.marker, context.pythonVersion, new Set<string>())) continue;
            dependencies.push(dependency);
        }
        for (const rawRequirement of requiresDist) {
            const dependency = this.parsePythonRequirement(rawRequirement);
            if (!dependency) {
                throw new WheelhouseMetadataInvalidError(artifact, `${artifact.filename} has invalid Requires-Dist metadata: ${rawRequirement}`);
            }
            if (!this.pythonMarkerMatches(dependency.marker, context.pythonVersion, extras)) continue;
            dependencies.push(dependency);
        }
        return dependencies;
    }

    private emitWheelhouseArtifact(context: WheelhouseResolverContext, artifact: WheelhouseArtifact): void {
        if (artifact.synthetic || artifact.installed) return;
        if (this.installedWheelhouseArtifactFor(artifact, context.installedDistributions, context.pythonVersion)) return;
        const key = artifact.url;
        if (context.emittedArtifacts.has(key)) return;
        context.emittedArtifacts.add(key);
        context.onArtifact(artifact);
    }

    private uniqueWheelhouseArtifactsForDownload(artifacts: WheelhouseArtifact[], context: WheelhouseResolverContext): WheelhouseArtifact[] {
        const seen = new Set<string>();
        const unique: WheelhouseArtifact[] = [];
        for (const artifact of artifacts) {
            if (artifact.synthetic || artifact.installed) continue;
            if (this.installedWheelhouseArtifactFor(artifact, context.installedDistributions, context.pythonVersion)) continue;
            if (seen.has(artifact.url)) continue;
            seen.add(artifact.url);
            unique.push({
                ...artifact,
                resolverName: undefined,
                resolverExtras: undefined,
            });
        }
        return unique;
    }

    private async findPyPIWheelhouseArtifacts(
        name: string,
        constraints: string[],
        pythonVersion: string,
        indexUrl: string,
        requested: boolean,
    ): Promise<WheelhouseArtifact[]> {
        const project = await this.fetchPyPIProjectByName(name, indexUrl);
        const matchingReleases = Object.entries(project.releases ?? {})
            .filter(([version]) => this.pythonPackageVersionSatisfies(version, constraints.join(",")))
            .sort((left, right) => this.comparePackageVersions(right[0], left[0]));

        const artifacts = matchingReleases
            .flatMap(([version, files]) => this.choosePyPIWheelhouseArtifacts(name, version, files, pythonVersion, requested, true));
        const applicableArtifacts = this.pythonSpecifierSetAllowsPrereleases(constraints.join(","))
            ? artifacts
            : this.filterPep440Prereleases(artifacts, (artifact) => artifact.version);
        const allowYanked = applicableArtifacts.length > 0
            && applicableArtifacts.every((artifact) => Boolean(artifact.yanked))
            && this.pythonSpecifierSetHasExactPin(constraints.join(","));
        const selectedMetadata = project.info?.version && Array.isArray(project.info.requires_dist)
            ? {
                version: project.info.version,
                metadata: {
                    requiresPython: project.info.requires_python,
                    requiresDist: project.info.requires_dist,
                } satisfies PythonCoreMetadata,
            }
            : undefined;
        return applicableArtifacts
            .filter((artifact) => !artifact.yanked || allowYanked)
            .map((artifact) => selectedMetadata?.version === artifact.version
                ? { ...artifact, coreMetadata: selectedMetadata.metadata }
                : artifact)
            .sort((left, right) => this.comparePyPIWheelhouseArtifacts(left, right, pythonVersion));
    }

    private resolveDirectWheelhouseArtifact(name: string, url: string, requested: boolean): WheelhouseArtifact {
        const filename = this.filenameFromUrl(url);
        if (!filename) throw new Error(`Unable to determine package filename from ${url}`);
        return {
            name: this.normalizePackageName(name),
            version: this.packageVersionFromFilename(name, filename),
            url,
            filename,
            requested,
        };
    }

    private choosePyPIWheelhouseArtifacts(
        name: string,
        version: string,
        files: PyPIFile[],
        pythonVersion: string,
        requested: boolean,
        allowYanked: boolean,
    ): WheelhouseArtifact[] {
        const usableFiles = files.filter((file) =>
            (!file.yanked || allowYanked)
            && file.url
            && file.filename
            && this.pythonVersionSatisfies(pythonVersion, file.requires_python ?? "")
        );
        const wheels = usableFiles
            .map((file) => ({ file, wheel: this.parseWheelFilename(file.filename ?? "") }))
            .filter((entry): entry is { file: PyPIFile; wheel: ParsedWheelFilename } =>
                Boolean(entry.wheel)
                && this.normalizePackageName(entry.wheel?.name ?? "") === this.normalizePackageName(name)
                && (entry.file.packagetype === "bdist_wheel" || /\.whl$/i.test(entry.file.filename ?? ""))
                && this.wheelSupportIndex(entry.file.filename ?? "", pythonVersion) != null)
            .sort((left, right) => this.compareWheelCandidates(left, right, pythonVersion));
        const sourceArchives = usableFiles.filter((file) => {
            const parsed = this.parseSdistFilename(file.filename ?? "");
            return Boolean(parsed)
                && parsed?.name === this.normalizePackageName(name)
                && (file.packagetype === "sdist" || /\.(?:tar\.gz|zip)$/i.test(file.filename ?? ""));
        });

        const selectedFiles = wheels.length > 0
            ? [wheels[0]?.file].filter((file): file is PyPIFile => Boolean(file))
            : sourceArchives.slice(0, 1);
        return selectedFiles
            .filter((file): file is PyPIFile & { url: string; filename: string } => Boolean(file.url && file.filename))
            .map((file) => ({
                name: this.normalizePackageName(name),
                version,
                url: file.url,
                filename: file.filename,
                requested,
                size: file.size,
                yanked: file.yanked,
            }))
            .sort((left, right) => this.comparePyPIWheelhouseArtifacts(left, right, pythonVersion));
    }

    private comparePyPIWheelhouseArtifacts(left: WheelhouseArtifact, right: WheelhouseArtifact, pythonVersion: string): number {
        if (Boolean(left.yanked) !== Boolean(right.yanked)) return left.yanked ? 1 : -1;

        const leftWheel = this.parseWheelFilename(left.filename);
        const rightWheel = this.parseWheelFilename(right.filename);

        const versionDiff = this.comparePackageVersions(right.version, left.version);
        if (versionDiff !== 0) return versionDiff;

        const leftPriority = this.wheelhouseArtifactSortPriority(left, pythonVersion);
        const rightPriority = this.wheelhouseArtifactSortPriority(right, pythonVersion);
        if (leftPriority !== rightPriority) return rightPriority - leftPriority;
        return -this.compareWheelBuildTags(leftWheel?.buildTag ?? [], rightWheel?.buildTag ?? []);
    }

    private wheelhouseArtifactSortPriority(artifact: WheelhouseArtifact, pythonVersion: string): number {
        const supportIndex = this.wheelSupportIndex(artifact.filename, pythonVersion);
        if (supportIndex != null) return -supportIndex;
        return -this.getSupportedWheelTags(pythonVersion).length;
    }

    private compareWheelCandidates(
        left: { file: PyPIFile; wheel: ParsedWheelFilename },
        right: { file: PyPIFile; wheel: ParsedWheelFilename },
        pythonVersion: string,
    ): number {
        const leftIndex = this.wheelSupportIndex(left.file.filename ?? "", pythonVersion) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = this.wheelSupportIndex(right.file.filename ?? "", pythonVersion) ?? Number.MAX_SAFE_INTEGER;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        return -this.compareWheelBuildTags(left.wheel.buildTag, right.wheel.buildTag);
    }

    private compareWheelBuildTags(left: [] | [number, string], right: [] | [number, string]): number {
        if (left.length === 0 && right.length === 0) return 0;
        if (left.length === 0) return -1;
        if (right.length === 0) return 1;
        if (left[0] !== right[0]) return left[0] - right[0];
        return left[1].localeCompare(right[1]);
    }

    private async fetchPyPIProjectByName(name: string, indexUrl: string): Promise<PyPIProject> {
        if (this.preferTunaPyPI || indexUrl === TunaPyPISimpleUrl) {
            return await this.fetchPyPISimpleProject(name, TunaPyPISimpleUrl);
        }
        if (indexUrl !== PrimaryPyPISimpleUrl) {
            return await this.fetchPyPISimpleProject(name, indexUrl);
        }

        const normalizedName = encodeURIComponent(this.normalizePackageName(name));
        const primaryUrl = `https://pypi.org/pypi/${normalizedName}/json`;
        try {
            return await this.fetchCachedPyPIJson(primaryUrl);
        } catch (primaryError) {
            if (!this.isExplicitNetworkFailure(primaryError)) {
                throw primaryError instanceof Error ? primaryError : new Error(String(primaryError));
            }

            this.preferTunaPyPIForCurrentRun();
            const mirrorUrl = this.pyPISimpleProjectUrl(name, TunaPyPISimpleUrl);
            this.appendRecentOutput(`PyPI metadata request failed for ${primaryUrl}; retrying with the TUNA Simple index.`);
            this.traceDownload("pypi-metadata-mirror-retry", { url: primaryUrl, mirrorUrl });
            return await this.fetchPyPISimpleProject(name, TunaPyPISimpleUrl);
        }
    }

    private async fetchCachedPyPIJson(url: string): Promise<PyPIProject> {
        let promise = this.pyPIProjectPromises.get(url);
        if (!promise) {
            promise = this.fetchJson<PyPIProject>(url);
            this.pyPIProjectPromises.set(url, promise);
        }
        try {
            return await promise;
        } catch (error) {
            this.pyPIProjectPromises.delete(url);
            throw error;
        }
    }

    private async fetchPyPISimpleProject(name: string, indexUrl: string): Promise<PyPIProject> {
        const url = this.pyPISimpleProjectUrl(name, indexUrl);
        let promise = this.pyPIProjectPromises.get(url);
        if (!promise) {
            promise = this.fetchJson<PyPISimpleProject>(url, {
                Accept: "application/vnd.pypi.simple.v1+json",
            }).then((project) => this.pyPIProjectFromSimpleApi(name, url, project));
            this.pyPIProjectPromises.set(url, promise);
        }
        try {
            return await promise;
        } catch (error) {
            this.pyPIProjectPromises.delete(url);
            throw error;
        }
    }

    private pyPISimpleProjectUrl(name: string, indexUrl: string): string {
        const encodedName = encodeURIComponent(this.normalizePackageName(name));
        return new URL(`${encodedName}/`, indexUrl).toString();
    }

    private pyPIProjectFromSimpleApi(name: string, projectUrl: string, project: PyPISimpleProject): PyPIProject {
        const normalizedName = this.normalizePackageName(name);
        const releases: Record<string, PyPIFile[]> = {};

        for (const file of project.files ?? []) {
            if (!file.filename || !file.url) continue;
            const wheel = this.parseWheelFilename(file.filename);
            const source = wheel ? undefined : this.parseSdistFilename(file.filename);
            const parsedName = wheel?.name ?? source?.name;
            const version = wheel?.version ?? source?.version;
            if (!parsedName || !version || parsedName !== normalizedName) continue;

            const releaseFile: PyPIFile = {
                filename: file.filename,
                packagetype: wheel ? "bdist_wheel" : "sdist",
                python_version: wheel?.fileTags.some((tag) => tag.interpreter === "py3")
                    ? "py3"
                    : wheel?.fileTags[0]?.interpreter,
                requires_python: typeof file["requires-python"] === "string"
                    ? file["requires-python"]
                    : undefined,
                url: new URL(file.url, projectUrl).toString(),
                yanked: typeof file.yanked === "string" ? true : Boolean(file.yanked),
                size: file.size,
            };
            const files = releases[version] ?? [];
            files.push(releaseFile);
            releases[version] = files;
        }

        const availableReleases = Object.entries(releases)
            .filter(([, files]) => files.some((file) => !file.yanked));
        const stableReleases = this.filterPep440Prereleases(availableReleases);
        const latest = stableReleases
            .sort((left, right) => this.comparePackageVersions(right[0], left[0]))[0];
        const latestVersion = latest?.[0];
        const latestFiles = latest?.[1] ?? [];
        const latestFile = latestFiles.find((file) => !file.yanked && file.packagetype === "bdist_wheel")
            ?? latestFiles.find((file) => !file.yanked);

        return {
            info: latestVersion
                ? {
                    version: latestVersion,
                    requires_python: latestFile?.requires_python,
                }
                : undefined,
            releases,
            urls: latestFiles,
        };
    }

    private async wheelArtifactMetadata(artifact: WheelhouseArtifact): Promise<PythonCoreMetadata> {
        const key = artifact.url || artifact.filename;
        let promise = this.wheelArtifactMetadataPromises.get(key);
        if (!promise) {
            promise = this.loadWheelArtifactMetadata(artifact);
            this.wheelArtifactMetadataPromises.set(key, promise);
        }
        try {
            return await promise;
        } catch (error) {
            this.wheelArtifactMetadataPromises.delete(key);
            throw error;
        }
    }

    private async loadWheelArtifactMetadata(artifact: WheelhouseArtifact): Promise<PythonCoreMetadata> {
        const localPath = this.localFilePathFromURL(artifact.url);
        if (localPath) return await this.parseWheelArtifactMetadata(artifact, await fs.promises.readFile(localPath));

        const metadataUrl = this.pyPIWheelMetadataUnavailable
            ? undefined
            : this.pyPIWheelMetadataUrl(artifact.url);
        let metadataNetworkFailed = false;
        if (metadataUrl) {
            try {
                const metadata = await this.fetchText(metadataUrl);
                if (!/^Metadata-Version\s*:/mi.test(metadata) || !/^Name\s*:/mi.test(metadata)) {
                    throw new WheelhouseMetadataInvalidError(artifact, `${artifact.filename} has invalid wheel core metadata.`);
                }
                return this.parsePythonCoreMetadata(metadata);
            } catch (error) {
                if (error instanceof WheelhouseMetadataInvalidError) throw error;
                if (this.isExplicitNetworkFailure(error)) {
                    metadataNetworkFailed = true;
                    this.pyPIWheelMetadataUnavailable = true;
                    this.preferTunaPyPIForCurrentRun();
                    this.appendRecentOutput(`Wheel metadata request failed for ${metadataUrl}; switching package metadata source.`);
                    this.traceDownload("wheel-metadata-artifact-fallback", {
                        filename: artifact.filename,
                        metadataUrl,
                    });
                }
            }
        }

        if (!metadataNetworkFailed) {
            try {
                const project = await this.fetchCachedPyPIJson(this.pyPIVersionJsonUrl(artifact.name, artifact.version));
                return {
                    requiresPython: project.info?.requires_python,
                    requiresDist: project.info?.requires_dist ?? [],
                };
            } catch (error) {
                if (this.isExplicitNetworkFailure(error)) {
                    this.pyPIWheelMetadataUnavailable = true;
                    this.preferTunaPyPIForCurrentRun();
                }
            }
        }

        try {
            const mirrorProject = await this.fetchCachedPyPIJson(this.tunaPyPIProjectJsonUrl(artifact.name));
            if (mirrorProject.info?.version === artifact.version) {
                return {
                    requiresPython: mirrorProject.info.requires_python,
                    requiresDist: mirrorProject.info.requires_dist ?? [],
                };
            }
        } catch {
            // The mirror's project JSON is an optimization; the selected wheel remains authoritative.
        }

        const archive = await this.fetchPyPIArtifactBufferWithFallback(artifact.url);
        return await this.parseWheelArtifactMetadata(artifact, archive);
    }

    private pyPIVersionJsonUrl(name: string, version: string): string {
        const normalizedName = encodeURIComponent(this.normalizePackageName(name));
        return `https://pypi.org/pypi/${normalizedName}/${encodeURIComponent(version)}/json`;
    }

    private tunaPyPIProjectJsonUrl(name: string): string {
        const normalizedName = encodeURIComponent(this.normalizePackageName(name));
        return `https://pypi.tuna.tsinghua.edu.cn/pypi/${normalizedName}/json`;
    }

    private pyPIWheelMetadataUrl(url: string): string | undefined {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return undefined;
        }
        if (parsed.protocol !== "https:" || !parsed.pathname.startsWith("/packages/") || !parsed.pathname.endsWith(".whl")) {
            return undefined;
        }
        if (parsed.hostname === "pypi.tuna.tsinghua.edu.cn") {
            parsed.hostname = "files.pythonhosted.org";
        } else if (parsed.hostname !== "files.pythonhosted.org") {
            return undefined;
        }
        parsed.pathname = `${parsed.pathname}.metadata`;
        parsed.hash = "";
        return parsed.toString();
    }

    private async fetchPyPIArtifactBufferWithFallback(url: string): Promise<Buffer> {
        const urls = this.wheelhouseArtifactDownloadUrls(url);
        let lastError: unknown;
        for (let index = 0; index < urls.length; index += 1) {
            const candidateUrl = urls[index];
            if (!candidateUrl) continue;
            try {
                return await this.fetchBuffer(candidateUrl);
            } catch (error) {
                lastError = error;
                if (index >= urls.length - 1 || !this.isExplicitNetworkFailure(error)) break;
                this.preferTunaPyPIArtifactFilesForCurrentRun();
            }
        }
        throw lastError instanceof Error ? lastError : new Error(`Unable to read package file metadata from ${url}`);
    }

    private async parseWheelArtifactMetadata(artifact: WheelhouseArtifact, archive: Buffer): Promise<PythonCoreMetadata> {
        const entries = await this.extractZipSourceArchiveTextEntries(archive);
        const metadataEntry = entries.find((entry) => /(?:^|\/)METADATA$/i.test(entry.name.replace(/\\/g, "/")));
        if (!metadataEntry) {
            throw new WheelhouseMetadataInvalidError(artifact, `${artifact.filename} does not contain wheel core metadata.`);
        }
        return this.parsePythonCoreMetadata(metadataEntry.text);
    }

    private isSourceArchiveFilename(filename: string): boolean {
        return /\.(?:tar\.gz|zip)$/i.test(filename);
    }

    private async sourceArchiveMetadata(artifact: WheelhouseArtifact): Promise<SourceArchiveMetadata> {
        const key = artifact.url || artifact.filename;
        let promise = this.sourceArchiveMetadataPromises.get(key);
        if (!promise) {
            promise = this.loadSourceArchiveMetadata(artifact);
            this.sourceArchiveMetadataPromises.set(key, promise);
        }
        try {
            return await promise;
        } catch (error) {
            this.sourceArchiveMetadataPromises.delete(key);
            throw error;
        }
    }

    private async loadSourceArchiveMetadata(artifact: WheelhouseArtifact): Promise<SourceArchiveMetadata> {
        const archive = await this.readSourceArchiveBuffer(artifact);
        const entries = await this.extractSourceArchiveTextEntries(artifact.filename, archive);
        const pyProject = entries.find((entry) => this.sourceArchiveInnerPath(entry.name) === "pyproject.toml")?.text;
        const hasSetupPy = entries.some((entry) => this.sourceArchiveInnerPath(entry.name) === "setup.py");
        const coreMetadata = this.parseSourceArchiveCoreMetadata(entries);
        return {
            requiresPython: coreMetadata.requiresPython,
            requiresDist: coreMetadata.requiresDist,
            buildRequires: this.parseSourceArchiveBuildRequires(pyProject, hasSetupPy, artifact.filename),
        };
    }

    private async readSourceArchiveBuffer(artifact: WheelhouseArtifact): Promise<Buffer> {
        const localPath = this.localFilePathFromURL(artifact.url);
        if (localPath) return await fs.promises.readFile(localPath);
        return await this.fetchPyPIArtifactBufferWithFallback(artifact.url);
    }

    private async extractSourceArchiveTextEntries(filename: string, archive: Buffer): Promise<SourceArchiveTextEntry[]> {
        if (/\.tar\.gz$/i.test(filename)) return await this.extractTarGzSourceArchiveTextEntries(archive);
        if (/\.zip$/i.test(filename)) return await this.extractZipSourceArchiveTextEntries(archive);
        return [];
    }

    private async extractTarGzSourceArchiveTextEntries(archive: Buffer): Promise<SourceArchiveTextEntry[]> {
        const tar = await gunzipAsync(archive);
        const entries: SourceArchiveTextEntry[] = [];
        let offset = 0;
        let entryIndex = 0;
        let pendingLongName: string | undefined;
        let pendingPaxPath: string | undefined;

        while (offset + 512 <= tar.length) {
            const header = tar.subarray(offset, offset + 512);
            if (header.every((byte) => byte === 0)) break;

            const name = pendingPaxPath || pendingLongName || this.tarHeaderPath(tar, offset);
            pendingLongName = undefined;
            pendingPaxPath = undefined;
            const size = this.tarHeaderSize(tar, offset);
            const typeFlag = String.fromCharCode(header[156] ?? 0);
            const dataOffset = offset + 512;
            const dataEnd = dataOffset + size;
            if (dataEnd > tar.length) break;
            const data = tar.subarray(dataOffset, dataEnd);

            if (typeFlag === "L") {
                pendingLongName = this.trimNullTerminatedString(data.toString("utf8"));
            } else if (typeFlag === "x") {
                pendingPaxPath = this.parseTarPaxPath(data.toString("utf8"));
            } else if ((typeFlag === "\0" || typeFlag === "" || typeFlag === "0") && this.sourceArchiveTextEntryIsInteresting(name)) {
                entries.push({ name, text: data.toString("utf8") });
            }

            offset = dataOffset + Math.ceil(size / 512) * 512;
            entryIndex += 1;
            if (entryIndex % 50 === 0) await this.yieldToEventLoop();
        }

        return entries;
    }

    private tarHeaderPath(archive: Buffer, offset: number): string {
        const name = this.tarHeaderString(archive, offset, 100);
        const prefix = this.tarHeaderString(archive, offset + 345, 155);
        return prefix ? `${prefix}/${name}` : name;
    }

    private tarHeaderString(archive: Buffer, offset: number, length: number): string {
        return this.trimNullTerminatedString(archive.subarray(offset, offset + length).toString("utf8")).trim();
    }

    private tarHeaderSize(archive: Buffer, offset: number): number {
        const raw = this.trimNullTerminatedString(archive.subarray(offset + 124, offset + 136).toString("utf8")).trim();
        const size = Number.parseInt(raw || "0", 8);
        return Number.isFinite(size) && size >= 0 ? size : 0;
    }

    private parseTarPaxPath(text: string): string | undefined {
        let offset = 0;
        while (offset < text.length) {
            const space = text.indexOf(" ", offset);
            if (space < 0) return undefined;
            const length = Number.parseInt(text.slice(offset, space), 10);
            if (!Number.isFinite(length) || length <= 0) return undefined;
            const record = text.slice(space + 1, offset + length).replace(/\n$/, "");
            const equals = record.indexOf("=");
            if (equals > 0 && record.slice(0, equals) === "path") return record.slice(equals + 1);
            offset += length;
        }
        return undefined;
    }

    private async extractZipSourceArchiveTextEntries(archive: Buffer): Promise<SourceArchiveTextEntry[]> {
        const entries: SourceArchiveTextEntry[] = [];
        const endOfCentralDirectoryOffset = this.findZipEndOfCentralDirectory(archive);
        const entryCount = archive.readUInt16LE(endOfCentralDirectoryOffset + 10);
        let offset = archive.readUInt32LE(endOfCentralDirectoryOffset + 16);

        for (let index = 0; index < entryCount; index += 1) {
            if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central directory entry.");
            const flags = archive.readUInt16LE(offset + 8);
            const compression = archive.readUInt16LE(offset + 10);
            const compressedSize = archive.readUInt32LE(offset + 20);
            const uncompressedSize = archive.readUInt32LE(offset + 24);
            const fileNameLength = archive.readUInt16LE(offset + 28);
            const extraLength = archive.readUInt16LE(offset + 30);
            const commentLength = archive.readUInt16LE(offset + 32);
            const localHeaderOffset = archive.readUInt32LE(offset + 42);
            const fileName = archive.subarray(offset + 46, offset + 46 + fileNameLength).toString((flags & 0x0800) ? "utf8" : "utf8");
            offset += 46 + fileNameLength + extraLength + commentLength;

            if (!this.sourceArchiveTextEntryIsInteresting(fileName) || fileName.endsWith("/")) continue;
            if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
                throw new Error("ZIP64 source archives are not supported by the embedded metadata reader.");
            }
            if ((flags & 0x0001) !== 0) throw new Error(`Encrypted ZIP entries are not supported: ${fileName}`);
            if (archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local file header: ${fileName}`);

            const localFileNameLength = archive.readUInt16LE(localHeaderOffset + 26);
            const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
            const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
            const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
            const data = compression === 0
                ? Buffer.from(compressed)
                : compression === 8
                    ? await inflateRawAsync(compressed)
                    : undefined;
            if (!data) continue;
            entries.push({ name: fileName, text: data.toString("utf8") });
            if ((index + 1) % 50 === 0) await this.yieldToEventLoop();
        }

        return entries;
    }

    private sourceArchiveTextEntryIsInteresting(name: string): boolean {
        const innerPath = this.sourceArchiveInnerPath(name);
        return innerPath === "pyproject.toml"
            || innerPath === "setup.py"
            || innerPath === "PKG-INFO"
            || innerPath.endsWith(".egg-info/PKG-INFO")
            || innerPath.endsWith(".dist-info/METADATA")
            || innerPath === "METADATA";
    }

    private sourceArchiveInnerPath(name: string): string {
        const normalized = name.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
        const parts = normalized.split("/").filter(Boolean);
        if (parts.length <= 1) return parts[0] ?? "";
        return parts.slice(1).join("/");
    }

    private parseSourceArchiveCoreMetadata(entries: SourceArchiveTextEntry[]): PythonCoreMetadata {
        const metadataEntry = entries
            .filter((entry) => {
                const innerPath = this.sourceArchiveInnerPath(entry.name);
                return innerPath === "PKG-INFO"
                    || innerPath.endsWith(".egg-info/PKG-INFO")
                    || innerPath.endsWith(".dist-info/METADATA")
                    || innerPath === "METADATA";
            })
            .sort((left, right) => this.sourceArchiveMetadataPriority(left.name) - this.sourceArchiveMetadataPriority(right.name))[0];
        if (!metadataEntry) return { requiresDist: [] };
        return this.parsePythonCoreMetadata(metadataEntry.text);
    }

    private sourceArchiveMetadataPriority(name: string): number {
        const innerPath = this.sourceArchiveInnerPath(name);
        if (innerPath === "PKG-INFO") return 0;
        if (innerPath.endsWith(".egg-info/PKG-INFO")) return 1;
        if (innerPath.endsWith(".dist-info/METADATA")) return 2;
        return 3;
    }

    private parsePythonCoreMetadata(text: string): PythonCoreMetadata {
        const headers = new Map<string, string[]>();
        let currentKey = "";
        for (const line of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
            if (!line.trim()) break;
            if (/^[ \t]/.test(line) && currentKey) {
                const values = headers.get(currentKey);
                if (values?.length) values[values.length - 1] = `${values[values.length - 1] ?? ""}\n${line}`;
                continue;
            }
            const separator = line.indexOf(":");
            if (separator <= 0) continue;
            currentKey = line.slice(0, separator).trim().toLowerCase();
            const value = line.slice(separator + 1).trim();
            const values = headers.get(currentKey) ?? [];
            values.push(value);
            headers.set(currentKey, values);
        }

        const unfold = (value: string) => value.replace(/\n[ \t]+/g, " ").trim();
        return {
            requiresPython: headers.get("requires-python")?.map(unfold).find(Boolean),
            requiresDist: (headers.get("requires-dist") ?? []).map(unfold).filter(Boolean),
        };
    }

    private parseSourceArchiveBuildRequires(pyProject: string | undefined, hasSetupPy: boolean, filename: string): string[] {
        if (!pyProject && !hasSetupPy) {
            throw new Error(`${filename} does not appear to be a Python project: neither setup.py nor pyproject.toml found.`);
        }
        if (!pyProject) return hasSetupPy ? ["setuptools>=40.8.0"] : [];

        const section = this.tomlSection(pyProject, "build-system");
        if (section == null) return ["setuptools>=40.8.0"];

        const requiresValue = this.tomlSectionValue(section, "requires");
        if (!requiresValue) throw new Error(`${filename} has a [build-system] table without a requires list.`);
        const requires = this.parseTomlStringArray(requiresValue);
        if (!requires) throw new Error(`${filename} has an invalid [build-system].requires list.`);
        for (const requirement of requires) {
            if (!this.parsePythonRequirement(requirement)) throw new Error(`${filename} has an invalid build requirement: ${requirement}`);
        }

        return requires;
    }

    private tomlSection(text: string, sectionName: string): string | undefined {
        const lines: string[] = [];
        let found = false;
        let inside = false;
        for (const line of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
            const stripped = this.stripTomlComment(line).trim();
            const header = stripped.match(/^\[([A-Za-z0-9_.-]+)\]$/);
            if (header?.[1]) {
                if (inside) break;
                inside = header[1] === sectionName;
                if (inside) found = true;
                continue;
            }
            if (inside) lines.push(line);
        }
        return found ? lines.join("\n") : undefined;
    }

    private tomlSectionValue(section: string, key: string): string | undefined {
        const lines = section.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
            const line = this.stripTomlComment(lines[index] ?? "");
            const match = line.match(new RegExp(`^\\s*${this.escapeRegExp(key)}\\s*=\\s*(.*)$`));
            if (!match) continue;

            let value = match[1] ?? "";
            let bracketDepth = this.tomlBracketDelta(value);
            while (bracketDepth > 0 && index + 1 < lines.length) {
                index += 1;
                const continuation = this.stripTomlComment(lines[index] ?? "");
                value += `\n${continuation}`;
                bracketDepth += this.tomlBracketDelta(continuation);
            }
            return value.trim();
        }
        return undefined;
    }

    private tomlBracketDelta(text: string): number {
        let quote = "";
        let delta = 0;
        for (let index = 0; index < text.length; index += 1) {
            const char = text[index] ?? "";
            if (quote) {
                if (char === "\\" && quote === "\"") {
                    index += 1;
                    continue;
                }
                if (char === quote) quote = "";
                continue;
            }
            if (char === "'" || char === "\"") {
                quote = char;
                continue;
            }
            if (char === "[") delta += 1;
            if (char === "]") delta -= 1;
        }
        return delta;
    }

    private parseTomlStringArray(value: string): string[] | undefined {
        const trimmed = value.trim();
        if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;

        const result: string[] = [];
        let index = 1;
        while (index < trimmed.length - 1) {
            while (index < trimmed.length - 1 && /[\s,]/.test(trimmed[index] ?? "")) index += 1;
            if (index >= trimmed.length - 1) break;

            const quote = trimmed[index];
            if (quote !== "'" && quote !== "\"") return undefined;
            index += 1;
            let raw = "";
            while (index < trimmed.length) {
                const char = trimmed[index] ?? "";
                if (char === "\\" && quote === "\"") {
                    raw += char;
                    index += 1;
                    if (index < trimmed.length) raw += trimmed[index] ?? "";
                    index += 1;
                    continue;
                }
                if (char === quote) break;
                raw += char;
                index += 1;
            }
            if ((trimmed[index] ?? "") !== quote) return undefined;
            index += 1;
            result.push(this.unquoteTomlString(`${quote}${raw}${quote}`));
        }
        return result;
    }

    private stripTomlComment(line: string): string {
        let quote = "";
        for (let index = 0; index < line.length; index += 1) {
            const char = line[index] ?? "";
            if (quote) {
                if (char === "\\" && quote === "\"") {
                    index += 1;
                    continue;
                }
                if (char === quote) quote = "";
                continue;
            }
            if (char === "'" || char === "\"") {
                quote = char;
                continue;
            }
            if (char === "#") return line.slice(0, index);
        }
        return line;
    }

    private unquoteTomlString(value: string): string {
        const quote = value[0];
        const body = value.slice(1, -1);
        if (quote === "'") return body;
        return body.replace(/\\(["\\bfnrt])/g, (_match, escaped: string) => {
            if (escaped === "b") return "\b";
            if (escaped === "f") return "\f";
            if (escaped === "n") return "\n";
            if (escaped === "r") return "\r";
            if (escaped === "t") return "\t";
            return escaped;
        });
    }

    private trimNullTerminatedString(value: string): string {
        const index = value.indexOf("\0");
        return index >= 0 ? value.slice(0, index) : value;
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    private parsePythonRequirement(text: string): ParsedPythonRequirement | undefined {
        const source = text.trim();
        const nameMatch = source.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
        if (!nameMatch?.[0]) return undefined;

        const rawName = nameMatch[0];
        let index = rawName.length;
        index = this.skipPythonRequirementWhitespace(source, index);

        const extrasResult = this.parsePythonRequirementExtras(source, index);
        if (!extrasResult) return undefined;
        index = this.skipPythonRequirementWhitespace(source, extrasResult.nextIndex);

        if (source[index] === "@") {
            index += 1;
            index = this.skipPythonRequirementWhitespace(source, index);
            const urlMatch = source.slice(index).match(/^[^ \t]+/);
            if (!urlMatch?.[0]) return undefined;
            const url = urlMatch[0];
            index += url.length;

            if (index >= source.length) {
                return {
                    name: this.normalizePackageName(rawName),
                    extras: extrasResult.extras,
                    specifier: "",
                    url,
                    marker: "",
                };
            }

            if (!/[ \t]/.test(source[index] ?? "")) return undefined;
            index = this.skipPythonRequirementWhitespace(source, index);
            if (index >= source.length) {
                return {
                    name: this.normalizePackageName(rawName),
                    extras: extrasResult.extras,
                    specifier: "",
                    url,
                    marker: "",
                };
            }
            if (source[index] !== ";") return undefined;

            const marker = source.slice(index + 1).trim();
            if (!this.parsePythonMarker(marker)) return undefined;
            return {
                name: this.normalizePackageName(rawName),
                extras: extrasResult.extras,
                specifier: "",
                url,
                marker,
            };
        }

        const [specifierPart, markerPart] = this.splitRequirementMarker(source.slice(index));
        const specifier = this.parsePythonSpecifierSet(specifierPart);
        const marker = markerPart.trim();
        if (specifier == null || (marker && !this.parsePythonMarker(marker))) return undefined;

        return {
            name: this.normalizePackageName(rawName),
            extras: extrasResult.extras,
            specifier,
            marker,
        };
    }

    private skipPythonRequirementWhitespace(source: string, index: number): number {
        let next = index;
        while (/[ \t]/.test(source[next] ?? "")) next += 1;
        return next;
    }

    private parsePythonRequirementExtras(source: string, startIndex: number): { extras: string[]; nextIndex: number } | undefined {
        let index = startIndex;
        if (source[index] !== "[") return { extras: [], nextIndex: index };
        index += 1;
        index = this.skipPythonRequirementWhitespace(source, index);

        const extras: string[] = [];
        if (source[index] === "]") return { extras, nextIndex: index + 1 };

        while (index < source.length) {
            const match = source.slice(index).match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
            if (!match?.[0]) return undefined;
            extras.push(this.normalizePackageExtra(match[0]));
            index += match[0].length;
            index = this.skipPythonRequirementWhitespace(source, index);

            if (source[index] === ",") {
                index += 1;
                index = this.skipPythonRequirementWhitespace(source, index);
                continue;
            }
            if (source[index] === "]") return { extras, nextIndex: index + 1 };
            return undefined;
        }

        return undefined;
    }

    private parsePythonSpecifierSet(specifier: string): string | undefined {
        let text = specifier.trim();
        if (!text) return "";
        if (text.startsWith("(")) {
            if (!text.endsWith(")")) return undefined;
            text = text.slice(1, -1).trim();
        }

        const rawClauses = text.split(",");
        if (rawClauses.slice(0, -1).some((clause) => !clause.trim())) return undefined;
        const clauses = rawClauses.map((clause) => clause.trim()).filter(Boolean);
        if (!clauses.every((clause) => this.pythonSpecifierClauseIsValid(clause))) return undefined;

        return clauses
            .map((clause) => clause.replace(/\s+/g, ""))
            .sort()
            .join(",");
    }

    private pythonSpecifierClauseIsValid(clause: string): boolean {
        return this.pythonSpecifierClauseMatch(clause) != null;
    }

    private pythonSpecifierClauseMatch(clause: string): RegExpMatchArray | null {
        const versionCore = String.raw`v?(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*`;
        const versionAtLeastTwoReleaseSegments = String.raw`v?(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)+`;
        const pre = String.raw`(?:[-_.]?(?:alpha|beta|preview|pre|a|b|c|rc)[-_.]?[0-9]*)?`;
        const post = String.raw`(?:(?:-[0-9]+)|(?:[-_.]?(?:post|rev|r)[-_.]?[0-9]*))?`;
        const dev = String.raw`(?:[-_.]?dev[-_.]?[0-9]*)?`;
        const local = String.raw`(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?`;
        const arbitrary = clause.match(/^===\s*([^\s;)]*)$/i);
        if (arbitrary) return arbitrary;
        const equality = clause.match(new RegExp(`^(==|!=)\\s*(${versionCore}(?:(?:\\.\\*)|${pre}${post}${dev}${local})?)$`, "i"));
        if (equality) return equality;
        const compatible = clause.match(new RegExp(`^(~=)\\s*(${versionAtLeastTwoReleaseSegments}${pre}${post}${dev})$`, "i"));
        if (compatible) return compatible;
        return clause.match(new RegExp(`^(<=|>=|<|>)\\s*(${versionCore}${pre}${post}${dev})$`, "i"));
    }

    private normalizePythonSpecifierSet(specifier: string): string {
        return this.parsePythonSpecifierSet(specifier) ?? "";
    }

    private splitRequirementMarker(text: string): [string, string] {
        let quote = "";
        let depth = 0;
        for (let index = 0; index < text.length; index += 1) {
            const char = text[index] ?? "";
            if (quote) {
                if (char === quote) quote = "";
                continue;
            }
            if (char === "'" || char === "\"") {
                quote = char;
                continue;
            }
            if (char === "(" || char === "[") depth += 1;
            if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
            if (char === ";" && depth === 0) {
                return [text.slice(0, index), text.slice(index + 1)];
            }
        }
        return [text, ""];
    }

    private pythonMarkerMatches(marker: string, pythonVersion: string, extras: Set<string>): boolean {
        const trimmed = marker.trim();
        if (!trimmed) return true;
        const effectiveExtras = extras.size > 0 ? [...extras] : [""];
        return effectiveExtras.some((extra) => this.evaluatePythonMarker(trimmed, pythonVersion, extra));
    }

    private evaluatePythonMarker(marker: string, pythonVersion: string, extra: string): boolean {
        const parsed = this.parsePythonMarker(marker);
        if (!parsed) return true;
        return this.evaluatePythonMarkerExpression(parsed, pythonVersion, extra);
    }

    private parsePythonMarker(marker: string): PythonMarkerExpression | undefined {
        const tokens = this.tokenizePythonMarker(marker);
        let index = 0;

        const peek = (): string | undefined => tokens[index];
        const take = (): string | undefined => tokens[index++];
        const parseTerm = (): PythonMarkerTerm | undefined => {
            const token = take();
            if (!token) return undefined;
            const quoted = token.match(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/);
            if (quoted) return { kind: "value", value: this.unquotePythonMarkerString(token) };
            const variable = token.toLowerCase().replace(/\./g, "_");
            if (!this.pythonMarkerVariableNameIsValid(variable)) return undefined;
            return { kind: "variable", value: variable === "python_implementation" ? "platform_python_implementation" : variable };
        };
        const parseAtom = (): PythonMarkerExpression | undefined => {
            if (peek() === "(") {
                take();
                const expression = parseOr();
                if (!expression || peek() !== ")") return undefined;
                take();
                return expression;
            }

            const left = parseTerm();
            const op = take();
            const right = parseTerm();
            const normalizedOp = op?.toLowerCase().replace(/\s+/g, " ");
            if (!left || !normalizedOp || !this.pythonMarkerOperatorIsValid(normalizedOp) || !right) return undefined;
            return { kind: "atom", left, op: normalizedOp, right };
        };
        const parseAnd = (): PythonMarkerExpression | undefined => {
            let expression = parseAtom();
            while (expression && peek()?.toLowerCase() === "and") {
                take();
                const right = parseAtom();
                if (!right) return undefined;
                expression = { kind: "and", left: expression, right };
            }
            return expression;
        };
        const parseOr = (): PythonMarkerExpression | undefined => {
            let expression = parseAnd();
            while (expression && peek()?.toLowerCase() === "or") {
                take();
                const right = parseAnd();
                if (!right) return undefined;
                expression = { kind: "or", left: expression, right };
            }
            return expression;
        };

        const expression = parseOr();
        return expression && index === tokens.length ? expression : undefined;
    }

    private pythonMarkerOperatorIsValid(op: string): boolean {
        return op === "in"
            || op === "not in"
            || op === "=="
            || op === "!="
            || op === "~="
            || op === ">="
            || op === "<="
            || op === ">"
            || op === "<"
            || op === "===";
    }

    private pythonMarkerVariableNameIsValid(name: string): boolean {
        return name === "python_version"
            || name === "python_full_version"
            || name === "os_name"
            || name === "sys_platform"
            || name === "platform_release"
            || name === "platform_system"
            || name === "platform_version"
            || name === "platform_machine"
            || name === "platform_python_implementation"
            || name === "python_implementation"
            || name === "implementation_name"
            || name === "implementation_version"
            || name === "extra"
            || name === "extras"
            || name === "dependency_groups";
    }

    private tokenizePythonMarker(marker: string): string[] {
        const tokens: string[] = [];
        let index = 0;
        while (index < marker.length) {
            const rest = marker.slice(index);
            const whitespace = rest.match(/^\s+/);
            if (whitespace) {
                index += whitespace[0].length;
                continue;
            }

            const quoted = rest.match(/^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'/);
            if (quoted) {
                tokens.push(quoted[0]);
                index += quoted[0].length;
                continue;
            }

            const notIn = rest.match(/^not\s+in\b/i);
            if (notIn) {
                tokens.push("not in");
                index += notIn[0].length;
                continue;
            }

            const wordOperator = rest.match(/^(?:in|and|or)\b/i);
            if (wordOperator) {
                tokens.push(wordOperator[0].toLowerCase());
                index += wordOperator[0].length;
                continue;
            }

            const operatorMatch = rest.match(/^(?:===|==|!=|~=|>=|<=|>|<)/);
            if (operatorMatch) {
                tokens.push(operatorMatch[0]);
                index += operatorMatch[0].length;
                continue;
            }

            const paren = rest.match(/^[()]/);
            if (paren) {
                tokens.push(paren[0]);
                index += 1;
                continue;
            }

            const variable = rest.match(/^[A-Za-z0-9_.]+/);
            if (variable) {
                tokens.push(variable[0]);
                index += variable[0].length;
                continue;
            }

            return [];
        }
        return tokens;
    }

    private unquotePythonMarkerString(text: string): string {
        const quote = text[0];
        if ((quote !== "\"" && quote !== "'") || text[text.length - 1] !== quote) return text;
        return text
            .slice(1, -1)
            .replace(/\\(["'\\bfnrt])/g, (_match, escaped: string) => {
                if (escaped === "b") return "\b";
                if (escaped === "f") return "\f";
                if (escaped === "n") return "\n";
                if (escaped === "r") return "\r";
                if (escaped === "t") return "\t";
                return escaped;
            });
    }

    private evaluatePythonMarkerExpression(expression: PythonMarkerExpression, pythonVersion: string, extra: string): boolean {
        if (expression.kind === "and") {
            return this.evaluatePythonMarkerExpression(expression.left, pythonVersion, extra)
                && this.evaluatePythonMarkerExpression(expression.right, pythonVersion, extra);
        }
        if (expression.kind === "or") {
            return this.evaluatePythonMarkerExpression(expression.left, pythonVersion, extra)
                || this.evaluatePythonMarkerExpression(expression.right, pythonVersion, extra);
        }

        if (expression.kind !== "atom") return false;
        const left = this.pythonMarkerTerm(expression.left, pythonVersion, extra);
        const right = this.pythonMarkerTerm(expression.right, pythonVersion, extra);
        const environmentKey = expression.left.kind === "variable" ? expression.left.value : expression.right.value;
        return this.evaluatePythonMarkerComparison(left, expression.op, right, environmentKey);
    }

    private evaluatePythonMarkerComparison(left: string, op: string, right: string, environmentKey: string): boolean {
        let lhs = left;
        let rhs = right;
        if (environmentKey === "extra") {
            lhs = this.normalizePackageName(lhs);
            rhs = this.normalizePackageName(rhs);
        }

        if (this.pythonMarkerKeyRequiresVersion(environmentKey) && op !== "in" && op !== "not in") {
            const versionResult = this.evaluatePythonMarkerVersionComparison(lhs, op, rhs);
            if (versionResult != null) return versionResult;
        }

        return this.evaluatePythonMarkerStringComparison(lhs, op, rhs);
    }

    private evaluatePythonMarkerVersionComparison(left: string, op: string, right: string): boolean | undefined {
        if (op === "===") return left === right;
        if (!this.pythonMarkerSpecifierIsValid(op, right)) return undefined;
        return this.pythonPackageVersionSatisfies(left, `${op}${right}`);
    }

    private pythonMarkerSpecifierIsValid(op: string, version: string): boolean {
        if (!/^(==|!=|~=|>=|<=|>|<)$/.test(op)) return false;
        if ((op === "==" || op === "!=") && /\.\*$/.test(version)) {
            return this.parsePep440Version(version.replace(/\.\*$/, "")) != null;
        }
        return this.parsePep440Version(version) != null;
    }

    private evaluatePythonMarkerStringComparison(left: string, op: string, right: string): boolean {
        const lhs = left;
        const rhs = right;
        if (op === "in") return rhs.includes(lhs);
        if (op === "not in") return !rhs.includes(lhs);
        if (op === "==") return lhs === rhs;
        if (op === "!=") return lhs !== rhs;
        if (op === "<=" || op === ">=") return lhs === rhs;
        if (op === "<" || op === ">") return false;
        if (op === "===") return lhs === rhs;
        return false;
    }

    private pythonMarkerKeyRequiresVersion(key: string): boolean {
        return key === "implementation_version"
            || key === "platform_release"
            || key === "python_full_version"
            || key === "python_version";
    }

    private pythonMarkerTerm(term: PythonMarkerTerm, pythonVersion: string, extra: string): string {
        return term.kind === "value" ? term.value : this.pythonMarkerVariable(term.value, pythonVersion, extra);
    }

    private pythonMarkerVariable(name: string, pythonVersion: string, extra: string): string {
        const series = this.pythonSeries(pythonVersion);
        if (name === "python_version") return series;
        if (name === "python_full_version") return pythonVersion;
        if (name === "sys_platform") return process.platform === "win32" ? "win32" : process.platform;
        if (name === "platform_system") {
            if (process.platform === "win32") return "Windows";
            if (process.platform === "darwin") return "Darwin";
            return "Linux";
        }
        if (name === "platform_machine") {
            return this.pythonMarkerPlatformMachine();
        }
        if (name === "os_name") return process.platform === "win32" ? "nt" : "posix";
        if (name === "implementation_name") return "cpython";
        if (name === "platform_python_implementation") return "CPython";
        if (name === "implementation_version") return pythonVersion;
        if (name === "platform_release") return os.release();
        if (name === "platform_version") return this.pythonMarkerPlatformVersion();
        if (name === "extra") return extra;
        return name;
    }

    private pythonMarkerPlatformMachine(): string {
        if (process.platform === "win32") {
            if (process.arch === "x64") return "AMD64";
            if (process.arch === "ia32") return "x86";
            if (process.arch === "arm64") return "ARM64";
            if (process.arch === "arm") return "ARM";
            return process.arch;
        }

        if (process.platform === "linux") {
            if (process.arch === "x64") return "x86_64";
            if (process.arch === "arm64") return "aarch64";
            if (process.arch === "ia32") return "i686";
            return process.arch;
        }

        if (process.platform === "darwin") {
            if (process.arch === "x64") return "x86_64";
            if (process.arch === "arm64") return "arm64";
        }

        return process.arch;
    }

    private pythonMarkerPlatformVersion(): string {
        const versionFn = (os as typeof os & { version?: () => string }).version;
        if (typeof versionFn === "function") {
            try {
                return versionFn();
            } catch {
                return os.release();
            }
        }
        return os.release();
    }

    private pythonPackageVersionSatisfies(version: string, specifier: string): boolean {
        const clauses = this.splitSpecifierClauses(specifier);
        for (const clause of clauses) {
            const match = clause.match(/^(===|==|!=|~=|>=|<=|>|<)\s*(.+)$/);
            if (!match?.[1] || !match[2]) continue;
            const op = match[1];
            const target = match[2].trim();
            if (!this.pythonPackageVersionSatisfiesClause(version, op, target)) return false;
        }
        return true;
    }

    private pythonSpecifierSetHasExactPin(specifier: string): boolean {
        return this.splitSpecifierClauses(specifier).some((clause) => {
            const match = clause.match(/^(===|==)\s*(.+)$/);
            if (!match?.[2]) return false;
            return !/\.\*$/.test(match[2].trim());
        });
    }

    private pythonSpecifierSetAllowsPrereleases(specifier: string): boolean {
        return this.splitSpecifierClauses(specifier).some((clause) => {
            const match = clause.match(/^(===|==|!=|~=|>=|<=|>|<)\s*(.+)$/);
            if (!match?.[1] || !match[2]) return false;
            const op = match[1];
            const version = match[2].trim();
            if (op === "!=") return false;
            if (op === "==" && version.endsWith(".*")) return false;
            if (op === "===") return false;
            return this.isPackagePrerelease(version);
        });
    }

    private filterPep440Prereleases<T>(items: T[], versionOf: (item: T) => string = (item) => String((item as [string, unknown])[0])): T[] {
        const finalItems = items.filter((item) => !this.isPackagePrerelease(versionOf(item)));
        return finalItems.length > 0 ? finalItems : items;
    }

    private splitSpecifierClauses(specifier: string): string[] {
        const clauses: string[] = [];
        let quote = "";
        let start = 0;
        for (let index = 0; index < specifier.length; index += 1) {
            const char = specifier[index] ?? "";
            if (quote) {
                if (char === quote) quote = "";
                continue;
            }
            if (char === "'" || char === "\"") {
                quote = char;
                continue;
            }
            if (char === ",") {
                const clause = specifier.slice(start, index).trim();
                if (clause) clauses.push(clause);
                start = index + 1;
            }
        }
        const finalClause = specifier.slice(start).trim();
        if (finalClause) clauses.push(finalClause);
        return clauses;
    }

    private pythonPackageVersionSatisfiesClause(version: string, op: string, target: string): boolean {
        if (op === "===") return version === target;

        const parsed = this.parsePep440Version(version);
        const targetVersion = this.parsePep440Version(target.replace(/\.\*$/, ""));
        if (!parsed || !targetVersion) {
            if (op === "==") return version === target;
            if (op === "!=") return version !== target;
            return false;
        }

        if ((op === "==" || op === "!=") && /\.\*$/.test(target)) {
            const matches = this.pep440VersionMatchesPrefix(parsed, target.slice(0, -2));
            return op === "==" ? matches : !matches;
        }

        if (op === "==" || op === "!=") {
            const matches = targetVersion.local.length > 0
                ? parsed.normalized === targetVersion.normalized
                : parsed.publicVersion === targetVersion.publicVersion;
            return op === "==" ? matches : !matches;
        }

        if (op === "~=") {
            return this.comparePep440Versions(parsed, targetVersion) >= 0
                && this.comparePackageVersions(version, this.compatibleReleaseUpperBound(target)) < 0;
        }

        const cmp = this.comparePep440Versions(parsed, targetVersion);
        if (op === ">=") return cmp >= 0;
        if (op === "<=") {
            return cmp <= 0 || (targetVersion.local.length === 0 && parsed.publicVersion === targetVersion.publicVersion);
        }
        if (op === ">") {
            if (cmp <= 0) return false;
            if (targetVersion.local.length === 0 && parsed.publicVersion === targetVersion.publicVersion) return false;
            if (targetVersion.pre == null && targetVersion.dev == null && targetVersion.post == null && parsed.post != null && this.pep440SameReleaseFamily(parsed, targetVersion)) return false;
            return true;
        }
        if (op === "<") {
            if (cmp >= 0) return false;
            if (targetVersion.local.length === 0 && parsed.publicVersion === targetVersion.publicVersion) return false;
            if (targetVersion.pre == null && targetVersion.dev == null && targetVersion.post == null && (parsed.pre != null || parsed.dev != null) && this.pep440SameReleaseFamily(parsed, targetVersion)) return false;
            if (targetVersion.post != null && targetVersion.dev == null && parsed.dev != null && parsed.post === targetVersion.post && this.pep440SameReleaseFamily(parsed, targetVersion)) return false;
            return true;
        }
        return true;
    }

    private compatibleReleaseUpperBound(version: string): string {
        const parsed = this.parsePep440Version(version);
        const release = parsed?.release ?? this.packageReleaseTuple(version);
        if (release.length <= 1) return `${(release[0] ?? 0) + 1}`;
        const upper = release.slice(0, -1);
        upper[upper.length - 1] = (upper[upper.length - 1] ?? 0) + 1;
        return `${upper.join(".")}.dev0`;
    }

    private comparePackageVersions(left: string, right: string): number {
        const leftVersion = this.parsePep440Version(left);
        const rightVersion = this.parsePep440Version(right);
        if (leftVersion && rightVersion) return this.comparePep440Versions(leftVersion, rightVersion);

        const leftRelease = this.packageReleaseTuple(left);
        const rightRelease = this.packageReleaseTuple(right);
        for (let index = 0; index < Math.max(leftRelease.length, rightRelease.length); index += 1) {
            const diff = (leftRelease[index] ?? 0) - (rightRelease[index] ?? 0);
            if (diff !== 0) return diff;
        }

        const leftRank = this.packageSuffixRank(left);
        const rightRank = this.packageSuffixRank(right);
        if (leftRank !== rightRank) return leftRank - rightRank;
        return left.localeCompare(right);
    }

    private parsePep440Version(version: string): Pep440Version | undefined {
        let text = version.trim();
        if (!text) return undefined;
        text = text.replace(/^\s*[vV]/, "");

        const localParts = text.split("+");
        if (localParts.length > 2) return undefined;
        const local = (localParts[1] ?? "")
            .split(/[._-]/)
            .filter(Boolean)
            .map((part) => /^\d+$/.test(part) ? Number(part) : part.toLowerCase());
        text = localParts[0] ?? "";

        let epoch = 0;
        const epochMatch = text.match(/^(\d+)!/);
        if (epochMatch?.[1]) {
            epoch = Number(epochMatch[1]);
            text = text.slice(epochMatch[0].length);
        }

        const releaseMatch = text.match(/^(\d+(?:\.\d+)*)/);
        if (!releaseMatch?.[1]) return undefined;
        const releaseText = releaseMatch[1];
        const release = releaseText.split(".").map(Number);
        text = text.slice(releaseText.length);

        let pre: [number, number] | undefined;
        let post: number | undefined;
        let dev: number | undefined;

        while (text.length > 0) {
            const preMatch = text.match(/^[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*)/i);
            if (preMatch?.[1]) {
                const phase = preMatch[1].toLowerCase();
                const rank = phase === "a" || phase === "alpha" ? 0 : phase === "b" || phase === "beta" ? 1 : 2;
                pre = [rank, preMatch[2] ? Number(preMatch[2]) : 0];
                text = text.slice(preMatch[0].length);
                continue;
            }

            const postMatch = text.match(/^(?:[-_.]?(post|rev|r)[-_.]?(\d*)|-(\d+))/i);
            if (postMatch) {
                post = Number(postMatch[2] || postMatch[3] || "0");
                text = text.slice(postMatch[0].length);
                continue;
            }

            const devMatch = text.match(/^[-_.]?dev[-_.]?(\d*)/i);
            if (devMatch) {
                dev = Number(devMatch[1] || "0");
                text = text.slice(devMatch[0].length);
                continue;
            }

            return undefined;
        }

        const releasePublic = release.join(".");
        const preText = pre ? `${["a", "b", "rc"][pre[0]]}${pre[1]}` : "";
        const postText = post != null ? `.post${post}` : "";
        const devText = dev != null ? `.dev${dev}` : "";
        const epochText = epoch > 0 ? `${epoch}!` : "";
        const publicVersion = `${epochText}${releasePublic}${preText}${postText}${devText}`;
        const localText = local.length > 0 ? `+${local.join(".")}` : "";

        return {
            raw: version,
            normalized: `${publicVersion}${localText}`,
            publicVersion,
            epoch,
            release,
            pre,
            post,
            dev,
            local,
        };
    }

    private comparePep440Versions(left: Pep440Version, right: Pep440Version): number {
        if (left.epoch !== right.epoch) return left.epoch - right.epoch;
        const releaseLength = Math.max(left.release.length, right.release.length);
        for (let index = 0; index < releaseLength; index += 1) {
            const diff = (left.release[index] ?? 0) - (right.release[index] ?? 0);
            if (diff !== 0) return diff;
        }

        const preDiff = this.comparePep440Tuple(this.pep440PreKey(left), this.pep440PreKey(right));
        if (preDiff !== 0) return preDiff;

        const postDiff = this.comparePep440NumberKey(this.pep440PostKey(left), this.pep440PostKey(right));
        if (postDiff !== 0) return postDiff;

        const devDiff = this.comparePep440NumberKey(this.pep440DevKey(left), this.pep440DevKey(right));
        if (devDiff !== 0) return devDiff;

        return this.comparePep440Local(left.local, right.local);
    }

    private pep440PreKey(version: Pep440Version): [number, number] {
        if (version.pre) return version.pre;
        if (version.post == null && version.dev != null) return [-1, version.dev];
        return [Number.POSITIVE_INFINITY, 0];
    }

    private pep440PostKey(version: Pep440Version): number {
        return version.post ?? Number.NEGATIVE_INFINITY;
    }

    private pep440DevKey(version: Pep440Version): number {
        return version.dev ?? Number.POSITIVE_INFINITY;
    }

    private comparePep440Tuple(left: [number, number], right: [number, number]): number {
        const first = this.comparePep440NumberKey(left[0], right[0]);
        return first !== 0 ? first : this.comparePep440NumberKey(left[1], right[1]);
    }

    private comparePep440NumberKey(left: number, right: number): number {
        if (Object.is(left, right) || left === right) return 0;
        return left < right ? -1 : 1;
    }

    private comparePep440Local(left: Array<string | number>, right: Array<string | number>): number {
        if (left.length === 0 && right.length === 0) return 0;
        if (left.length === 0) return -1;
        if (right.length === 0) return 1;
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
            const leftPart = left[index];
            const rightPart = right[index];
            if (leftPart == null) return -1;
            if (rightPart == null) return 1;
            if (typeof leftPart === "number" && typeof rightPart === "number") {
                if (leftPart !== rightPart) return leftPart - rightPart;
                continue;
            }
            if (typeof leftPart === "number") return 1;
            if (typeof rightPart === "number") return -1;
            const diff = leftPart.localeCompare(rightPart);
            if (diff !== 0) return diff;
        }
        return 0;
    }

    private pep440VersionMatchesPrefix(version: Pep440Version, prefix: string): boolean {
        const normalizedPrefix = this.parsePep440Version(prefix);
        if (!normalizedPrefix) return false;
        if (version.epoch !== normalizedPrefix.epoch) return false;
        for (let index = 0; index < normalizedPrefix.release.length; index += 1) {
            if ((version.release[index] ?? 0) !== normalizedPrefix.release[index]) return false;
        }
        return true;
    }

    private pep440SameReleaseFamily(left: Pep440Version, right: Pep440Version): boolean {
        if (left.epoch !== right.epoch) return false;
        const releaseLength = Math.max(left.release.length, right.release.length);
        for (let index = 0; index < releaseLength; index += 1) {
            if ((left.release[index] ?? 0) !== (right.release[index] ?? 0)) return false;
        }
        return true;
    }

    private packageReleaseTuple(version: string): number[] {
        const normalized = version.trim().replace(/^[vV]/, "").split(/[+!]/).pop() ?? version;
        return normalized.match(/^\d+(?:\.\d+)*/)?.[0].split(".").map(Number) ?? [0];
    }

    private packageSuffixRank(version: string): number {
        const lower = version.toLowerCase();
        if (/(?:^|[.-])dev\d*/.test(lower)) return -4;
        if (/(?:a|alpha)\d*/.test(lower)) return -3;
        if (/(?:b|beta)\d*/.test(lower)) return -2;
        if (/(?:rc|c)\d*/.test(lower)) return -1;
        if (/(?:post|rev|r)\d*/.test(lower)) return 1;
        return 0;
    }

    private isPackagePrerelease(version: string): boolean {
        const parsed = this.parsePep440Version(version);
        return parsed ? parsed.pre != null || parsed.dev != null : /(?:a|alpha|b|beta|rc|dev)\d*/i.test(version);
    }

    private isCompatibleWheelFilename(filename: string, pythonVersion: string): boolean {
        return this.wheelSupportIndex(filename, pythonVersion) != null;
    }

    private wheelSupportIndex(filename: string, pythonVersion: string): number | undefined {
        const wheel = this.parseWheelFilename(filename);
        if (!wheel) return undefined;

        const cacheKey = `${pythonVersion}|${process.platform}|${process.arch}`;
        let supportedIndexes = this.supportedWheelTagIndexesCache.get(cacheKey);
        if (!supportedIndexes) {
            const createdIndexes = new Map<string, number>();
            this.getSupportedWheelTags(pythonVersion).forEach((tag, index) => {
                const key = this.wheelTagKey(tag);
                if (!createdIndexes.has(key)) createdIndexes.set(key, index);
            });
            this.supportedWheelTagIndexesCache.set(cacheKey, createdIndexes);
            supportedIndexes = createdIndexes;
        }

        let best: number | undefined;
        for (const tag of wheel.fileTags) {
            const index = supportedIndexes.get(this.wheelTagKey(tag));
            if (index == null) continue;
            best = best == null ? index : Math.min(best, index);
        }
        return best;
    }

    private getSupportedWheelTags(pythonVersion: string): WheelTag[] {
        const cacheKey = `${pythonVersion}|${process.platform}|${process.arch}`;
        const cached = this.supportedWheelTagsCache.get(cacheKey);
        if (cached) return cached;
        const pythonTuple = this.pythonVersionTuple(pythonVersion);
        const interpreter = `cp${this.versionNoDot(pythonTuple)}`;
        const platforms = this.platformWheelTags();
        const tags = [
            ...this.cpythonWheelTags(pythonTuple, platforms),
            ...this.compatibleWheelTags(pythonTuple, interpreter, platforms),
        ];
        this.supportedWheelTagsCache.set(cacheKey, tags);
        return tags;
    }

    private cpythonWheelTags(pythonVersion: [number, number], platforms: string[]): WheelTag[] {
        const interpreter = `cp${this.versionNoDot(pythonVersion)}`;
        const abi = interpreter;
        const tags: WheelTag[] = [];

        for (const platformTag of platforms) {
            tags.push(this.makeWheelTag(interpreter, abi, platformTag));
        }

        if (this.abi3Applies(pythonVersion)) {
            for (const platformTag of platforms) {
                tags.push(this.makeWheelTag(interpreter, "abi3", platformTag));
            }
        }

        for (const platformTag of platforms) {
            tags.push(this.makeWheelTag(interpreter, "none", platformTag));
        }

        if (this.abi3Applies(pythonVersion)) {
            for (let minor = pythonVersion[1] - 1; minor > 1; minor -= 1) {
                const olderInterpreter = `cp${this.versionNoDot([pythonVersion[0], minor])}`;
                for (const platformTag of platforms) {
                    tags.push(this.makeWheelTag(olderInterpreter, "abi3", platformTag));
                }
            }
        }

        return tags;
    }

    private compatibleWheelTags(pythonVersion: [number, number], interpreter: string, platforms: string[]): WheelTag[] {
        const tags: WheelTag[] = [];
        for (const pyTag of this.pyInterpreterRange(pythonVersion)) {
            for (const platformTag of platforms) {
                tags.push(this.makeWheelTag(pyTag, "none", platformTag));
            }
        }
        tags.push(this.makeWheelTag(interpreter, "none", "any"));
        for (const pyTag of this.pyInterpreterRange(pythonVersion)) {
            tags.push(this.makeWheelTag(pyTag, "none", "any"));
        }
        return tags;
    }

    private platformWheelTags(): string[] {
        if (process.platform === "darwin") {
            return this.macPlatformWheelTags(this.currentMacOSVersion(), this.nodeArchToWheelArch(process.arch));
        }
        if (process.platform === "win32") {
            if (process.arch === "x64") return ["win_amd64"];
            if (process.arch === "ia32") return ["win32"];
            if (process.arch === "arm64") return ["win_arm64"];
            return [];
        }
        if (process.platform === "linux") {
            return this.linuxPlatformWheelTags(this.nodeArchToWheelArch(process.arch));
        }
        return [];
    }

    //   private wheelPreferenceScore(filename: string, pythonVersion: string): number {
    //     const supportIndex = this.wheelSupportIndex(filename, pythonVersion);
    //     return supportIndex == null ? 0 : Number.MAX_SAFE_INTEGER - supportIndex;
    //   }

    private parseWheelFilename(filename: string): ParsedWheelFilename | undefined {
        if (!filename.endsWith(".whl")) return undefined;
        const stem = filename.slice(0, -4);
        const dashCount = (stem.match(/-/g) ?? []).length;
        if (dashCount !== 4 && dashCount !== 5) return undefined;

        const parts = stem.split("-");
        const platformPart = parts.pop();
        const abiPart = parts.pop();
        const interpreterPart = parts.pop();
        const version = parts[1];
        const name = parts[0];
        const build = parts[2];
        if (!name || !version || !platformPart || !abiPart || !interpreterPart) return undefined;
        if (parts.length !== 2 && parts.length !== 3) return undefined;
        if (/__/.test(name) || !/^[\w\d._]+$/u.test(name)) return undefined;
        if (!this.parsePep440Version(version)) return undefined;
        if (build && !/^(\d+)(.*)$/.test(build)) return undefined;

        const buildMatch = build?.match(/^(\d+)(.*)$/);
        return {
            name: this.normalizePackageName(name),
            version,
            buildTag: buildMatch?.[1] ? [Number(buildMatch[1]), buildMatch[2] ?? ""] : [],
            fileTags: this.parseWheelTag(`${interpreterPart}-${abiPart}-${platformPart}`),
        };
    }

    private parseSdistFilename(filename: string): { name: string; version: string } | undefined {
        const extension = filename.endsWith(".tar.gz") ? ".tar.gz" : filename.endsWith(".zip") ? ".zip" : "";
        if (!extension) return undefined;

        const stem = filename.slice(0, -extension.length);
        const splitIndex = stem.lastIndexOf("-");
        if (splitIndex <= 0 || splitIndex >= stem.length - 1) return undefined;

        const name = this.normalizePackageName(stem.slice(0, splitIndex));
        const version = stem.slice(splitIndex + 1);
        if (!this.parsePep440Version(version)) return undefined;
        return { name, version };
    }

    private parseWheelTag(tag: string): WheelTag[] {
        const [interpreters, abis, platforms] = tag.split("-");
        if (!interpreters || !abis || !platforms) return [];
        const tags: WheelTag[] = [];
        for (const interpreter of interpreters.split(".")) {
            for (const abi of abis.split(".")) {
                for (const platform of platforms.split(".")) {
                    tags.push(this.makeWheelTag(interpreter, abi, platform));
                }
            }
        }
        return tags;
    }

    private makeWheelTag(interpreter: string, abi: string, platform: string): WheelTag {
        return {
            interpreter: interpreter.toLowerCase(),
            abi: abi.toLowerCase(),
            platform: platform.toLowerCase(),
        };
    }

    private wheelTagKey(tag: WheelTag): string {
        return `${tag.interpreter}-${tag.abi}-${tag.platform}`;
    }

    private pythonVersionTuple(pythonVersion: string): [number, number] {
        const match = pythonVersion.match(/^(\d+)(?:\.(\d+))?/);
        return [Number(match?.[1] ?? "3"), Number(match?.[2] ?? "0")];
    }

    private versionNoDot(version: [number, number]): string {
        return `${version[0]}${version[1]}`;
    }

    private abi3Applies(pythonVersion: [number, number]): boolean {
        return pythonVersion[0] === 3 && pythonVersion[1] >= 2;
    }

    private pyInterpreterRange(pythonVersion: [number, number]): string[] {
        const tags = [`py${this.versionNoDot(pythonVersion)}`, `py${pythonVersion[0]}`];
        for (let minor = pythonVersion[1] - 1; minor >= 0; minor -= 1) {
            tags.push(`py${this.versionNoDot([pythonVersion[0], minor])}`);
        }
        return tags;
    }

    private nodeArchToWheelArch(arch: NodeJS.Architecture): string {
        if (process.platform === "linux") {
            if (arch === "x64") return "x86_64";
            if (arch === "arm64") return "aarch64";
            if (arch === "ia32") return "i686";
            if (arch === "arm") return "armv7l";
            return arch;
        }
        if (arch === "x64") return "x86_64";
        if (arch === "arm64") return "arm64";
        if (arch === "ia32") return "i386";
        if (arch === "arm") return "armv7l";
        return arch;
    }

    private macPlatformWheelTags(version: [number, number], arch: string): string[] {
        const tags: string[] = [];
        if (version[0] === 10) {
            for (let minor = version[1]; minor >= 0; minor -= 1) {
                for (const binaryFormat of this.macBinaryFormats([10, minor], arch)) {
                    tags.push(`macosx_10_${minor}_${binaryFormat}`);
                }
            }
        }

        if (version[0] >= 11) {
            for (let major = version[0]; major > 10; major -= 1) {
                for (const binaryFormat of this.macBinaryFormats([major, 0], arch)) {
                    tags.push(`macosx_${major}_0_${binaryFormat}`);
                }
            }

            for (let minor = 16; minor > 3; minor -= 1) {
                if (arch === "x86_64") {
                    for (const binaryFormat of this.macBinaryFormats([10, minor], arch)) {
                        tags.push(`macosx_10_${minor}_${binaryFormat}`);
                    }
                } else {
                    tags.push(`macosx_10_${minor}_universal2`);
                }
            }
        }

        return tags;
    }

    private macBinaryFormats(version: [number, number], arch: string): string[] {
        const formats = [arch];
        if (arch === "x86_64") {
            if (version[0] === 10 && version[1] < 4) return [];
            formats.push("intel", "fat64", "fat32");
        } else if (arch === "i386") {
            if (version[0] === 10 && version[1] < 4) return [];
            formats.push("intel", "fat32", "fat");
        } else if (arch === "ppc64") {
            if (version[0] !== 10 || version[1] > 5 || version[1] < 4) return [];
            formats.push("fat64");
        } else if (arch === "ppc") {
            if (version[0] !== 10 || version[1] > 6) return [];
            formats.push("fat32", "fat");
        }

        if (arch === "arm64" || arch === "x86_64") formats.push("universal2");
        if (["x86_64", "i386", "ppc64", "ppc", "intel"].includes(arch)) formats.push("universal");
        return formats;
    }

    private linuxPlatformWheelTags(arch: string): string[] {
        const tags: string[] = [];
        const glibc = this.currentGlibcVersion();
        if (glibc) {
            const minimumMinor = arch === "x86_64" || arch === "i686" ? 5 : 17;
            for (let minor = glibc[1]; minor >= minimumMinor; minor -= 1) {
                tags.push(`manylinux_2_${minor}_${arch}`);
                if (minor === 17) tags.push(`manylinux2014_${arch}`);
                if ((arch === "x86_64" || arch === "i686") && minor === 12) tags.push(`manylinux2010_${arch}`);
                if ((arch === "x86_64" || arch === "i686") && minor === 5) tags.push(`manylinux1_${arch}`);
            }
        } else {
            tags.push(`musllinux_1_2_${arch}`, `musllinux_1_1_${arch}`, `musllinux_1_0_${arch}`);
        }
        tags.push(`linux_${arch}`);
        return tags;
    }

    private currentGlibcVersion(): [number, number] | undefined {
        const report = typeof process.report?.getReport === "function" ? process.report.getReport() : undefined;
        const header = report && typeof report === "object" && "header" in report
            ? (report as { header?: { glibcVersionRuntime?: unknown } }).header
            : undefined;
        const version = header?.glibcVersionRuntime;
        if (typeof version !== "string") return undefined;
        const match = version.match(/^(\d+)\.(\d+)/);
        if (!match?.[1] || !match[2]) return undefined;
        return [Number(match[1]), Number(match[2])];
    }

    private currentMacOSVersion(): [number, number] {
        const systemVersion = typeof process.getSystemVersion === "function" ? process.getSystemVersion() : "";
        const match = systemVersion.match(/^(\d+)(?:\.(\d+))?/);
        if (match?.[1]) return [Number(match[1]), Number(match[2] ?? "0")];
        const darwinMajor = Number(os.release().split(".")[0] ?? "0");
        if (darwinMajor >= 20) return [darwinMajor - 9, 0];
        if (darwinMajor >= 4) return [10, darwinMajor - 4];
        return [10, 0];
    }

    //   private wheelhouseRequirementKey(state: WheelhouseRequirementState): string {
    //     return `${state.directUrl ?? ""}|${state.constraints.slice().sort().join(",")}|${[...state.extras].sort().join(",")}|${state.requested ? "1" : "0"}`;
    //   }

    private packageVersionFromFilename(name: string, filename: string): string {
        const normalizedName = this.normalizePackageName(name);
        const wheelParts = /\.whl$/i.test(filename) ? filename.replace(/\.whl$/i, "").split("-") : [];
        if (wheelParts.length >= 2 && this.normalizePackageName(wheelParts[0] ?? "") === normalizedName) {
            return wheelParts[1] ?? "direct";
        }

        const sourceName = filename.replace(/\.(?:tar\.gz|tar\.bz2|tar|zip)$/i, "");
        const sourcePrefix = `${normalizedName}-`;
        const normalizedSourceName = this.normalizePackageName(sourceName);
        if (normalizedSourceName.startsWith(sourcePrefix)) {
            return sourceName.slice(sourcePrefix.length);
        }

        return "direct";
    }

    private normalizePackageExtra(extra: string): string {
        return extra.trim().toLowerCase().replace(/[-_.]+/g, "-");
    }

    private shouldSkipWheelhouseDependency(name: string): boolean {
        if (name === RequiresPythonIdentifier) return false;
        const normalized = this.normalizePackageName(name);
        return normalized === "python";
    }

    private normalizeWheelhouseArtifact(artifact: WheelhouseArtifact): WheelhouseArtifact {
        const url = artifact.url;
        if (!url) throw new Error("The wheelhouse resolver returned a package entry without a download URL.");

        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error(`The wheelhouse resolver returned an invalid package URL: ${url}`);
        }
        if (!/^https?:$/i.test(parsed.protocol) && parsed.protocol !== "file:") {
            throw new Error(`The wheelhouse resolver returned an unsupported package URL: ${url}`);
        }

        const filename = artifact.filename || this.filenameFromUrl(url);
        if (!filename) throw new Error(`Unable to determine package filename from ${url}`);
        return {
            name: this.normalizePackageName(artifact.name || filename),
            version: artifact.version || "unknown",
            url,
            filename,
            requested: Boolean(artifact.requested),
            size: artifact.size,
        };
    }

    private async downloadWheelhouseArtifact(
        artifact: WheelhouseArtifact,
        progressIndex: number,
        totalInfo: () => { total: number; complete: boolean },
        wheelhouseDirectory: string,
        runtimeRoot: string,
        attempt = 0,
    ): Promise<"completed" | "skipped"> {
        const destination = path.join(wheelhouseDirectory, artifact.filename);
        const info = totalInfo();
        const total = Math.max(info.total, progressIndex + 1, 1);
        const rawStart = progressIndex / total;
        const rawEnd = (progressIndex + 1) / total;
        const visibleStart = info.complete ? rawStart : Math.min(rawStart, 0.88);
        const visibleEnd = info.complete ? rawEnd : Math.min(rawEnd, 0.92);
        const itemStart = runtimeStepProgress("downloadPackage", visibleStart);
        const itemEnd = runtimeStepProgress("downloadPackage", visibleEnd);
        const localSource = this.localFilePathFromURL(artifact.url);

        if ((await this.waitForDownloadResume()) === "skipped") return "skipped";
        if (await this.prepareWheelhouseArtifactForUseOrResume(artifact, destination)) {
            if ((await this.waitForDownloadResume()) === "skipped") return "skipped";
            await this.emitBootstrapStage(
                PackageInstallStageTitle,
                `Using cached ${artifact.name} ${artifact.version}.`,
                itemEnd,
                true,
                1,
                artifact.size
                    ? `${this.formatByteCount(artifact.size)} / ${this.formatByteCount(artifact.size)}`
                    : "Using cached package file",
                visibleEnd,
            );
            return "completed";
        }
        if ((await this.waitForDownloadResume()) === "skipped") return "skipped";

        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            `Downloading ${artifact.name} ${artifact.version}.`,
            itemStart,
            true,
            0,
            artifact.size
                ? `0 B / ${this.formatByteCount(artifact.size)}`
                : "Preparing download",
            visibleStart,
        );

        if (localSource) {
            await fs.promises.mkdir(path.dirname(destination), { recursive: true });
            await fs.promises.copyFile(localSource, destination);
            await this.emitBootstrapStage(
                PackageInstallStageTitle,
                `Downloading ${artifact.name} ${artifact.version}.`,
                itemEnd,
                true,
                1,
                artifact.size
                    ? `${this.formatByteCount(artifact.size)} / ${this.formatByteCount(artifact.size)}`
                    : "Copied local package file",
                visibleEnd,
            );
            return "completed";
        }

        const result = await this.downloadWheelhouseArtifactFile(
            artifact,
            destination,
            itemStart,
            itemEnd,
            (progress) => {
                const currentInfo = totalInfo();
                const currentTotal = Math.max(currentInfo.total, progressIndex + 1, 1);
                const currentStart = progressIndex / currentTotal;
                const currentEnd = (progressIndex + 1) / currentTotal;
                const mapped = currentStart + (currentEnd - currentStart) * clamp01(progress.fraction);
                return currentInfo.complete ? mapped : Math.min(mapped, 0.92);
            },
        );
        if (result === "skipped") {
            if (await this.hasInstalledPackage(runtimeRoot)) return "skipped";
            throw new Error("Dependency download was cancelled before the embedded package was available.");
        }

        if (!(await this.prepareWheelhouseArtifactForUseOrResume(artifact, destination))) {
            if (attempt >= 2) {
                throw new Error(`Downloaded package file did not pass validation: ${artifact.filename}`);
            }
            return await this.downloadWheelhouseArtifact(
                artifact,
                progressIndex,
                totalInfo,
                wheelhouseDirectory,
                runtimeRoot,
                attempt + 1,
            );
        }

        return "completed";
    }

    private async downloadWheelhouseArtifactFile(
        artifact: WheelhouseArtifact,
        destination: string,
        itemStart: number,
        itemEnd: number,
        mainProgressFractionForDownload: (progress: DownloadProgress) => number | undefined,
    ): Promise<"completed" | "skipped"> {
        const urls = this.wheelhouseArtifactDownloadUrls(artifact.url);
        let lastError: unknown;

        for (let index = 0; index < urls.length; index += 1) {
            if ((await this.waitForDownloadResume()) === "skipped") return "skipped";

            const url = urls[index];
            if (!url) continue;
            const hasMoreMirrors = index < urls.length - 1;
            let lowSpeedSince: number | undefined;
            let lowSpeedFallbackTriggered = false;
            if (index > 0) {
                this.preferTunaPyPIArtifactFilesForCurrentRun();
                this.traceDownload("artifact-file-mirror-retry", { filename: artifact.filename, url });
                await this.emitBootstrapStage(
                    PackageInstallStageTitle,
                    `Downloading ${artifact.name} ${artifact.version}.`,
                    itemStart,
                    true,
                    undefined,
                    "Switching package file mirror",
                    mainProgressFractionForDownload({
                        fraction: 0,
                        receivedBytes: await this.fileSizeOrZero(`${destination}.download`),
                        expectedBytes: artifact.size,
                    }),
                );
            }

            try {
                return await this.downloadFile(
                    url,
                    destination,
                    artifact.size,
                    PackageInstallStageTitle,
                    `Downloading ${artifact.name} ${artifact.version}.`,
                    itemStart,
                    itemEnd,
                    mainProgressFractionForDownload,
                    hasMoreMirrors
                        ? (progress, task) => {
                            if (lowSpeedFallbackTriggered || this.downloadPauseRequested) {
                                lowSpeedSince = undefined;
                                return;
                            }
                            if (progress.receivedBytes < PackageDownloadFallbackMinimumReceivedBytes) {
                                lowSpeedSince = undefined;
                                return;
                            }
                            if (progress.fraction >= 0.98) {
                                lowSpeedSince = undefined;
                                return;
                            }
                            const bytesPerSecond = progress.bytesPerSecond;
                            if (bytesPerSecond == null || bytesPerSecond <= 0 || bytesPerSecond >= PackageDownloadFallbackSpeedBytesPerSecond) {
                                lowSpeedSince = undefined;
                                return;
                            }

                            const now = Date.now();
                            lowSpeedSince ??= now;
                            if (now - lowSpeedSince < PackageDownloadFallbackLowSpeedWindowMs) return;

                            lowSpeedFallbackTriggered = true;
                            this.traceDownload("artifact-file-low-speed-fallback", {
                                filename: artifact.filename,
                                url,
                                bytesPerSecond,
                                threshold: PackageDownloadFallbackSpeedBytesPerSecond,
                                lowSpeedWindowMs: PackageDownloadFallbackLowSpeedWindowMs,
                                receivedBytes: progress.receivedBytes,
                            });
                            task.failForMirrorFallback(
                                `Download speed stayed below ${this.formatByteCount(PackageDownloadFallbackSpeedBytesPerSecond)}/s for ${Math.round(PackageDownloadFallbackLowSpeedWindowMs / 1000)}s while downloading ${artifact.filename}.`,
                            );
                        }
                        : undefined,
                );
            } catch (error) {
                lastError = error;
                if (error instanceof DownloadMirrorFallbackError) {
                    this.preferTunaPyPIArtifactFilesForCurrentRun();
                    continue;
                }
                if (index >= urls.length - 1 || !this.isExplicitNetworkFailure(error)) {
                    throw error instanceof Error ? error : new Error(String(error));
                }
                this.preferTunaPyPIArtifactFilesForCurrentRun();
            }
        }

        throw lastError instanceof Error ? lastError : new Error(`Unable to download package file: ${artifact.filename}`);
    }

    private wheelhouseArtifactDownloadUrls(url: string): string[] {
        const mirrorUrl = this.tunaPyPIArtifactFileUrl(url);
        if (!mirrorUrl || mirrorUrl === url) return [url];
        return this.preferTunaPyPI || this.preferTunaPyPIArtifactFiles
            ? [mirrorUrl]
            : [url, mirrorUrl];
    }

    private tunaPyPIArtifactFileUrl(url: string): string | undefined {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return undefined;
        }
        if (parsed.protocol !== "https:") return undefined;
        if (parsed.hostname !== "files.pythonhosted.org") return undefined;
        if (!parsed.pathname.startsWith("/packages/")) return undefined;
        return `https://pypi.tuna.tsinghua.edu.cn${parsed.pathname}${parsed.search}${parsed.hash}`;
    }

    private async downloadWheelhouseArtifacts(
        artifacts: WheelhouseArtifact[],
        wheelhouseDirectory: string,
        runtimeRoot: string,
    ): Promise<"completed" | "skipped"> {
        const missing: Array<{ artifact: WheelhouseArtifact; index: number }> = [];
        for (let index = 0; index < artifacts.length; index += 1) {
            if ((await this.waitForDownloadResume()) === "skipped") {
                if (await this.hasInstalledPackage(runtimeRoot)) return "skipped";
                throw new Error("Dependency download was cancelled before the embedded package was available.");
            }
            const artifact = artifacts[index];
            if (!artifact) continue;
            const destination = path.join(wheelhouseDirectory, artifact.filename);
            if (!(await this.prepareWheelhouseArtifactForUseOrResume(artifact, destination))) {
                missing.push({ artifact, index });
            }
            if ((index + 1) % 25 === 0) await this.yieldToEventLoop();
        }

        if (artifacts.length === 0) {
            await this.emitBootstrapStage(
                PackageInstallStageTitle,
                "No package files are required.",
                runtimeStepEnd("downloadPackage"),
                false,
                undefined,
                undefined,
            );
            return "completed";
        }

        if (missing.length === 0) {
            await this.emitBootstrapStage(
                PackageInstallStageTitle,
                "All package files are already cached locally.",
                runtimeStepEnd("downloadPackage"),
                false,
                undefined,
                undefined,
            );
            return "completed";
        }

        for (const { artifact, index } of missing) {
            if ((await this.waitForDownloadResume()) === "skipped") {
                if (await this.hasInstalledPackage(runtimeRoot)) return "skipped";
                throw new Error("Dependency download was cancelled before the embedded package was available.");
            }

            const destination = path.join(wheelhouseDirectory, artifact.filename);
            const itemStart = runtimeStepProgress("downloadPackage", artifacts.length > 0 ? index / artifacts.length : 0);
            const itemEnd = runtimeStepProgress("downloadPackage", artifacts.length > 0 ? (index + 1) / artifacts.length : 1);
            const localSource = this.localFilePathFromURL(artifact.url);

            await this.emitBootstrapStage(
                PackageInstallStageTitle,
                `Downloading ${artifact.name} ${artifact.version}.`,
                itemStart,
                true,
                0,
                artifact.size
                    ? `0 B / ${this.formatByteCount(artifact.size)}`
                    : "Preparing download",
                artifacts.length > 0 ? index / artifacts.length : 0,
            );

            if (localSource) {
                await fs.promises.mkdir(path.dirname(destination), { recursive: true });
                await fs.promises.copyFile(localSource, destination);
                await this.emitBootstrapStage(
                    PackageInstallStageTitle,
                    `Downloading ${artifact.name} ${artifact.version}.`,
                    itemEnd,
                    true,
                    1,
                    artifact.size
                        ? `${this.formatByteCount(artifact.size)} / ${this.formatByteCount(artifact.size)}`
                        : "Copied local package file",
                    artifacts.length > 0 ? (index + 1) / artifacts.length : 1,
                );
                continue;
            }

            const result = await this.downloadWheelhouseArtifactFile(
                artifact,
                destination,
                itemStart,
                itemEnd,
                (progress) => artifacts.length > 0 ? (index + clamp01(progress.fraction)) / artifacts.length : progress.fraction,
            );
            if (result === "skipped") {
                if (await this.hasInstalledPackage(runtimeRoot)) return "skipped";
                throw new Error("Dependency download was cancelled before the embedded package was available.");
            }

            if (!(await this.prepareWheelhouseArtifactForUseOrResume(artifact, destination))) {
                const retryResult = await this.downloadWheelhouseArtifactFile(
                    artifact,
                    destination,
                    itemStart,
                    itemEnd,
                    (progress) => artifacts.length > 0 ? (index + clamp01(progress.fraction)) / artifacts.length : progress.fraction,
                );
                if (retryResult === "skipped") {
                    if (await this.hasInstalledPackage(runtimeRoot)) return "skipped";
                    throw new Error("Dependency download was cancelled before the embedded package was available.");
                }
                if (!(await this.prepareWheelhouseArtifactForUseOrResume(artifact, destination))) {
                    throw new Error(`Downloaded package file did not pass validation: ${artifact.filename}`);
                }
            }

        }

        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            "All package files are available locally.",
            runtimeStepEnd("downloadPackage"),
            false,
            undefined,
            undefined,
        );
        return "completed";
    }

    private async prepareWheelhouseArtifactForUseOrResume(artifact: WheelhouseArtifact, destination: string): Promise<boolean> {
        if (!(await this.pathExists(destination))) {
            this.traceDownload("artifact-cache-miss", {
                filename: artifact.filename,
                temporaryBytes: await this.fileSizeOrZero(`${destination}.download`),
            });
            return false;
        }

        const expectedBytes = artifact.size;
        let actualBytes = 0;
        try {
            actualBytes = (await fs.promises.stat(destination)).size;
        } catch {
            return false;
        }

        if (expectedBytes == null || expectedBytes <= 0) {
            if (await this.isProbablyCompleteWheelhouseArchive(destination)) {
                this.traceDownload("artifact-cache-hit-archive-valid", { filename: artifact.filename, actualBytes });
                return true;
            }
            this.traceDownload("artifact-cache-partial-archive", { filename: artifact.filename, actualBytes });
            await this.adoptPartialWheelhouseArtifact(destination, `${destination}.download`, actualBytes);
            return false;
        }

        if (actualBytes === expectedBytes) {
            this.traceDownload("artifact-cache-hit-size", { filename: artifact.filename, actualBytes, expectedBytes });
            return true;
        }

        const temporaryPath = `${destination}.download`;
        if (actualBytes >= 0 && actualBytes < expectedBytes) {
            this.traceDownload("artifact-cache-partial-size", { filename: artifact.filename, actualBytes, expectedBytes, temporaryBytes: await this.fileSizeOrZero(temporaryPath) });
            await this.adoptPartialWheelhouseArtifact(destination, temporaryPath, actualBytes);
            return false;
        }

        this.traceDownload("artifact-cache-invalid-size", { filename: artifact.filename, actualBytes, expectedBytes });
        await this.moveInvalidWheelhouseArtifactAside(destination);
        return false;
    }

    private async fileSizeOrZero(filePath: string): Promise<number> {
        try {
            return (await fs.promises.stat(filePath)).size;
        } catch {
            return 0;
        }
    }

    private async isProbablyCompleteWheelhouseArchive(filePath: string): Promise<boolean> {
        if (/\.(?:whl|zip)$/i.test(filePath)) return await this.isProbablyCompleteZipArchive(filePath);
        if (/\.tar\.gz$/i.test(filePath)) return await this.isProbablyCompleteGzipArchive(filePath);
        return await this.pathExists(filePath);
    }

    private async isProbablyCompleteZipArchive(filePath: string): Promise<boolean> {
        let data: Buffer;
        let file: fs.promises.FileHandle | undefined;
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.size < 22) return false;
            const readSize = Math.min(stat.size, 66_000);
            file = await fs.promises.open(filePath, "r");
            data = Buffer.alloc(readSize);
            await file.read(data, 0, readSize, stat.size - readSize);
            const endOffset = stat.size - readSize;
            for (let i = data.length - 22; i >= 0; i -= 1) {
                if (data.readUInt32LE(i) !== 0x06054b50) continue;
                const commentLength = data.readUInt16LE(i + 20);
                if (i + 22 + commentLength !== data.length) continue;
                const centralDirectorySize = data.readUInt32LE(i + 12);
                const centralDirectoryOffset = data.readUInt32LE(i + 16);
                const eocdAbsoluteOffset = endOffset + i;
                return centralDirectoryOffset + centralDirectorySize <= eocdAbsoluteOffset;
            }
            return false;
        } catch {
            return false;
        } finally {
            await file?.close().catch(() => undefined);
        }
    }

    private async isProbablyCompleteGzipArchive(filePath: string): Promise<boolean> {
        try {
            return (await fs.promises.stat(filePath)).size >= 18;
        } catch {
            return false;
        }
    }

    private async adoptPartialWheelhouseArtifact(destination: string, temporaryPath: string, actualBytes: number): Promise<void> {
        let temporaryBytes = -1;
        try {
            temporaryBytes = (await fs.promises.stat(temporaryPath)).size;
        } catch {
            temporaryBytes = -1;
        }

        try {
            if (temporaryBytes >= actualBytes) {
                await this.moveInvalidWheelhouseArtifactAside(destination);
                return;
            }

            await fs.promises.rm(temporaryPath, { force: true });
            await fs.promises.rename(destination, temporaryPath);
        } catch {
            await this.moveInvalidWheelhouseArtifactAside(destination);
        }
    }

    private async moveInvalidWheelhouseArtifactAside(filePath: string): Promise<void> {
        if (!(await this.pathExists(filePath))) return;

        const invalidPath = `${filePath}.invalid-${Date.now().toString(36)}`;
        try {
            await fs.promises.rename(filePath, invalidPath);
        } catch {
            try { await fs.promises.rm(filePath, { force: true }); } catch { /* best effort */ }
        }
    }

    private localFilePathFromURL(url: string): string | undefined {
        try {
            const parsed = new URL(url);
            return parsed.protocol === "file:" ? fileURLToPath(parsed) : undefined;
        } catch {
            return undefined;
        }
    }

    private async uninstallConflictingInstalledDistributions(
        artifacts: WheelhouseArtifact[],
        runtimeRoot: string,
    ): Promise<boolean> {
        const installed = await this.readInstalledPythonDistributions(runtimeRoot);
        const targets = new Map<string, string>();
        for (const artifact of artifacts) {
            if (!artifact.name || !artifact.version || artifact.installed) continue;
            targets.set(this.normalizePackageName(artifact.name), artifact.version);
        }

        const actualLabelStudioVersion = targets.has("label-studio")
            ? await this.currentPackageVersion(runtimeRoot).catch(() => "Not installed")
            : "Not installed";

        const uninstallNames = [...targets.entries()]
            .filter(([name, targetVersion]) => {
                if (
                    name === "label-studio"
                    && actualLabelStudioVersion !== "Not installed"
                    && actualLabelStudioVersion !== targetVersion
                ) {
                    return true;
                }
                const records = installed.get(name) ?? [];
                return records.some((record) => record.version !== targetVersion);
            })
            .map(([name]) => name)
            .sort((left, right) => left.localeCompare(right));

        if (uninstallNames.length === 0) return false;

        const uninstallNameSet = new Set(uninstallNames);
        const cleanupSnapshots: Array<{
            distribution: InstalledPythonDistribution;
            recordPaths: string[];
        }> = [];
        for (const name of uninstallNames) {
            for (const distribution of installed.get(name) ?? []) {
                cleanupSnapshots.push({
                    distribution,
                    recordPaths: await this.installedDistributionRecordPaths(distribution, runtimeRoot),
                });
            }
        }
        const protectedPaths = new Set<string>();
        for (const [name, records] of installed) {
            if (uninstallNameSet.has(name)) continue;
            for (const record of records) {
                for (const filePath of await this.installedDistributionRecordPaths(record, runtimeRoot)) {
                    protectedPaths.add(await this.filesystemPathIdentity(filePath));
                }
            }
        }

        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            "Removing older installed package versions.",
            runtimeStepStart("installPackage"),
            false,
            undefined,
            undefined,
        );

        await this.runRuntimePythonProcess(
            ["-m", "pip", "uninstall", "--yes", "--disable-pip-version-check", "--no-input", ...uninstallNames],
            this.runtimePythonDir(runtimeRoot),
            await this.pipInstallEnvironment(runtimeRoot),
            false,
            runtimeStepStart("installPackage"),
            runtimeStepProgress("installPackage", 0.1),
            PackageInstallStageTitle,
        );

        for (const snapshot of cleanupSnapshots) {
            await this.removeInstalledDistributionRecordFiles(
                snapshot.distribution,
                snapshot.recordPaths,
                protectedPaths,
            );
        }

        const remaining = await this.readInstalledPythonDistributions(runtimeRoot);
        const remainingRecords = uninstallNames.flatMap((name) => remaining.get(name) ?? []);
        if (remainingRecords.length > 0) {
            const details = remainingRecords
                .map((distribution) => `${distribution.name} ${distribution.version} (${distribution.distInfoPath})`)
                .join(", ");
            throw new Error(`Older installed package files could not be removed: ${details}.`);
        }

        if (uninstallNameSet.has("label-studio")) {
            const remainingActualVersion = await this.currentPackageVersion(runtimeRoot).catch(() => "Not installed");
            if (remainingActualVersion !== "Not installed") {
                throw new Error(
                    `The older Label Studio package is still importable after uninstall. `
                    + `The managed runtime reports ${remainingActualVersion}.`,
                );
            }
        }
        return true;
    }

    private async reconcileInstalledDistributionVersions(
        runtimeRoot: string,
        desiredVersions: Map<string, string>,
        removeOrphanedPackages: boolean,
    ): Promise<void> {
        const installed = await this.readInstalledPythonDistributions(runtimeRoot);
        const staleDistributions: InstalledPythonDistribution[] = [];
        const staleDistributionPaths = new Set<string>();
        const retainedRuntimeTools = new Set(["pip", "setuptools", "wheel"]);

        for (const [name, records] of installed) {
            const desiredVersion = desiredVersions.get(name);
            if (!desiredVersion && (!removeOrphanedPackages || retainedRuntimeTools.has(name))) continue;
            for (const distribution of records) {
                if (desiredVersion && distribution.version === desiredVersion) continue;
                staleDistributions.push(distribution);
                staleDistributionPaths.add(await this.filesystemPathIdentity(distribution.distInfoPath));
            }
        }
        let remaining = installed;
        if (staleDistributions.length > 0) {
            const protectedPaths = new Set<string>();
            for (const records of installed.values()) {
                for (const distribution of records) {
                    if (staleDistributionPaths.has(await this.filesystemPathIdentity(distribution.distInfoPath))) continue;
                    for (const filePath of await this.installedDistributionRecordPaths(distribution, runtimeRoot)) {
                        protectedPaths.add(await this.filesystemPathIdentity(filePath));
                    }
                }
            }

            for (const distribution of staleDistributions) {
                await this.removeInstalledDistributionRecordFiles(
                    distribution,
                    await this.installedDistributionRecordPaths(distribution, runtimeRoot),
                    protectedPaths,
                );
            }
            remaining = await this.readInstalledPythonDistributions(runtimeRoot);
        }

        for (const [name, desiredVersion] of desiredVersions) {
            const records = remaining.get(name) ?? [];
            if (!records.some((distribution) => distribution.version === desiredVersion)) {
                throw new Error(`Package cleanup removed the selected ${name} ${desiredVersion} installation.`);
            }
            const staleVersions = [...new Set(
                records
                    .filter((distribution) => distribution.version !== desiredVersion)
                    .map((distribution) => distribution.version),
            )];
            if (staleVersions.length > 0) {
                throw new Error(`Older ${name} package metadata remains installed: ${staleVersions.join(", ")}.`);
            }
        }
    }

    private async installedDistributionRecordPaths(
        distribution: InstalledPythonDistribution,
        runtimeRoot: string,
    ): Promise<string[]> {
        const recordPath = path.join(distribution.distInfoPath, "RECORD");
        const paths = new Map<string, string>();
        const pycacheDirectories = new Map<string, fs.Dirent[]>();
        let entries: Array<{ base: string; relativePath: string }> = [];
        try {
            entries = (await fs.promises.readFile(recordPath, "utf8"))
                .split(/\r?\n/)
                .map((line) => ({
                    base: distribution.sitePackagesDirectory,
                    relativePath: this.pythonRecordRelativePath(line) ?? "",
                }));
        } catch {
            try {
                entries = (await fs.promises.readFile(path.join(distribution.distInfoPath, "installed-files.txt"), "utf8"))
                    .split(/\r?\n/)
                    .map((line) => ({ base: distribution.distInfoPath, relativePath: line.trim() }));
            } catch {
                return [];
            }
        }

        const addPath = async (candidate: string): Promise<void> => {
            const destination = path.resolve(candidate);
            if (!this.pathIsWithin(runtimeRoot, destination) || destination === path.resolve(runtimeRoot)) return;
            paths.set(await this.filesystemPathIdentity(destination), destination);
        };

        for (const entry of entries) {
            const relativePath = entry.relativePath;
            if (!relativePath) continue;
            const destination = path.resolve(
                entry.base,
                relativePath.replace(/\//g, path.sep),
            );
            await addPath(destination);
            if (!destination.toLowerCase().endsWith(".py")) continue;

            const extensionlessPath = destination.slice(0, -3);
            await addPath(`${extensionlessPath}.pyc`);
            await addPath(`${extensionlessPath}.pyo`);

            const sourceBaseName = path.basename(extensionlessPath);
            const pycacheDirectory = path.join(path.dirname(destination), "__pycache__");
            let pycacheEntries = pycacheDirectories.get(pycacheDirectory);
            if (!pycacheEntries) {
                try {
                    pycacheEntries = await fs.promises.readdir(pycacheDirectory, { withFileTypes: true });
                } catch {
                    pycacheEntries = [];
                }
                pycacheDirectories.set(pycacheDirectory, pycacheEntries);
            }
            for (const pycacheEntry of pycacheEntries) {
                if (!pycacheEntry.isFile() && !pycacheEntry.isSymbolicLink()) continue;
                if (!pycacheEntry.name.startsWith(`${sourceBaseName}.`) || !/\.py[co]$/i.test(pycacheEntry.name)) continue;
                await addPath(path.join(pycacheDirectory, pycacheEntry.name));
            }
        }
        return [...paths.values()];
    }

    private pythonRecordRelativePath(line: string): string | undefined {
        if (!line.startsWith('"')) return line.split(",", 1)[0]?.trim() || undefined;

        let value = "";
        for (let index = 1; index < line.length; index += 1) {
            const character = line[index];
            if (character !== '"') {
                value += character;
                continue;
            }
            if (line[index + 1] === '"') {
                value += '"';
                index += 1;
                continue;
            }
            return value.trim() || undefined;
        }
        return undefined;
    }

    private async removeInstalledDistributionRecordFiles(
        distribution: InstalledPythonDistribution,
        recordPaths: string[],
        protectedPaths: Set<string>,
    ): Promise<void> {
        const directories = new Set<string>();
        const distInfoIdentity = await this.filesystemPathIdentity(distribution.distInfoPath);
        for (const destination of recordPaths) {
            const destinationIdentity = await this.filesystemPathIdentity(destination);
            if (destinationIdentity === distInfoIdentity || protectedPaths.has(destinationIdentity)) continue;
            let stat: fs.Stats;
            try {
                stat = await fs.promises.lstat(destination);
            } catch (error) {
                if (this.fileSystemErrorCode(error) === "ENOENT") continue;
                throw error;
            }

            if (stat.isDirectory() && !stat.isSymbolicLink()) {
                try {
                    await fs.promises.rmdir(destination);
                } catch (error) {
                    const code = this.fileSystemErrorCode(error);
                    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
                }
            } else {
                try {
                    await fs.promises.rm(destination, { force: true });
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    throw new Error(`Could not remove an older installed package file: ${destination}\n\n${detail}`);
                }
            }

            this.collectEmptySitePackageDirectories(
                path.dirname(destination),
                distribution.sitePackagesDirectory,
                directories,
            );
        }

        try {
            await fs.promises.rm(distribution.distInfoPath, { recursive: true, force: true });
            this.collectEmptySitePackageDirectories(
                path.dirname(distribution.distInfoPath),
                distribution.sitePackagesDirectory,
                directories,
            );
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not remove older package metadata: ${distribution.distInfoPath}\n\n${detail}`);
        }
        for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
            try {
                if (directory !== distribution.sitePackagesDirectory) await fs.promises.rmdir(directory);
            } catch {
                /* keep non-empty directories */
            }
        }
    }

    private fileSystemErrorCode(error: unknown): string | undefined {
        if (!error || typeof error !== "object" || !("code" in error)) return undefined;
        return typeof error.code === "string" ? error.code : undefined;
    }

    private collectEmptySitePackageDirectories(
        directory: string,
        sitePackagesDirectory: string,
        directories: Set<string>,
    ): void {
        const root = path.resolve(sitePackagesDirectory);
        let current = path.resolve(directory);
        while (current !== root && this.pathIsWithin(root, current)) {
            directories.add(current);
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    }

    private async filesystemPathIdentity(filePath: string): Promise<string> {
        let resolved = path.resolve(filePath);
        try {
            resolved = await fs.promises.realpath(filePath);
        } catch {
            /* The target may already have been removed. */
        }
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    }

    private directoryHasEntries(directory: string): boolean {
        try {
            const stat = fs.lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
            return fs.readdirSync(directory).length > 0;
        } catch (error) {
            return this.fileSystemErrorCode(error) !== "ENOENT";
        }
    }

    private pathIsWithin(root: string, candidate: string): boolean {
        const relative = path.relative(path.resolve(root), path.resolve(candidate));
        return relative === ""
            || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    }

    private safePathWithin(root: string, relativePath: string): string | undefined {
        const destination = path.resolve(root, relativePath);
        const normalizedRoot = path.resolve(root);
        return destination === normalizedRoot || destination.startsWith(`${normalizedRoot}${path.sep}`)
            ? destination
            : undefined;
    }

    private async installPackageFromWheelhouse(
        artifacts: WheelhouseArtifact[],
        wheelhouseDirectory: string,
        runtimeRoot: string,
        upgrade: boolean,
    ): Promise<void> {
        const installEntries = [...artifacts].sort((left, right) => {
            if (left.requested !== right.requested) return left.requested ? 1 : -1;
            return left.name.localeCompare(right.name);
        });
        const requested = installEntries.find((v) => v.requested);
        const dependencyPaths = installEntries
            .filter((entry) => entry !== requested)
            .map((entry) => path.join(wheelhouseDirectory, entry.filename));
        const requestedPath = requested
            ? path.join(wheelhouseDirectory, requested.filename)
            : undefined;

        await this.preparePackageInstaller(runtimeRoot);
        const didUninstall = await this.uninstallConflictingInstalledDistributions(installEntries, runtimeRoot);
        const installStartFraction = didUninstall ? 0.1 : 0;
        const installStepProgress = (fraction: number): number =>
            runtimeStepProgress("installPackage", installStartFraction + (1 - installStartFraction) * clamp01(fraction));

        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            `Installing label-studio${requested?.version ? ` ${requested.version}` : ""} with pip.`,
            installStepProgress(0),
            false,
            undefined,
            undefined,
        );

        const commonArgs = [
            "-m", "pip", "install", "--upgrade",
            "--disable-pip-version-check", "--no-input", "--retries", "0",
            "--no-index", "--find-links", wheelhouseDirectory, "--no-deps",
        ];
        if (!upgrade) { /* Keep one install command shape for first install and update. */ }
        const environment = await this.pipInstallEnvironment(runtimeRoot);
        const installEntryCount = Math.max(installEntries.length, 1);
        const dependencyInstallEnd = dependencyPaths.length > 0
            ? installStepProgress(dependencyPaths.length / installEntryCount)
            : installStepProgress(0);
        if (dependencyPaths.length > 0) {
            await this.runRuntimePythonProcess(
                [...commonArgs, ...dependencyPaths],
                this.runtimePythonDir(runtimeRoot),
                environment,
                false,
                installStepProgress(0),
                requestedPath ? dependencyInstallEnd : installStepProgress(1),
                PackageInstallStageTitle,
            );
        }
        if (requestedPath) {
            await this.runRuntimePythonProcess(
                [...commonArgs, "--force-reinstall", requestedPath],
                this.runtimePythonDir(runtimeRoot),
                environment,
                false,
                dependencyPaths.length > 0 ? dependencyInstallEnd : installStepProgress(0),
                installStepProgress(1),
                PackageInstallStageTitle,
            );
        }

        await this.emitBootstrapStage(
            "Label Studio Installed",
            "Label Studio package files are installed in the embedded runtime.",
            runtimeStepEnd("installPackage"),
            false,
            undefined,
            undefined,
        );
    }

    private condaFallbackArtifactsFromWheelhouseFailure(
        error: unknown,
        artifacts: WheelhouseArtifact[],
    ): PackageFallbackArtifact[] {
        const failedNames = this.failedPackageNamesFromPipError(error);
        const failedArtifacts = artifacts.filter((artifact) => failedNames.has(this.normalizePackageName(artifact.name)));
        if (failedArtifacts.length > 0) return failedArtifacts;

        const text = error instanceof Error ? error.message : String(error);
        const versions = this.packageVersionsFromPipOutput(text);
        return [...failedNames].map((name) => ({
            name,
            version: versions.get(name) ?? "",
            url: "",
            filename: "",
            requested: false,
        }));
    }

    private condaFallbackArtifactsFromWheelhouseResolutionFailure(error: unknown): PackageFallbackArtifact[] {
        if (error instanceof WheelhouseResolutionError) {
            return [{
                name: this.normalizePackageName(error.packageName),
                version: this.exactVersionFromPythonConstraints(error.constraints),
                url: "",
                filename: "",
                requested: false,
            }];
        }

        const text = error instanceof Error ? error.message : String(error);
        const match = text.match(/Unable to resolve\s+([A-Za-z0-9_.-]+)(.*?)\s+for Python\s+/i);
        if (!match?.[1]) return [];

        const constraints = (match[2] ?? "")
            .split(",")
            .map((constraint) => constraint.trim())
            .filter(Boolean);
        return [{
            name: this.normalizePackageName(match[1]),
            version: this.exactVersionFromPythonConstraints(constraints),
            url: "",
            filename: "",
            requested: false,
        }];
    }

    private exactVersionFromPythonConstraints(constraints: readonly string[]): string {
        for (const constraint of constraints) {
            const match = constraint.trim().match(/^==\s*([^,*\s]+)$/);
            if (match?.[1]) return match[1];
        }
        return "";
    }

    private async installPackageAfterWheelhouseResolutionFailure(
        error: unknown,
        fallbackArtifacts: PackageFallbackArtifact[],
        spec: string,
        runtimeRoot: string,
        upgrade: boolean,
        indexUrl?: string,
    ): Promise<void> {
        this.appendRecentOutput(`Wheelhouse resolver fallback: ${error instanceof Error ? error.message : String(error)}`);
        this.traceDownload("resolver-fallback-start", {
            error: error instanceof Error ? error.message : String(error),
            fallbackArtifacts,
        });

        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            "Preparing binary package fallback.",
            runtimeStepStart("downloadPackage"),
            true,
            0,
            "Preparing binary package downloads",
            0,
        );

        try {
            await this.installCondaForgeFallbackPackages(fallbackArtifacts, runtimeRoot);
        } catch (condaError) {
            if (
                condaError instanceof ManagedRuntimeMutationCancelledError
                || condaError instanceof WindowsRuntimeElevationRequiredError
                || condaError instanceof LinuxRuntimeElevationRequiredError
            ) {
                throw condaError;
            }
            this.appendRecentOutput(`Conda-forge resolver fallback skipped: ${condaError instanceof Error ? condaError.message : String(condaError)}`);
            this.traceDownload("resolver-fallback-conda-skipped", {
                error: condaError instanceof Error ? condaError.message : String(condaError),
            });
        }

        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            "Falling back to pip after wheelhouse resolver failure.",
            runtimeStepStart("installPackage"),
            false,
            undefined,
            undefined,
        );
        await this.preparePackageInstaller(runtimeRoot);
        await this.runPipInstallWithFallback(spec, runtimeRoot, upgrade, indexUrl);

        await this.emitBootstrapStage(
            "Label Studio Installed",
            "Label Studio package files are installed in the embedded runtime.",
            runtimeStepEnd("installPackage"),
            false,
            undefined,
            undefined,
        );
    }

    private async ensureManagedPip(runtimeRoot: string): Promise<void> {
        const cwd = this.runtimePythonDir(runtimeRoot);
        const env = AppPaths.makePythonEnvironmentForRuntime(runtimeRoot);
        let pipVersion = await this.currentPipVersion(runtimeRoot).catch(() => undefined);

        if (!pipVersion) {
            await this.runRuntimePythonProcess(
                ["-m", "ensurepip", "--upgrade"],
                cwd,
                env,
                false,
                runtimeStepStart("installPackage"),
                runtimeStepStart("installPackage"),
                PackageInstallStageTitle,
            );
            pipVersion = await this.currentPipVersion(runtimeRoot).catch(() => undefined);
        }

        if (!pipVersion) {
            throw new Error("The managed runtime could not bootstrap pip.");
        }
    }

    private async prepareForManagedRuntimeMutation(kind: ManagedRuntimeMutationKind): Promise<void> {
        if (this.managedRuntimeMutationPrepared) return;
        await this.beforeManagedRuntimeMutation?.(kind);
        this.managedRuntimeMutationPrepared = true;
    }

    private async preparePackageInstaller(runtimeRoot: string): Promise<void> {
        if (this.packageInstallerPrepared) return;
        if (await this.isActiveManagedRuntimeRoot(runtimeRoot)) {
            await this.prepareForManagedRuntimeMutation("package");
        }
        this.assertDirectoryWritable(runtimeRoot, "install Python packages");

        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            "Preparing pip inside the managed Python runtime.",
            runtimeStepStart("installPackage"),
            false,
            undefined,
            undefined,
        );
        await this.ensureManagedPip(runtimeRoot);
        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            "The embedded Python package installer is ready.",
            runtimeStepStart("installPackage"),
            false,
            undefined,
            undefined,
        );
        this.packageInstallerPrepared = true;
    }

    private async isActiveManagedRuntimeRoot(runtimeRoot: string): Promise<boolean> {
        return await this.filesystemPathIdentity(runtimeRoot)
            === await this.filesystemPathIdentity(AppPaths.bundledRuntimeRoot());
    }

    private async currentPipVersion(runtimeRoot: string): Promise<string> {
        const output = await this.runRuntimePythonProcess(
            ["-m", "pip", "--version"],
            this.runtimePythonDir(runtimeRoot),
            AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
            true,
        );
        const match = output.match(/^pip\s+([^\s]+)/i);
        if (!match?.[1]) throw new Error(`Unable to read pip version from: ${output.trim()}`);
        return match[1];
    }

    private async latestPackageDownload(): Promise<PackageDownloadInfo> {
        return await this.packageDownload(undefined);
    }

    private async packageDownload(version?: string): Promise<PackageDownloadInfo> {
        // Swift parity: always read the project-level PyPI JSON, choose the requested
        // release from `releases`, and only select a non-yanked wheel. Do not filter
        // the release files by the currently running Node/Electron version. The
        // Swift implementation first selects the package, then installs a Python
        // runtime that satisfies that package's `requires_python` metadata.
        const project = await this.fetchPyPIProject();
        const resolvedVersion = version ?? project.info?.version ?? "Unknown";
        const releaseFiles = project.releases?.[resolvedVersion]
            ?? (resolvedVersion === project.info?.version ? project.urls ?? [] : []);

        const candidates = releaseFiles.filter((file) =>
            (file.yanked ?? false) === false
            && Boolean(file.url)
            && Boolean(file.filename)
            && (file.packagetype === "bdist_wheel" || file.filename?.endsWith(".whl"))
            && file.filename?.endsWith(".whl"),
        );

        const chosen = candidates.find((file) => file.python_version === "py3") ?? candidates[0];
        if (!chosen) {
            throw new Error(`Unable to find a PyPI wheel for label-studio ${resolvedVersion}.`);
        }

        const requiresPython = chosen.requires_python
            ?? (resolvedVersion === project.info?.version ? project.info?.requires_python : undefined)
            ?? "";

        return {
            version: resolvedVersion,
            requiresPython,
            url: chosen.url ?? "",
            filename: chosen.filename ?? "label-studio-package.whl",
            size: chosen.size,
        };
    }

    private async installPackageWithPip(
        version: string,
        runtimeRoot: string,
        upgrade: boolean,
    ): Promise<void> {
        const spec = version && version !== "Unknown" ? `label-studio==${version}` : "label-studio";
        try {
            await this.runPipInstallWithFallback(spec, runtimeRoot, upgrade);
        } catch (primaryError) {
            if (this.preferTunaPyPI || !this.isExplicitNetworkFailure(primaryError)) {
                throw primaryError instanceof Error ? primaryError : new Error(String(primaryError));
            }

            this.preferTunaPyPIForCurrentRun();
            await this.emitBootstrapStage(
                PackageInstallStageTitle,
                "Retrying pip install with the TUNA PyPI mirror.",
                runtimeStepStart("installPackage"),
                true,
                0,
                "Switching package index",
                0,
            );
            await this.runPipInstallWithFallback(spec, runtimeRoot, upgrade, TunaPyPISimpleUrl);
        }

        await this.emitBootstrapStage(
            "Label Studio Installed",
            "Label Studio package files are installed in the embedded runtime.",
            runtimeStepEnd("installPackage"),
            false,
            undefined,
            undefined,
        );
    }

    private async runPipInstallWithFallback(
        spec: string,
        runtimeRoot: string,
        upgrade: boolean,
        indexUrl?: string,
    ): Promise<void> {
        try {
            await this.runPipInstall(spec, runtimeRoot, upgrade, indexUrl);
            return;
        } catch (error) {
            if (!this.isPipBuildFailure(error)) throw error;

            const fallbackArtifacts = this.condaFallbackArtifactsFromDirectPipFailure(error);
            if (fallbackArtifacts.length === 0) throw error;

            const installedFromConda = await this.installCondaForgeFallbackPackages(fallbackArtifacts, runtimeRoot);
            if (installedFromConda.size === 0) throw error;

            await this.emitBootstrapStage(
                PackageInstallStageTitle,
                "Retrying pip install after installing binary package files.",
                runtimeStepStart("installPackage"),
                false,
                undefined,
                undefined,
                this.pipInstallMainFraction,
            );
            await this.runPipInstall(spec, runtimeRoot, upgrade, indexUrl, this.pipInstallMainFraction);
        }
    }

    private async runPipInstall(
        spec: string,
        runtimeRoot: string,
        upgrade: boolean,
        indexUrl?: string,
        initialMainFraction = 0,
    ): Promise<void> {
        this.resetPipInstallProgressState(initialMainFraction);
        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            `Installing ${spec} with pip.`,
            runtimeStepStart("installPackage"),
            false,
            undefined,
            undefined,
        );

        const args = [
            "-m", "pip", "install", "--upgrade",
            "--disable-pip-version-check", "--no-input", "--retries", "0",
            "--progress-bar", "on", "--prefer-binary",
        ];
        if (!upgrade) { /* Keep one pip command shape for first install and update. */ }
        if (indexUrl) args.push("--index-url", indexUrl);
        args.push(spec);

        await this.runRuntimePythonProcess(
            args,
            this.runtimePythonDir(runtimeRoot),
            await this.pipInstallEnvironment(runtimeRoot),
            false,
            runtimeStepStart("installPackage"),
            runtimeStepEnd("installPackage"),
            PackageInstallStageTitle,
            {
                outputShowsDownloadProgress: process.platform !== "win32",
            },
        );
    }

    private async pipInstallEnvironment(runtimeRoot: string): Promise<NodeJS.ProcessEnv> {
        return {
            ...AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
            PIP_CACHE_DIR: AppPaths.pipCacheDirectory(),
            PIP_DISABLE_PIP_VERSION_CHECK: "1",
            PIP_NO_INPUT: "1",
            PIP_PROGRESS_BAR: "on",
            FORCE_COLOR: "1",
            TERM: "xterm-256color",
            COLUMNS: "120",
        };
    }

    private isPipBuildFailure(error: unknown): boolean {
        const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
        return /\b(Failed building wheel|Could not build wheels|subprocess-exited-with-error|metadata-generation-failed|Getting requirements to build wheel|Preparing metadata .* did not run successfully|error: command .* failed|CMake Error|ninja: build stopped|Microsoft Visual C\+\+|Rust compiler|cargo metadata)\b/i.test(text);
    }

    private condaFallbackArtifactsFromDirectPipFailure(error: unknown): PackageFallbackArtifact[] {
        const failedNames = this.failedPackageNamesFromPipError(error);
        if (failedNames.size === 0) return [];

        const text = error instanceof Error ? error.message : String(error);
        const versions = this.packageVersionsFromPipOutput(text);
        return [...failedNames].map((name) => ({
            name,
            version: versions.get(name) ?? "",
            url: "",
            filename: "",
            requested: false,
        }));
    }

    private packageVersionsFromPipOutput(text: string): Map<string, string> {
        const versions = new Map<string, string>();
        const filenamePatterns = [
            /\bDownloading\s+([A-Za-z0-9_.!+~-]+-[^\s()]+?\.(?:whl|tar\.gz|zip|tar\.bz2))/gi,
            /\bUsing cached\s+([A-Za-z0-9_.!+~-]+-[^\s()]+?\.(?:whl|tar\.gz|zip|tar\.bz2))/gi,
            /\bSaved\s+.+\/([A-Za-z0-9_.!+~-]+-[^\s()]+?\.(?:whl|tar\.gz|zip|tar\.bz2))/gi,
        ];
        for (const pattern of filenamePatterns) {
            for (const match of text.matchAll(pattern)) {
                const filename = match[1] ?? "";
                const parsed = this.packageNameAndVersionFromDistributionFilename(filename);
                if (parsed) versions.set(parsed.name, parsed.version);
            }
        }

        for (const match of text.matchAll(/\bCollecting\s+([A-Za-z0-9_.-]+)==([A-Za-z0-9_.!+~-]+)/gi)) {
            const name = this.normalizePackageName(match[1] ?? "");
            const version = match[2] ?? "";
            if (name && version) versions.set(name, version);
        }
        return versions;
    }

    private packageNameAndVersionFromDistributionFilename(filename: string): { name: string; version: string } | undefined {
        const stem = filename
            .replace(/\.tar\.gz$/i, "")
            .replace(/\.tar\.bz2$/i, "")
            .replace(/\.whl$/i, "")
            .replace(/\.zip$/i, "");
        const parts = stem.split("-");
        for (let index = 1; index < parts.length; index += 1) {
            const version = parts[index] ?? "";
            if (!/^\d+(?:[A-Za-z0-9_.!+~-]*)?$/.test(version)) continue;
            const name = this.normalizePackageName(parts.slice(0, index).join("-"));
            if (name) return { name, version };
        }
        return undefined;
    }

    private failedPackageNamesFromPipError(error: unknown): Set<string> {
        const text = error instanceof Error ? error.message : String(error);
        const names = new Set<string>();
        const patterns = [
            /Failed building wheel for\s+([A-Za-z0-9_.-]+)/gi,
            /Building wheel for\s+([A-Za-z0-9_.-]+)\s+\(/gi,
            /Could not build wheels for\s+([A-Za-z0-9_.\s,-]+)/gi,
            /Could not find a version that satisfies the requirement\s+([A-Za-z0-9_.-]+)/gi,
            /No matching distribution found for\s+([A-Za-z0-9_.-]+)/gi,
            /Preparing metadata .* for\s+([A-Za-z0-9_.-]+)/gi,
            /Getting requirements to build wheel .* for\s+([A-Za-z0-9_.-]+)/gi,
            /metadata-generation-failed.*?([A-Za-z0-9_.-]+)\b/gi,
        ];

        for (const pattern of patterns) {
            for (const match of text.matchAll(pattern)) {
                const raw = match[1] ?? "";
                for (const name of raw.split(/[,\s]+/).map((value) => value.trim()).filter(Boolean)) {
                    if (/^(and|which|is|required|to|install)$/i.test(name)) continue;
                    names.add(this.normalizePackageName(name));
                }
            }
        }

        return names;
    }

    private async installCondaForgeFallbackPackages(
        artifacts: PackageFallbackArtifact[],
        runtimeRoot: string
    ): Promise<Set<string>> {
        this.traceDownload("conda-fallback-plan-start", { artifacts });
        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            "Resolving binary package fallback.",
            runtimeStepStart("downloadPackage"),
            true,
            0,
            "Preparing binary package downloads",
            0,
        );

        const pythonVersion = await this.currentPythonVersion(runtimeRoot);
        const plan = await this.resolveCondaForgePackagePlan(artifacts, pythonVersion);
        this.traceDownload("conda-fallback-plan-ready", {
            count: plan.length,
            packages: plan.map((candidate) => `${candidate.name}-${candidate.version}`),
        });
        const condaCacheDirectory = AppPaths.packageCondaForgeCacheDirectory();
        const installedArtifacts = new Set<string>();
        const downloadedPlan: Array<{ candidate: CondaPackageCandidate; archivePath: string; index: number }> = [];

        for (let index = 0; index < plan.length; index += 1) {
            const candidate = plan[index];
            const archivePath = await this.downloadCondaForgePackage(candidate, condaCacheDirectory, index, plan.length);
            downloadedPlan.push({ candidate, archivePath, index });
        }

        if (downloadedPlan.length > 0) await this.preparePackageInstaller(runtimeRoot);
        for (const item of downloadedPlan) {
            const { candidate, archivePath, index } = item;
            await this.uninstallConflictingInstalledDistributions([{
                name: candidate.name,
                version: candidate.version,
                url: candidate.url,
                filename: candidate.filename,
                requested: false,
                size: candidate.size,
            }], runtimeRoot);
            await this.installCondaForgePackageArchive(candidate, archivePath, runtimeRoot, pythonVersion, index, plan.length);

            if (artifacts.some((artifact) =>
                this.normalizePackageName(artifact.name) === this.normalizePackageName(candidate.name)
                && (!artifact.version || artifact.version === candidate.version)
            )) {
                installedArtifacts.add(this.packageKey(candidate.name, candidate.version));
            }
        }

        return installedArtifacts;
    }

    private async resolveCondaForgePackagePlan(
        artifacts: PackageFallbackArtifact[],
        pythonVersion: string,
    ): Promise<CondaPackageCandidate[]> {
        const platformSubdir = this.condaForgePlatformSubdir();
        const subdirs = platformSubdir === "noarch" ? ["noarch"] : [platformSubdir, "noarch"];
        const selected = new Map<string, CondaPackageCandidate>();
        const visiting = new Set<string>();
        const ordered: CondaPackageCandidate[] = [];

        for (const artifact of artifacts) {
            await this.resolveCondaForgePackageRecursive(
                {
                    name: this.normalizePackageName(artifact.name),
                    constraints: artifact.version ? `==${artifact.version}` : "",
                },
                subdirs,
                pythonVersion,
                selected,
                visiting,
                ordered,
            );
        }

        return ordered;
    }

    private async resolveCondaForgePackageRecursive(
        spec: CondaDependencySpec,
        subdirs: string[],
        pythonVersion: string,
        selected: Map<string, CondaPackageCandidate>,
        visiting: Set<string>,
        ordered: CondaPackageCandidate[],
    ): Promise<void> {
        const normalizedName = this.normalizePackageName(spec.name);
        if (this.shouldSkipCondaDependency(normalizedName)) return;

        const existing = selected.get(normalizedName);
        if (existing) {
            if (!this.condaVersionSatisfiesConstraints(existing.version, spec.constraints)) {
                throw new Error(`Conflicting conda-forge constraints for ${normalizedName}: selected ${existing.version}, required ${spec.constraints}.`);
            }
            return;
        }

        if (visiting.has(normalizedName)) return;
        visiting.add(normalizedName);

        const candidate = await this.findCondaForgePackageCandidate(normalizedName, spec.constraints, subdirs, pythonVersion);
        for (const dependency of candidate.depends) {
            const dependencySpec = this.parseCondaDependency(dependency);
            if (!dependencySpec || this.shouldSkipCondaDependency(dependencySpec.name)) continue;
            await this.resolveCondaForgePackageRecursive(dependencySpec, subdirs, pythonVersion, selected, visiting, ordered);
        }

        visiting.delete(normalizedName);
        selected.set(normalizedName, candidate);
        ordered.push(candidate);
    }

    private shouldSkipCondaDependency(name: string): boolean {
        const normalized = this.normalizePackageName(name);
        return normalized.startsWith("__")
            || normalized === "python"
            || normalized === "python-abi"
            || normalized === "pip"
            || normalized === "setuptools"
            || normalized === "wheel";
    }

    private async findCondaForgePackageCandidate(
        name: string,
        constraints: string,
        subdirs: string[],
        pythonVersion: string,
    ): Promise<CondaPackageCandidate> {
        const normalizedName = this.normalizePackageName(name);
        for (const subdir of subdirs) {
            const repodata = await this.condaForgeRepodata(subdir);
            const indexedRecords = await repodata.packageRecords(normalizedName);
            const candidates: CondaPackageCandidate[] = [];
            for (let index = 0; index < indexedRecords.length; index += 1) {
                const record = indexedRecords[index];
                if (!record) continue;
                const candidate = this.condaPackageCandidateFromRecord(record.filename, subdir, record);
                if (
                    candidate
                    && this.condaVersionSatisfiesConstraints(candidate.version, constraints)
                    && this.condaPackageMatchesPython(candidate, pythonVersion)
                ) {
                    candidates.push(candidate);
                }
                if ((index + 1) % 500 === 0) await this.yieldToEventLoop();
            }
            candidates.sort((left, right) => {
                const versionCompare = this.compareVersionNumbers(right.version, left.version);
                if (versionCompare !== 0) return versionCompare;
                return right.buildNumber - left.buildNumber;
            });

            const chosen = candidates[0];
            if (chosen) return chosen;
        }

        throw new Error(`Unable to find conda-forge package ${name}${constraints ? ` ${constraints}` : ""} for ${process.platform}-${process.arch}.`);
    }

    private condaPackageCandidateFromRecord(
        filename: string,
        subdir: string,
        record: CondaPackageRecord,
    ): CondaPackageCandidate | undefined {
        if (!record.name || !record.version) return undefined;
        return {
            name: record.name,
            version: record.version,
            filename,
            subdir,
            url: new URL(`${subdir}/${filename}`, CondaForgeBaseUrl).toString(),
            fallbackUrls: [new URL(`${subdir}/${filename}`, TunaCondaForgeBaseUrl).toString()],
            size: record.size,
            depends: record.depends ?? [],
            buildNumber: record.build_number ?? 0,
        };
    }

    private parseCondaDependency(dependency: string): CondaDependencySpec | undefined {
        const trimmed = dependency.trim();
        if (!trimmed) return undefined;
        const match = trimmed.match(/^([A-Za-z0-9_.-]+)(?:\s+(.+))?$/);
        if (!match?.[1]) return undefined;
        return {
            name: this.normalizePackageName(match[1]),
            constraints: (match[2] ?? "").trim(),
        };
    }

    private condaPackageMatchesPython(candidate: CondaPackageCandidate, pythonVersion: string): boolean {
        for (const dependency of candidate.depends) {
            const spec = this.parseCondaDependency(dependency);
            if (!spec) continue;

            if (spec.name === "python" && !this.condaVersionSatisfiesConstraints(pythonVersion, spec.constraints)) {
                return false;
            }

            if (spec.name === "python-abi") {
                const requiredSeries = spec.constraints.match(/(\d+\.\d+)\.\*/)?.[1];
                if (requiredSeries && this.pythonSeries(pythonVersion) !== requiredSeries) return false;
            }
        }
        return true;
    }

    private condaVersionSatisfiesConstraints(version: string, constraints: string): boolean {
        const trimmed = constraints.trim();
        if (!trimmed || trimmed === "*") return true;

        const clauses = trimmed
            .split(",")
            .map((clause) => clause.trim())
            .filter(Boolean)
            .map((clause) => clause.split(/\s+/)[0])
            .filter((clause) => clause && !clause.includes("_"));

        for (const clause of clauses) {
            const match = clause.match(/^(>=|<=|==|!=|>|<)?(.+)$/);
            if (!match?.[2]) continue;
            const op = match[1] ?? "==";
            const target = match[2].trim();
            if (!this.condaVersionSatisfiesClause(version, op, target)) return false;
        }

        return true;
    }

    private condaVersionSatisfiesClause(version: string, op: string, target: string): boolean {
        if (target === "*") return op !== "!=";

        if (target.endsWith(".*")) {
            const prefix = target.slice(0, -2);
            const matches = version === prefix || version.startsWith(`${prefix}.`);
            return op === "!=" ? !matches : matches;
        }

        const comparison = this.compareVersionNumbers(version, target);
        if (op === ">=") return comparison >= 0;
        if (op === "<=") return comparison <= 0;
        if (op === ">") return comparison > 0;
        if (op === "<") return comparison < 0;
        if (op === "!=") return comparison !== 0;
        return comparison === 0;
    }

    private async condaForgeRepodata(subdir: string): Promise<CondaRepodataCatalog> {
        let promise = this.condaRepodataPromises.get(subdir);
        if (!promise) {
            promise = this.fetchCondaRepodataWithFallback([
                new URL(`${subdir}/repodata.json`, CondaForgeBaseUrl).toString(),
                new URL(`${subdir}/repodata.json`, TunaCondaForgeBaseUrl).toString(),
            ]);
            this.condaRepodataPromises.set(subdir, promise);
        }
        return await promise;
    }

    private condaForgePlatformSubdir(): string {
        if (process.platform === "darwin") {
            if (process.arch === "arm64") return "osx-arm64";
            if (process.arch === "x64") return "osx-64";
        }

        if (process.platform === "win32") {
            if (process.arch === "x64") return "win-64";
            if (process.arch === "arm64") return "win-arm64";
        }

        if (process.platform === "linux") {
            if (process.arch === "x64") return "linux-64";
            if (process.arch === "arm64") return "linux-aarch64";
            if (process.arch === "ppc64") return "linux-ppc64le";
            if (process.arch === "s390x") return "linux-s390x";
        }

        throw new Error(`Unsupported conda-forge platform: ${process.platform}-${process.arch}.`);
    }

    private async downloadCondaForgePackage(
        candidate: CondaPackageCandidate,
        cacheDirectory: string,
        index: number,
        total: number,
    ): Promise<string> {
        const packageDirectory = AppPaths.ensureDirectory(path.join(cacheDirectory, candidate.subdir));
        const archivePath = path.join(packageDirectory, candidate.filename);
        const progressStart = runtimeStepProgress("downloadPackage", total > 0 ? index / total : 0);
        const progressEnd = runtimeStepProgress("downloadPackage", total > 0 ? (index + 1) / total : 1);
        const mainProgressEnd = total > 0 ? (index + 1) / total : 1;

        if ((await this.waitForDownloadResume()) === "skipped") {
            throw new Error(`Conda-forge package download was cancelled before ${candidate.name} was available.`);
        }

        if (fs.existsSync(archivePath)) {
            await this.emitBootstrapStage(
                PackageInstallStageTitle,
                `Using cached ${candidate.name} ${candidate.version}.`,
                progressEnd,
                true,
                1,
                candidate.size
                    ? `${this.formatByteCount(candidate.size)} / ${this.formatByteCount(candidate.size)}`
                    : "Using cached package file",
                mainProgressEnd,
            );
            return archivePath;
        }

        const result = await this.downloadFileWithFallback(
            [candidate.url, ...candidate.fallbackUrls],
            archivePath,
            candidate.size,
            PackageInstallStageTitle,
            `Downloading ${candidate.name} ${candidate.version}.`,
            progressStart,
            progressEnd,
            (progress) => total > 0 ? (index + clamp01(progress.fraction)) / total : progress.fraction,
        );
        if (result === "skipped") {
            throw new Error(`Conda-forge package download was cancelled before ${candidate.name} was available.`);
        }
        return archivePath;
    }

    private async installCondaForgePackageArchive(
        candidate: CondaPackageCandidate,
        archivePath: string,
        runtimeRoot: string,
        pythonVersion: string,
        index: number,
        total: number,
    ): Promise<void> {
        const progressStart = runtimeStepProgress("installPackage", total > 0 ? index / total : 0);
        const progressEnd = runtimeStepProgress("installPackage", total > 0 ? (index + 1) / total : 1);

        await this.emitBootstrapStage(
            PackageInstallStageTitle,
            `Installing ${candidate.name} ${candidate.version}.`,
            progressStart,
            false,
            undefined,
            undefined,
        );

        await this.runRuntimePythonProcess(
            ["-c", this.condaPackageInstallScript(), archivePath, runtimeRoot, pythonVersion],
            this.runtimePythonDir(runtimeRoot),
            AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
            false,
            progressStart,
            progressEnd,
            PackageInstallStageTitle,
        );
    }

    private condaPackageInstallScript(): string {
        return String.raw`
import os
import re
import shutil
import stat
import sys
import tarfile

archive_path, prefix, python_version = sys.argv[1:4]
prefix = os.path.abspath(prefix)
python_series = ".".join(python_version.split(".")[:2])

site_candidates = [
    os.path.join(prefix, "Lib", "site-packages"),
    os.path.join(prefix, "lib", f"python{python_series}", "site-packages"),
    os.path.join(prefix, "Library", "Frameworks", "Python.framework", "Versions", "Current", "lib", f"python{python_series}", "site-packages"),
]
site_packages = next((candidate for candidate in site_candidates if os.path.isdir(candidate)), site_candidates[0] if os.name == "nt" else site_candidates[-1])
scripts_dir = os.path.join(prefix, "Scripts" if os.name == "nt" else "bin")
os.makedirs(site_packages, exist_ok=True)
os.makedirs(scripts_dir, exist_ok=True)

def safe_join(root, relative):
    destination = os.path.abspath(os.path.join(root, relative))
    root = os.path.abspath(root)
    if destination != root and not destination.startswith(root + os.sep):
        raise RuntimeError(f"Unsafe conda package path: {relative}")
    return destination

def destination_for(member_name):
    normalized = member_name.replace("\\", "/").lstrip("/")
    if not normalized or normalized.startswith("info/"):
        return None
    if ".." in normalized.split("/"):
        raise RuntimeError(f"Unsafe conda package path: {member_name}")

    match = re.match(r"^(?:Lib|lib/python[^/]+|Library/Frameworks/Python\.framework/Versions/[^/]+/lib/python[^/]+)/site-packages/(.+)$", normalized)
    if match:
        return safe_join(site_packages, match.group(1))
    if normalized.startswith("site-packages/"):
        return safe_join(site_packages, normalized[len("site-packages/"):])
    if normalized.startswith("python-scripts/"):
        return safe_join(scripts_dir, os.path.basename(normalized))
    return safe_join(prefix, normalized)

with tarfile.open(archive_path, "r:*") as archive:
    for member in archive.getmembers():
        destination = destination_for(member.name)
        if destination is None:
            continue

        if member.isdir():
            os.makedirs(destination, exist_ok=True)
            continue

        os.makedirs(os.path.dirname(destination), exist_ok=True)
        if os.path.lexists(destination):
            if os.path.isdir(destination) and not os.path.islink(destination):
                shutil.rmtree(destination)
            else:
                os.unlink(destination)

        if member.issym():
            link_name = member.linkname
            if os.path.isabs(link_name) or ".." in link_name.replace("\\", "/").split("/"):
                continue
            try:
                os.symlink(link_name, destination)
            except OSError:
                pass
            continue

        source = archive.extractfile(member)
        if source is None:
            continue
        with source, open(destination, "wb") as target:
            shutil.copyfileobj(source, target)
        mode = member.mode
        if destination.startswith(scripts_dir + os.sep):
            mode |= stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
        try:
            os.chmod(destination, mode)
        except OSError:
            pass
`;
    }

    private packageKey(name: string, version: string): string {
        return `${this.normalizePackageName(name)}@${version}`;
    }

    private async packageTargetPythonVersion(requiresPython: string): Promise<string> {
        const minimumSeries = this.minimumPythonSeries(requiresPython);
        if (minimumSeries) {
            const version = await this.latestRuntimeVersionForSeries(minimumSeries);
            if (version) return version;
        }
        return await this.latestPythonVersion();
    }

    private async latestPythonVersion(): Promise<string> {
        const versions = await this.availablePythonVersions();
        for (const version of versions) {
            try {
                await this.pythonRuntimeArchive(version);
                return version;
            } catch { /* try next */ }
        }
        throw new Error(`Unable to determine the latest stable Python runtime for ${process.platform}-${process.arch}.`);
    }

    private async latestRuntimeVersionForSeries(series: string): Promise<string | undefined> {
        const versions = (await this.availablePythonVersions()).filter((version) => version === series || version.startsWith(`${series}.`));
        for (const version of versions) {
            try {
                await this.pythonRuntimeArchive(version);
                return version;
            } catch { /* try next */ }
        }
        return undefined;
    }

    private async availablePythonVersions(): Promise<string[]> {
        if (process.platform !== "darwin") {
            const repodata = await this.anacondaMainRepodata(this.anacondaRuntimePlatformSubdir());
            const versions = (await repodata.packageRecords("python")).map((record) => record.version).filter(Boolean);
            return [...new Set(versions)].sort((a, b) => this.compareVersionNumbers(b, a));
        }

        const html = await this.fetchText("https://www.python.org/ftp/python/");
        const matches = [...html.matchAll(/href="(\d+\.\d+\.\d+)\/"/g)].map((match) => match[1]);
        const unique = [...new Set(matches)];
        return unique.sort((a, b) => this.compareVersionNumbers(b, a));
    }

    private async pythonPackageName(version: string): Promise<string> {
        const html = await this.fetchText(`https://www.python.org/ftp/python/${version}/`);
        const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`href="(python-${escaped}-macos\\d+\\.pkg)"`);
        const match = html.match(pattern);
        if (!match?.[1]) throw new Error(`Unable to find a macOS installer package for Python ${version}.`);
        return match[1];
    }

    private async pythonRuntimeArchive(version: string): Promise<RuntimeArchiveInfo> {
        if (process.platform === "darwin") {
            const filename = await this.pythonPackageName(version);
            return {
                filename,
                url: `https://www.python.org/ftp/python/${version}/${filename}`,
            };
        }

        const candidate = await this.findAnacondaRuntimePackageCandidate(
            "python",
            `==${version}`,
            [this.anacondaRuntimePlatformSubdir()],
            version,
        );
        return {
            filename: candidate.filename,
            url: candidate.url,
            size: candidate.size,
            fallbackUrls: candidate.fallbackUrls,
        };
    }

    private anacondaRuntimePlatformSubdir(): string {
        if (process.platform === "win32") {
            if (process.arch === "x64") return "win-64";
            if (process.arch === "arm64") return "win-arm64";
        }

        if (process.platform === "linux") {
            if (process.arch === "x64") return "linux-64";
            if (process.arch === "arm64") return "linux-aarch64";
            if (process.arch === "ppc64") return "linux-ppc64le";
            if (process.arch === "s390x") return "linux-s390x";
        }

        throw new Error(`Unsupported Python runtime package platform: ${process.platform}-${process.arch}.`);
    }

    private async anacondaMainRepodata(subdir: string): Promise<CondaRepodataCatalog> {
        let promise = this.anacondaMainRepodataPromises.get(subdir);
        if (!promise) {
            promise = this.fetchCondaRepodataWithFallback([
                new URL(`${subdir}/repodata.json`, AnacondaPkgsMainBaseUrl).toString(),
                new URL(`${subdir}/repodata.json`, TunaAnacondaPkgsMainBaseUrl).toString(),
            ]);
            this.anacondaMainRepodataPromises.set(subdir, promise);
        }
        return await promise;
    }

    private async fetchText(url: string): Promise<string> {
        return await this.fetchBody(url, async (response) => await response.text());
    }

    private async fetchPyPIProject(): Promise<PyPIProject> {
        return await this.fetchPyPIProjectByName(
            "label-studio",
            this.preferTunaPyPI ? TunaPyPISimpleUrl : PrimaryPyPISimpleUrl,
        );
    }

    private async fetchTextWithFallback(urls: string[]): Promise<string> {
        let lastError: unknown;
        for (const [index, url] of urls.entries()) {
            try {
                return await this.fetchText(url);
            } catch (error) {
                lastError = error;
                if (!this.isExplicitNetworkFailure(error) || index === urls.length - 1) break;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async fetchJsonWithFallback<T>(urls: string[]): Promise<T> {
        let lastError: unknown;
        for (const [index, url] of urls.entries()) {
            try {
                return await this.fetchJson<T>(url);
            } catch (error) {
                lastError = error;
                if (!this.isExplicitNetworkFailure(error) || index === urls.length - 1) break;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async fetchCondaRepodataWithFallback(urls: string[]): Promise<CondaRepodataCatalog> {
        let lastError: unknown;
        for (const [index, url] of urls.entries()) {
            try {
                return await this.fetchCondaRepodata(url);
            } catch (error) {
                lastError = error;
                if (!this.isExplicitNetworkFailure(error) || index === urls.length - 1) break;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async fetchCondaRepodata(url: string): Promise<CondaRepodataCatalog> {
        return await this.fetchBody(url, async response => {
            const body = await response.arrayBuffer();
            return await loadCondaRepodataInBackground(body, this.activeRuntimeOperationAbortController?.signal);
        });
    }

    private pythonVersionSatisfies(version: string, requirement: string): boolean {
        const req = (requirement || "").trim();
        if (!req) return true;
        const current = this.versionTuple(version);
        for (const clause of req.split(",").map((v) => v.trim()).filter(Boolean)) {
            const match = clause.match(/(>=|<=|==|!=|>|<)\s*([^,;\s]+)/);
            if (!match) continue;
            const [, op, raw] = match;
            const target = this.versionTuple(raw);
            const cmp = this.compareTuples(current, target);
            if (op === ">=" && cmp < 0) return false;
            if (op === "<=" && cmp > 0) return false;
            if (op === "==" && cmp !== 0) return false;
            if (op === "!=" && cmp === 0) return false;
            if (op === ">" && cmp <= 0) return false;
            if (op === "<" && cmp >= 0) return false;
        }
        return true;
    }

    private minimumPythonSeries(requiresPython: string): string | undefined {
        return requiresPython.match(/>=\s*(\d+\.\d+)/)?.[1];
    }

    private versionTuple(text: string): number[] {
        const nums = (text || "").match(/\d+/g)?.map(Number) ?? [];
        while (nums.length < 3) nums.push(0);
        return nums.slice(0, 3);
    }

    private compareVersionNumbers(left: string, right: string): number {
        return this.compareTuples(this.versionTuple(left), this.versionTuple(right));
    }

    private compareTuples(left: number[], right: number[]): number {
        for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
            const diff = (left[i] ?? 0) - (right[i] ?? 0);
            if (diff !== 0) return diff;
        }
        return 0;
    }

    private async currentPythonVersion(runtimeRoot: string): Promise<string> {
        const output = await this.runRuntimePythonProcess(
            ["-c", "import platform; print(platform.python_version())"],
            this.runtimePythonDir(runtimeRoot),
            AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
            true,
        );
        return output.trim();
    }

    private pythonSeries(version: string): string {
        const pieces = version.split(".");
        return pieces.length >= 2 ? `${pieces[0]}.${pieces[1]}` : version;
    }

    private runtimePython(runtimeRoot: string): string {
        return AppPaths.runtimePythonForRoot(runtimeRoot);
    }

    private runtimePythonDir(runtimeRoot: string): string {
        return path.dirname(this.runtimePython(runtimeRoot));
    }

    private async hasInstalledPackage(runtimeRoot: string): Promise<boolean> {
        return await this.packageInstalled(runtimeRoot);
    }

    private async updateElectronDependency(): Promise<void> {
        const meta = await this.fetchJson<NpmElectronPackage>("https://registry.npmjs.org/electron/latest");
        const version = meta.version ?? "latest";
        if (app.isPackaged) {
            if (process.platform === "darwin") {
                await this.updatePackagedMacElectron(version);
            } else if (process.platform === "win32" || process.platform === "linux") {
                await this.updatePackagedPortableElectron(version);
            } else {
                throw new Error(`Packaged Electron self-update is not supported on ${process.platform}-${process.arch}.`);
            }
            return;
        }

        const url = meta.dist?.tarball;
        if (!url) throw new Error("Unable to find the latest Electron package tarball.");
        const archivePath = path.join(AppPaths.electronDownloadCacheDirectory(), `electron-${version}.tgz`);

        await this.emitBootstrapStage(
            "Downloading Electron",
            `Downloading Electron ${version} package.`,
            fs.existsSync(archivePath) ? electronStepEnd("downloadElectron") : electronStepStart("downloadElectron"),
            true,
            fs.existsSync(archivePath) ? 1 : 0,
            fs.existsSync(archivePath) ? "Download complete" : "Preparing download",
        );
        if (!fs.existsSync(archivePath)) {
            const result = await this.downloadFile(
                url,
                archivePath,
                undefined,
                "Downloading Electron",
                `Downloading Electron ${version} package.`,
                electronStepStart("downloadElectron"),
                electronStepEnd("downloadElectron"),
            );
            if (result === "skipped") throw new Error("Electron package download was cancelled before the package was available.");
        }

        await this.emitBootstrapStage(
            "Installing Electron",
            "Installing the downloaded Electron package into this project.",
            electronStepStart("installElectron"),
            false,
            undefined,
            undefined,
        );
        await this.runLocalProcess(process.platform === "win32" ? "npm.cmd" : "npm", ["install", archivePath, "--save-exact"], AppPaths.projectRoot());
        await this.emitBootstrapStage("Electron Updated", "Electron dependency update completed.", electronStepEnd("installElectron"), false, undefined, undefined);
    }

    private async updatePackagedMacElectron(version: string): Promise<void> {
        const normalizedVersion = version.replace(/^v/i, "");
        const archivePath = path.join(AppPaths.electronDownloadCacheDirectory(), `electron-v${normalizedVersion}-darwin.zip`);
        const urls = this.macElectronDownloadURLs(normalizedVersion);

        await this.emitBootstrapStage(
            "Downloading Electron",
            `Downloading Electron ${normalizedVersion} runtime.`,
            fs.existsSync(archivePath) ? electronStepEnd("downloadElectron") : electronStepStart("downloadElectron"),
            true,
            fs.existsSync(archivePath) ? 1 : 0,
            fs.existsSync(archivePath) ? "Download complete" : "Preparing download",
        );

        if (!fs.existsSync(archivePath)) {
            const result = await this.downloadFileWithFallback(
                urls,
                archivePath,
                undefined,
                "Downloading Electron",
                `Downloading Electron ${normalizedVersion} runtime.`,
                electronStepStart("downloadElectron"),
                electronStepEnd("downloadElectron"),
            );
            if (result === "skipped") throw new Error("Electron runtime download was cancelled before the runtime was available.");
        }

        const stagingRoot = path.join(AppPaths.electronDownloadCacheDirectory(), `electron-${normalizedVersion}.expanded-${randomUUID()}`);
        await this.removePathIfExists(stagingRoot);
        await fs.promises.mkdir(stagingRoot, { recursive: true });

        try {
            await this.emitBootstrapStage(
                "Expanding Electron",
                "Expanding the downloaded Electron runtime.",
                electronStepStart("expandElectron"),
                false,
                undefined,
                undefined,
            );
            await this.runLocalProcess("/usr/bin/ditto", ["-x", "-k", archivePath, stagingRoot], AppPaths.projectRoot());

            const sourceApp = this.findExtractedElectronApp(stagingRoot);
            const targetApp = AppPaths.projectRoot();
            await this.emitBootstrapStage(
                "Installing Electron",
                "Replacing the Electron runtime inside this app.",
                electronStepStart("installElectron"),
                false,
                undefined,
                undefined,
            );

            this.appendElectronUpdateLog(`Attempting live macOS Electron runtime replacement. source=${sourceApp} target=${targetApp}`);
            await this.replaceMacElectronRuntime(sourceApp, targetApp);
            const codesignOutput = await this.runLocalProcess("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", targetApp], AppPaths.projectRoot(), true);
            if (codesignOutput.trim().length > 0) this.appendElectronUpdateLog(`Live macOS Electron runtime ad-hoc signing output: ${codesignOutput.trim()}`);
            this.appendElectronUpdateLog("Live macOS Electron runtime replacement applied.");
            await this.emitBootstrapStage("Electron Updated", "Electron runtime files were replaced. Restart Label Studio to use the new runtime.", electronStepEnd("installElectron"), false, undefined, undefined);
        } finally {
            await this.tryRemoveTree(stagingRoot, "Electron staging cleanup");
        }
    }

    private macElectronDownloadURLs(version: string): string[] {
        const arch = process.arch === "arm64" ? "arm64" : "x64";
        const targets = [`darwin-${arch}`];
        if (!targets.includes("darwin-universal")) targets.unshift("darwin-universal");
        return targets.flatMap((target) => this.electronDownloadURLs(version, target));
    }

    private async updatePackagedPortableElectron(version: string): Promise<void> {
        if (process.platform === "linux" && process.env.APPIMAGE) {
            throw new Error("Linux AppImage packages are read-only at runtime. Use the Linux directory/tar package for in-place Electron runtime updates.");
        }

        const normalizedVersion = version.replace(/^v/i, "");
        const targets = this.portableElectronDownloadTargets();
        const archivePath = path.join(AppPaths.electronDownloadCacheDirectory(), `electron-v${normalizedVersion}-${targets[0]}.zip`);
        const urls = targets.flatMap((target) => this.electronDownloadURLs(normalizedVersion, target));

        await this.emitBootstrapStage(
            "Downloading Electron",
            `Downloading Electron ${normalizedVersion} runtime.`,
            fs.existsSync(archivePath) ? electronStepEnd("downloadElectron") : electronStepStart("downloadElectron"),
            true,
            fs.existsSync(archivePath) ? 1 : 0,
            fs.existsSync(archivePath) ? "Download complete" : "Preparing download",
        );

        if (!fs.existsSync(archivePath)) {
            const result = await this.downloadFileWithFallback(
                urls,
                archivePath,
                undefined,
                "Downloading Electron",
                `Downloading Electron ${normalizedVersion} runtime.`,
                electronStepStart("downloadElectron"),
                electronStepEnd("downloadElectron"),
            );
            if (result === "skipped") throw new Error("Electron runtime download was cancelled before the runtime was available.");
        }

        const stagingRoot = path.join(AppPaths.electronDownloadCacheDirectory(), `electron-${normalizedVersion}.${process.platform}.expanded-${randomUUID()}`);
        await this.removePathIfExists(stagingRoot);
        await fs.promises.mkdir(stagingRoot, { recursive: true });

        let replacementScheduled = false;
        try {
            await this.emitBootstrapStage(
                "Expanding Electron",
                "Expanding the downloaded Electron runtime.",
                electronStepStart("expandElectron"),
                false,
                undefined,
                undefined,
            );
            await this.extractZipArchive(archivePath, stagingRoot);

            const sourceRoot = this.findExtractedPortableElectronRoot(stagingRoot);
            const targetRoot = AppPaths.projectRoot();
            this.assertPackagedPortableElectronTarget(sourceRoot, targetRoot);

            if (process.platform === "linux") {
                await this.emitBootstrapStage(
                    "Installing Electron",
                    "Replacing the Electron runtime inside this app.",
                    electronStepStart("installElectron"),
                    false,
                    undefined,
                    undefined,
                );

                this.appendElectronUpdateLog(`Attempting live Linux Electron runtime replacement. source=${sourceRoot} target=${targetRoot}`);
                await this.replacePortableElectronRuntime(sourceRoot, targetRoot);
                this.appendElectronUpdateLog("Live Linux Electron runtime replacement applied.");
                await this.emitBootstrapStage("Electron Updated", "Electron runtime files were replaced. Restart Label Studio to use the new runtime.", electronStepEnd("installElectron"), false, undefined, undefined);
            } else {
                await this.emitBootstrapStage(
                    "Installing Electron",
                    "Scheduling the Electron runtime replacement for app quit.",
                    electronStepStart("installElectron"),
                    false,
                    undefined,
                    undefined,
                );
                this.scheduleWindowsElectronReplacement(stagingRoot, sourceRoot, targetRoot, normalizedVersion);
                replacementScheduled = true;

                await this.emitBootstrapStage("Electron Update Ready", "Quit Label Studio to install the downloaded Electron runtime.", electronStepEnd("installElectron"), false, undefined, undefined);
            }
        } finally {
            if (!replacementScheduled) await this.tryRemoveTree(stagingRoot, "Electron staging cleanup");
        }
    }

    private portableElectronDownloadTargets(): string[] {
        if (process.platform === "win32") {
            const arch = process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "ia32" : "x64";
            return [`win32-${arch}`];
        }

        if (process.platform === "linux") {
            if (process.arch === "arm64") return ["linux-arm64"];
            if (process.arch === "arm") return ["linux-armv7l"];
            if (process.arch === "x64") return ["linux-x64"];
        }

        throw new Error(`Unsupported Electron runtime platform: ${process.platform}-${process.arch}.`);
    }

    private electronDownloadURLs(version: string, target: string): string[] {
        const filename = `electron-v${version}-${target}.zip`;
        return [
            new URL(`v${version}/${filename}`, ElectronReleaseBaseUrl).toString(),
            ...ElectronMirrorBaseUrls.map((baseUrl) => new URL(`v${version}/${filename}`, baseUrl).toString()),
        ];
    }

    private findExtractedPortableElectronRoot(root: string): string {
        const executableName = this.portableElectronSourceExecutableName();
        const candidates = [
            root,
            ...this.childDirectoriesMatching(root, /.*/).map((entry) => path.join(root, entry)),
        ];
        const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, executableName)));
        if (!found) throw new Error(`The downloaded Electron archive did not contain ${executableName}.`);
        return found;
    }

    private portableElectronSourceExecutableName(): string {
        return process.platform === "win32" ? "electron.exe" : "electron";
    }

    private assertPackagedPortableElectronTarget(sourceRoot: string, targetRoot: string): void {
        const sourceExecutable = path.join(sourceRoot, this.portableElectronSourceExecutableName());
        const targetExecutable = app.getPath("exe");
        const targetResources = path.join(targetRoot, "resources");
        if (!fs.existsSync(sourceExecutable)) throw new Error(`Missing Electron executable in downloaded runtime: ${sourceExecutable}`);
        if (!fs.existsSync(targetExecutable)) throw new Error(`Missing current app executable: ${targetExecutable}`);
        if (!fs.existsSync(targetResources)) throw new Error(`Missing current app resources directory: ${targetResources}`);
        if (process.platform !== "win32") this.assertWritableDirectory(targetRoot);
    }

    private assertWritableDirectory(directory: string): void {
        const probe = path.join(directory, `.electron-update-write-test-${randomUUID()}`);
        try {
            fs.writeFileSync(probe, "");
            fs.rmSync(probe, { force: true });
        } catch (error) {
            if (app.isPackaged && process.platform === "win32") {
                throw new WindowsRuntimeElevationRequiredError(
                    directory,
                    "update the Electron runtime",
                    error instanceof Error ? error.message : String(error),
                );
            }
            if (app.isPackaged && process.platform === "linux") {
                throw new LinuxRuntimeElevationRequiredError(
                    directory,
                    "update the Electron runtime",
                    error instanceof Error ? error.message : String(error),
                );
            }
            throw new Error(`The app install directory is not writable: ${directory}\n\n${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private isDirectoryWritable(directory: string): boolean {
        const probe = path.join(directory, `.electron-update-write-test-${randomUUID()}`);
        try {
            fs.writeFileSync(probe, "");
            fs.rmSync(probe, { force: true });
            return true;
        } catch {
            try { fs.rmSync(probe, { force: true }); } catch { /* best effort */ }
            return false;
        }
    }

    private scheduleWindowsElectronReplacement(
        stagingRoot: string,
        sourceRoot: string,
        targetRoot: string,
        expectedVersion: string,
    ): void {
        if (process.platform !== "win32") {
            throw new Error("The quit-time Electron installer is only available on Windows.");
        }

        const sourceExecutableName = this.portableElectronSourceExecutableName();
        const sourceExecutable = path.join(sourceRoot, sourceExecutableName);
        if (!fs.existsSync(sourceExecutable)) {
            throw new Error(`Missing Electron executable in downloaded runtime: ${sourceExecutable}`);
        }

        const needsElevation = app.isPackaged && !this.isDirectoryWritable(targetRoot);
        const targetExecutable = app.getPath("exe");
        this.electronRuntimeReplacement = {
            cacheRoot: AppPaths.electronDownloadCacheDirectory(),
            stagingRoot,
            sourceRoot,
            targetRoot,
            sourceExecutableName,
            targetExecutable,
            expectedVersion,
            activePipeName: windowsElectronInstallerPipeName(targetExecutable),
            needsElevation,
        };

        try {
            fs.writeFileSync(AppPaths.electronUpdateApplyLogFile(), "", "utf8");
        } catch {
            // Diagnostics are optional and must never affect the replacement.
        }
        this.electronRuntimeReplacementPending = true;
        this.appendElectronUpdateLog(
            `Prepared native Windows Electron installer. source=${sourceRoot} target=${targetRoot} version=${expectedVersion} elevated=${needsElevation}`,
        );
    }

    private appendElectronUpdateLog(message: string): void {
        try {
            const logFile = AppPaths.electronUpdateApplyLogFile();
            const timestamp = new Date().toISOString();
            fs.appendFileSync(logFile, `${timestamp} ${message}\n`, "utf8");
        } catch {
            // Logging must never make an otherwise valid update fail.
        }
    }

    private shellString(value: string): string {
        return `'${value.replace(/'/g, "'\\''")}'`;
    }

    private async extractZipArchive(archivePath: string, destinationRoot: string): Promise<void> {
        const archive = await originalFs.promises.readFile(archivePath);
        const endOfCentralDirectoryOffset = this.findZipEndOfCentralDirectory(archive);
        const entryCount = archive.readUInt16LE(endOfCentralDirectoryOffset + 10);
        const centralDirectoryOffset = archive.readUInt32LE(endOfCentralDirectoryOffset + 16);
        let offset = centralDirectoryOffset;

        for (let index = 0; index < entryCount; index += 1) {
            if (archive.readUInt32LE(offset) !== 0x02014b50) {
                throw new Error("Invalid ZIP central directory entry.");
            }

            const flags = archive.readUInt16LE(offset + 8);
            const compression = archive.readUInt16LE(offset + 10);
            const compressedSize = archive.readUInt32LE(offset + 20);
            const uncompressedSize = archive.readUInt32LE(offset + 24);
            const fileNameLength = archive.readUInt16LE(offset + 28);
            const extraLength = archive.readUInt16LE(offset + 30);
            const commentLength = archive.readUInt16LE(offset + 32);
            const externalAttributes = archive.readUInt32LE(offset + 38);
            const localHeaderOffset = archive.readUInt32LE(offset + 42);
            const fileName = archive.subarray(offset + 46, offset + 46 + fileNameLength).toString((flags & 0x0800) ? "utf8" : "utf8");

            offset += 46 + fileNameLength + extraLength + commentLength;

            if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
                throw new Error("ZIP64 Electron archives are not supported by the embedded extractor.");
            }

            await this.extractZipEntry(
                archive,
                destinationRoot,
                fileName,
                compression,
                compressedSize,
                uncompressedSize,
                externalAttributes,
                localHeaderOffset,
                flags,
            );
            if ((index + 1) % 20 === 0 || index + 1 === entryCount) {
                await this.emitBootstrapStage(
                    "Expanding Electron",
                    "Expanding the downloaded Electron runtime.",
                    electronStepProgress("expandElectron", (index + 1) / Math.max(entryCount, 1)),
                    false,
                    undefined,
                    undefined,
                );
            }
        }
    }

    private findZipEndOfCentralDirectory(archive: Buffer): number {
        const minimumOffset = Math.max(0, archive.length - 0xffff - 22);
        for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
            if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
        }
        throw new Error("Unable to find the ZIP central directory.");
    }

    private async extractZipEntry(
        archive: Buffer,
        destinationRoot: string,
        fileName: string,
        compression: number,
        compressedSize: number,
        uncompressedSize: number,
        externalAttributes: number,
        localHeaderOffset: number,
        flags: number,
    ): Promise<void> {
        if ((flags & 0x0001) !== 0) throw new Error(`Encrypted ZIP entries are not supported: ${fileName}`);
        if (archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local file header: ${fileName}`);

        const localFileNameLength = archive.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
        const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
        const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
        const mode = (externalAttributes >>> 16) & 0xffff;
        const fileType = mode & 0o170000;
        const destination = this.safeZipDestination(destinationRoot, fileName);

        if (fileName.endsWith("/") || fileType === 0o040000) {
            await originalFs.promises.rm(destination, { recursive: true, force: true });
            await originalFs.promises.mkdir(destination, { recursive: true });
            if (mode & 0o777) {
                try { await originalFs.promises.chmod(destination, mode & 0o777); } catch { /* ignore */ }
            }
            return;
        }

        const content = compression === 0
            ? Buffer.from(compressed)
            : compression === 8
                ? await inflateRawAsync(compressed)
                : undefined;
        if (!content) throw new Error(`Unsupported ZIP compression method ${compression}: ${fileName}`);
        if (content.length !== uncompressedSize) throw new Error(`ZIP entry size mismatch: ${fileName}`);

        await originalFs.promises.mkdir(path.dirname(destination), { recursive: true });

        if (fileType === 0o120000) {
            await originalFs.promises.rm(destination, { recursive: true, force: true });
            await originalFs.promises.symlink(content.toString("utf8"), destination);
            return;
        }

        await originalFs.promises.rm(destination, { recursive: true, force: true });
        await originalFs.promises.writeFile(destination, content);
        const permissions = mode & 0o777;
        if (permissions) {
            try { await originalFs.promises.chmod(destination, permissions); } catch { /* ignore */ }
        } else if (process.platform !== "win32" && this.isPortableElectronExecutableName(path.basename(destination))) {
            try { await originalFs.promises.chmod(destination, 0o755); } catch { /* ignore */ }
        }
    }

    private safeZipDestination(destinationRoot: string, fileName: string): string {
        const normalized = fileName.replace(/\\/g, "/");
        if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
            throw new Error(`Unsafe ZIP entry path: ${fileName}`);
        }

        const root = path.resolve(destinationRoot);
        const destination = path.resolve(root, ...normalized.split("/").filter(Boolean));
        if (destination !== root && !destination.startsWith(root + path.sep)) {
            throw new Error(`Unsafe ZIP entry destination: ${fileName}`);
        }
        return destination;
    }

    private isPortableElectronExecutableName(name: string): boolean {
        return [
            "electron",
            "chrome-sandbox",
            "chrome_crashpad_handler",
            "chrome_crashpad_handler.exe",
            "electron.exe",
        ].includes(name.toLowerCase());
    }

    private async removePathIfExists(target: string): Promise<void> {
        await fs.promises.rm(target, { recursive: true, force: true });
    }

    private async tryRemoveTree(target: string, label: string): Promise<void> {
        try {
            await this.removePathIfExists(target);
        } catch (error) {
            this.appendRecentOutput(`${label} skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private findExtractedElectronApp(root: string): string {
        const candidates = [
            path.join(root, "Electron.app"),
            ...this.childDirectoriesMatching(root, /\.app$/).map((entry) => path.join(root, entry)),
        ];
        const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "Contents", "MacOS", "Electron")));
        if (!found) throw new Error("The downloaded Electron archive did not contain Electron.app.");
        return found;
    }

    private async replaceMacElectronRuntime(sourceApp: string, targetApp: string): Promise<void> {
        const sourceContents = path.join(sourceApp, "Contents");
        const targetContents = path.join(targetApp, "Contents");
        const sourceExecutable = path.join(sourceContents, "MacOS", "Electron");
        const targetExecutable = app.getPath("exe");
        const sourceFrameworks = path.join(sourceContents, "Frameworks");
        const targetFrameworks = path.join(targetContents, "Frameworks");

        if (!fs.existsSync(sourceExecutable)) throw new Error(`Missing Electron executable in downloaded runtime: ${sourceExecutable}`);
        if (!fs.existsSync(targetExecutable)) throw new Error(`Missing current app executable: ${targetExecutable}`);
        if (!fs.existsSync(sourceFrameworks)) throw new Error(`Missing Electron frameworks in downloaded runtime: ${sourceFrameworks}`);
        if (!fs.existsSync(targetFrameworks)) throw new Error(`Missing current app frameworks directory: ${targetFrameworks}`);

        await this.replaceFileAtomically(sourceExecutable, targetExecutable, 0o755);

        for (const entry of fs.readdirSync(sourceFrameworks, { withFileTypes: true })) {
            const source = path.join(sourceFrameworks, entry.name);
            const target = path.join(targetFrameworks, entry.name);
            if (entry.isDirectory() && entry.name.endsWith(".framework")) {
                await this.replaceDirectoryAtomically(source, target);
            } else if (entry.isFile() && (entry.name.endsWith(".dylib") || entry.name.endsWith(".so"))) {
                await this.replaceFileAtomically(source, target, 0o755);
            }
        }

        await this.replaceMacElectronHelperExecutables(sourceFrameworks, targetFrameworks);
    }

    private async replacePortableElectronRuntime(sourceRoot: string, targetRoot: string): Promise<void> {
        const sourceExecutableName = this.portableElectronSourceExecutableName();
        const sourceExecutable = path.join(sourceRoot, sourceExecutableName);
        const targetExecutable = app.getPath("exe");

        if (!fs.existsSync(sourceExecutable)) throw new Error(`Missing Electron executable in downloaded runtime: ${sourceExecutable}`);
        if (!fs.existsSync(targetExecutable)) throw new Error(`Missing current app executable: ${targetExecutable}`);

        await this.replaceFileAtomically(sourceExecutable, targetExecutable, 0o755);

        for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
            if (entry.name === "resources" || entry.name === sourceExecutableName) continue;
            const source = path.join(sourceRoot, entry.name);
            const target = path.join(targetRoot, entry.name);

            if (entry.isDirectory() && !entry.isSymbolicLink()) {
                await this.replaceDirectoryAtomically(source, target);
            } else {
                await this.replaceFileAtomically(source, target, this.fileMode(source));
            }
        }
    }

    private fileMode(source: string): number | undefined {
        try {
            return fs.statSync(source).mode & 0o777;
        } catch {
            return undefined;
        }
    }

    private async replaceMacElectronHelperExecutables(sourceFrameworks: string, targetFrameworks: string): Promise<void> {
        const sourceHelpers = new Map<string, string>();
        for (const helper of this.childDirectoriesMatching(sourceFrameworks, /\.app$/)) {
            sourceHelpers.set(this.helperAppKind(helper), path.join(sourceFrameworks, helper));
        }

        for (const helper of this.childDirectoriesMatching(targetFrameworks, /\.app$/)) {
            const kind = this.helperAppKind(helper);
            const sourceHelper = sourceHelpers.get(kind);
            if (!sourceHelper) continue;

            const sourceExecutable = this.firstExecutableInMacApp(sourceHelper);
            const targetHelper = path.join(targetFrameworks, helper);
            const targetExecutable = this.firstExecutableInMacApp(targetHelper);
            if (!sourceExecutable || !targetExecutable) continue;

            await this.replaceFileAtomically(sourceExecutable, targetExecutable, 0o755);
        }
    }

    private async replaceFileAtomically(source: string, target: string, mode?: number): Promise<void> {
        const directory = path.dirname(target);
        const baseName = path.basename(target);
        const temp = path.join(directory, `.${baseName}.new-${randomUUID()}`);
        const backup = path.join(directory, `.${baseName}.old-${randomUUID()}`);
        let movedTarget = false;

        await fs.promises.copyFile(source, temp);
        if (mode !== undefined) await fs.promises.chmod(temp, mode);

        try {
            if (fs.existsSync(target)) {
                await fs.promises.rename(target, backup);
                movedTarget = true;
            }
            await fs.promises.rename(temp, target);
        } catch (error) {
            await fs.promises.rm(temp, { force: true });
            if (movedTarget && !fs.existsSync(target) && fs.existsSync(backup)) {
                await fs.promises.rename(backup, target);
            }
            throw error;
        } finally {
            await fs.promises.rm(backup, { force: true });
        }
    }

    private async replaceDirectoryAtomically(source: string, target: string): Promise<void> {
        const directory = path.dirname(target);
        const baseName = path.basename(target);
        const temp = path.join(directory, `.${baseName}.new-${randomUUID()}`);
        const backup = path.join(directory, `.${baseName}.old-${randomUUID()}`);
        let movedTarget = false;

        await this.removePathIfExists(temp);
        await fs.promises.cp(source, temp, { recursive: true, verbatimSymlinks: true });

        try {
            if (fs.existsSync(target)) {
                await fs.promises.rename(target, backup);
                movedTarget = true;
            }
            await fs.promises.rename(temp, target);
        } catch (error) {
            await this.tryRemoveTree(temp, "Directory replacement cleanup");
            if (movedTarget && !fs.existsSync(target) && fs.existsSync(backup)) {
                await fs.promises.rename(backup, target);
            }
            throw error;
        } finally {
            await this.tryRemoveTree(backup, "Directory replacement backup cleanup");
        }
    }

    private helperAppKind(name: string): string {
        if (name.includes("(GPU)")) return "gpu";
        if (name.includes("(Plugin)")) return "plugin";
        if (name.includes("(Renderer)")) return "renderer";
        return "main";
    }

    private firstExecutableInMacApp(appBundle: string): string | undefined {
        const macOSDirectory = path.join(appBundle, "Contents", "MacOS");
        try {
            return fs.readdirSync(macOSDirectory)
                .map((entry) => path.join(macOSDirectory, entry))
                .find((entry) => fs.statSync(entry).isFile());
        } catch {
            return undefined;
        }
    }

    private childDirectoriesMatching(parent: string, pattern: RegExp): string[] {
        try {
            return fs.readdirSync(parent, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
                .filter((entry) => pattern.test(entry.name))
                .map((entry) => entry.name);
        } catch {
            return [];
        }
    }

    private formatDownloadStageStatus(progress: Parameters<typeof formatDownloadStatus>[0]): string {
        const formatted = formatDownloadStatus(progress)?.trim();
        if (formatted) return formatted;

        const record = progress as unknown as Record<string, unknown>;
        const receivedBytes = this.firstFiniteNumber(record, [
            "receivedBytes",
            "downloadedBytes",
            "completedBytes",
            "loadedBytes",
            "bytesDownloaded",
        ]);
        const totalBytes = this.firstFiniteNumber(record, [
            "totalBytes",
            "expectedBytes",
            "expectedByteCount",
            "contentLength",
            "bytesTotal",
        ]);
        const speedBytesPerSecond = this.firstFiniteNumber(record, [
            "bytesPerSecond",
            "speedBytesPerSecond",
            "speed",
            "downloadSpeed",
        ]);
        const remainingSeconds = this.firstFiniteNumber(record, [
            "remainingSeconds",
            "estimatedSecondsRemaining",
            "secondsRemaining",
            "etaSeconds",
        ]);

        const sizeText = receivedBytes !== undefined && totalBytes !== undefined
            ? `${this.formatByteCount(receivedBytes)}/${this.formatByteCount(totalBytes)}`
            : receivedBytes !== undefined
                ? this.formatByteCount(receivedBytes)
                : "Preparing download";

        const speedText = speedBytesPerSecond !== undefined && speedBytesPerSecond > 0
            ? `${this.formatByteCount(speedBytesPerSecond)}/s`
            : undefined;

        const remainingText = remainingSeconds !== undefined && Number.isFinite(remainingSeconds) && remainingSeconds >= 0
            ? `${this.formatDuration(Math.ceil(remainingSeconds))} remaining`
            : undefined;

        return [sizeText, speedText, remainingText].filter(Boolean).join("    ");
    }

    private firstFiniteNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
        for (const key of keys) {
            const value = record[key];
            if (typeof value === "number" && Number.isFinite(value)) return value;
        }
        return undefined;
    }

    private formatByteCount(bytes: number): string {
        const units = ["B", "KB", "MB", "GB", "TB"];
        let value = Math.max(0, bytes);
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }

        if (unitIndex === 0) return `${Math.round(value)} ${units[unitIndex]}`;
        const digits = value >= 100 ? 0 : value >= 10 ? 1 : 1;
        return `${value.toFixed(digits)} ${units[unitIndex]}`;
    }

    private formatDuration(totalSeconds: number): string {
        const seconds = Math.max(0, Math.round(totalSeconds));
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainder = seconds % 60;
        if (minutes < 60) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        const minuteRemainder = minutes % 60;
        return minuteRemainder > 0 ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
    }

    private async waitForDownloadResume(): Promise<"ready" | "skipped"> {
        if (this.downloadSkipRequested) {
            this.downloadSkipRequested = false;
            return "skipped";
        }

        while (this.downloadPauseRequested) {
            await new Promise<void>((resolve) => {
                this.downloadResumeResolvers.add(resolve);
            });

            if (this.downloadSkipRequested) {
                this.downloadSkipRequested = false;
                return "skipped";
            }
        }

        return "ready";
    }

    private resolveDownloadResumeWaiters(): void {
        if (this.downloadResumeResolvers.size === 0) return;
        const resolvers = [...this.downloadResumeResolvers];
        this.downloadResumeResolvers.clear();
        for (const resolve of resolvers) resolve();
    }

    private async downloadFile(
        url: string,
        destination: string,
        expectedByteCount: number | undefined,
        title: string,
        detail: string,
        overallStart: number,
        overallEnd: number,
        mainProgressFractionForDownload?: (progress: DownloadProgress) => number | undefined,
        progressObserver?: (progress: DownloadProgress, task: ManagedDownloadTask) => void,
    ): Promise<"completed" | "skipped"> {
        if ((await this.waitForDownloadResume()) === "skipped") return "skipped";

        const debugLabel = `${detail} -> ${path.basename(destination)}`;
        this.traceDownload("file-start", { debugLabel, destination, expectedByteCount });
        const task = new ManagedDownloadTask(url, destination, expectedByteCount, (progress) => {
            if (this.downloadPauseRequested) return;
            progressObserver?.(progress, task);
            const mapped = overallStart + (overallEnd - overallStart) * clamp01(progress.fraction);
            void this.emitBootstrapStage(
                title,
                detail,
                mapped,
                true,
                progress.fraction,
                this.formatDownloadStageStatus(progress),
                mainProgressFractionForDownload?.(progress),
            );
        }, debugLabel);
        this.activeDownloadTask = task;
        try {
            const result = await task.start(this.downloadPauseRequested);
            this.traceDownload("file-result", { debugLabel, result, snapshot: task.snapshot() });
            return result;
        } finally {
            if (this.activeDownloadTask === task) this.activeDownloadTask = undefined;
        }
    }

    private async downloadFileWithFallback(
        urls: string[],
        destination: string,
        expectedByteCount: number | undefined,
        title: string,
        detail: string,
        overallStart: number,
        overallEnd: number,
        mainProgressFractionForDownload?: (progress: DownloadProgress) => number | undefined,
    ): Promise<"completed" | "skipped"> {
        let lastError: unknown;
        for (const url of urls) {
            if ((await this.waitForDownloadResume()) === "skipped") return "skipped";

            try {
                return await this.downloadFile(
                    url,
                    destination,
                    expectedByteCount,
                    title,
                    detail,
                    overallStart,
                    overallEnd,
                    mainProgressFractionForDownload,
                );
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async runManagerForJson<T>(command: string): Promise<T> {
        const output = await this.runManagerRaw([command], true);
        const candidates = output
            .split(/\r?\n/)
            .map((v) => v.trim())
            .filter((v) => v.startsWith("{") && v.endsWith("}"))
            .reverse();
        for (const candidate of candidates) {
            try { return JSON.parse(candidate) as T; } catch { /* keep trying */ }
        }
        throw new Error(`The runtime manager returned an unexpected response:\n\n${output}`);
    }

    private async runManagerRaw(args: (string | BootstrapMode)[], capture = false): Promise<string> {
        const script = AppPaths.runtimeManagerScript();
        const runtimePython = AppPaths.runtimePython();
        const hasRuntimePython = AppPaths.isExecutable(runtimePython);
        const python = hasRuntimePython ? runtimePython : AppPaths.bootstrapPython();

        return await new Promise<string>((resolve, reject) => {
            let combinedOutput = "";
            const lockedOutput: string[] = [];
            let settled = false;
            const appendLocked = (buf: Buffer) => {
                const text = buf.toString("utf8");
                combinedOutput += text;
                this.appendLockedOutput(lockedOutput, text);
            };
            const child = spawn(python, [script, ...args.map(String)], {
                cwd: hasRuntimePython ? AppPaths.pythonWorkingDirectory() : AppPaths.projectRoot(),
                env: AppPaths.makeRuntimeManagerEnvironment(),
            });
            this.currentProcess = child;
            child.stdout.on("data", (chunk) => {
                const buf = Buffer.from(chunk);
                appendLocked(buf);
                if (!capture) this.handleRuntimeOutput(buf, this.stdoutAccumulator);
            });
            child.stderr.on("data", (chunk) => {
                const buf = Buffer.from(chunk);
                appendLocked(buf);
                if (!capture) this.handleRuntimeOutput(buf, this.stderrAccumulator);
            });
            child.on("error", (error) => {
                if (settled) return;
                settled = true;
                this.currentProcess = undefined;
                reject(new Error(`Failed to run runtime manager with ${python}: ${error.message}`));
            });
            child.on("close", (code) => {
                if (settled) return;
                settled = true;
                this.currentProcess = undefined;
                if (code === 0) resolve(combinedOutput);
                else {
                    const text = this.lockedOutputText(lockedOutput) || combinedOutput.trim();
                    reject(new Error(text ? `The embedded runtime command exited with status ${code}.\n\n${text}` : `The embedded runtime command exited with status ${code}.`));
                }
            });
        });
    }

    private async runRuntimePythonProcess(
        args: string[],
        cwd: string,
        env: NodeJS.ProcessEnv,
        capture: boolean,
        progressStart = 0,
        progressCeiling = 1,
        title = "Preparing Runtime",
        options: RuntimeProcessOptions = {},
    ): Promise<string> {
        return await new Promise<string>((resolve, reject) => {
            let combinedOutput = "";
            const lockedOutput: string[] = [];
            let settled = false;
            const appendLocked = (buf: Buffer) => {
                const text = buf.toString("utf8");
                if (capture) combinedOutput += text;
                this.appendLockedOutput(lockedOutput, text);
            };
            const executable = env.LABEL_STUDIO_RUNTIME_PYTHON ?? AppPaths.runtimePython();
            const child = spawn(executable, args, {
                cwd: this.runtimePythonWorkingDirectory(cwd, env),
                env,
                shell: false,
            });
            this.currentProcess = child;
            child.stdout.on("data", (chunk) => {
                const buf = Buffer.from(chunk);
                appendLocked(buf);
                if (!capture) this.handleRuntimeOutput(buf, this.stdoutAccumulator, title, progressStart, progressCeiling, options);
            });
            child.stderr.on("data", (chunk) => {
                const buf = Buffer.from(chunk);
                appendLocked(buf);
                if (!capture) this.handleRuntimeOutput(buf, this.stderrAccumulator, title, progressStart, progressCeiling, options);
            });
            child.on("error", (error) => {
                if (settled) return;
                settled = true;
                this.currentProcess = undefined;
                reject(new Error(`Failed to run ${executable}: ${error.message}`));
            });
            child.on("close", (code) => {
                if (settled) return;
                settled = true;
                this.currentProcess = undefined;
                if (code === 0) resolve(combinedOutput);
                else {
                    const text = this.lockedOutputText(lockedOutput) || combinedOutput.trim();
                    reject(new Error(text ? `The embedded runtime command exited with status ${code}.\n\n${text}` : `The embedded runtime command exited with status ${code}.`));
                }
            });
        });
    }

    private runtimePythonWorkingDirectory(cwd: string, env: NodeJS.ProcessEnv): string {
        const runtimeRoot = env.LABEL_STUDIO_RUNTIME_ROOT;
        if (!runtimeRoot || !this.isSameOrInsideDirectory(cwd, runtimeRoot)) return cwd;
        return AppPaths.pythonWorkingDirectory();
    }

    private isSameOrInsideDirectory(candidate: string, root: string): boolean {
        const relative = path.relative(path.resolve(root), path.resolve(candidate));
        return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    }

    private async runLocalProcess(executable: string, args: string[], cwd: string, allowFailure = false): Promise<string> {
        return await new Promise<string>((resolve, reject) => {
            const lockedOutput: string[] = [];
            let settled = false;
            const child = spawn(executable, args, { cwd, shell: false, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
            this.currentProcess = child;
            child.stdout.on("data", (chunk) => {
                const buf = Buffer.from(chunk);
                this.appendLockedOutput(lockedOutput, buf.toString("utf8"));
                this.handleRuntimeOutput(buf, this.stdoutAccumulator);
            });
            child.stderr.on("data", (chunk) => {
                const buf = Buffer.from(chunk);
                this.appendLockedOutput(lockedOutput, buf.toString("utf8"));
                this.handleRuntimeOutput(buf, this.stderrAccumulator);
            });
            child.on("error", (error) => {
                if (settled) return;
                settled = true;
                this.currentProcess = undefined;
                if (allowFailure) resolve(`Failed to run ${executable}: ${error.message}`);
                else reject(error);
            });
            child.on("close", (code) => {
                if (settled) return;
                settled = true;
                this.currentProcess = undefined;
                const text = this.lockedOutputText(lockedOutput);
                if (code === 0 || allowFailure) resolve(text);
                else reject(new Error(text ? `The embedded runtime command exited with status ${code}.\n\n${text}` : `The embedded runtime command exited with status ${code}.`));
            });
        });
    }

    private async withRuntimeReadLock<T>(operation: () => Promise<T>): Promise<T> {
        await this.acquireRuntimeReadLock();
        try {
            return await operation();
        } finally {
            this.releaseRuntimeReadLock();
        }
    }

    private async acquireRuntimeReadLock(): Promise<void> {
        if (!this.runtimeWriterActive && this.runtimeWriterWaiters.length === 0) {
            this.runtimeReaderCount += 1;
            return;
        }

        await new Promise<void>((resolve) => {
            this.runtimeReaderWaiters.push(() => {
                this.runtimeReaderCount += 1;
                resolve();
            });
        });
    }

    private releaseRuntimeReadLock(): void {
        if (this.runtimeReaderCount <= 0) throw new Error("Runtime read lock underflow.");
        this.runtimeReaderCount -= 1;
        if (this.runtimeReaderCount === 0) this.startNextRuntimeWriter();
    }

    private async acquireRuntimeWriteLock(): Promise<void> {
        if (!this.runtimeWriterActive && this.runtimeReaderCount === 0) {
            this.runtimeWriterActive = true;
            return;
        }

        await new Promise<void>((resolve) => {
            this.runtimeWriterWaiters.push(() => {
                this.runtimeWriterActive = true;
                resolve();
            });
        });
    }

    private releaseRuntimeWriteLock(): void {
        if (!this.runtimeWriterActive) throw new Error("Runtime write lock is not held.");
        this.runtimeWriterActive = false;
        if (this.startNextRuntimeWriter()) return;

        const readers = this.runtimeReaderWaiters.splice(0);
        for (const resume of readers) resume();
    }

    private startNextRuntimeWriter(): boolean {
        if (this.runtimeWriterActive || this.runtimeReaderCount > 0) return false;
        const resume = this.runtimeWriterWaiters.shift();
        if (!resume) return false;
        resume();
        return true;
    }

    private appendLockedOutput(lines: string[], text: string): void {
        const trimmed = text.trim();
        if (!trimmed) return;
        lines.push(trimmed);
        if (lines.length > 80) lines.splice(0, lines.length - 80);
    }

    private lockedOutputText(lines: string[]): string {
        return lines.filter((line) => line.length > 0).join("\n");
    }

    private resetPipInstallProgressState(initialMainFraction = 0): void {
        this.pipDownloadProgress = undefined;
        this.pipInstallMainFraction = clamp01(initialMainFraction);
    }

    private stripAnsi(text: string): string {
        return text
            .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
            .replace(/\r/g, "\n");
    }

    private handlePipDownloadProgressLine(
        rawLine: string,
        progressStart: number,
        progressCeiling: number,
        title: string,
    ): boolean {
        const line = this.stripAnsi(rawLine).trim();
        if (!line) return false;

        const downloading = line.match(/^Downloading\s+(.+?)(?:\s+\(([^)]+)\))?$/i);
        if (downloading?.[1]) {
            const now = Date.now();
            const size = downloading[2] ? this.parseByteCount(downloading[2]) : undefined;
            const detail = `Downloading ${downloading[1]}.`;
            this.pipDownloadProgress = {
                filename: downloading[1],
                downloadedBytes: 0,
                totalBytes: size ?? 0,
                startedAt: now,
                lastBytes: 0,
                lastAt: now,
                lastByteProgressAt: now,
            };
            const detailFraction = this.advancePipInstallDetailMainFraction(
                `pip-detail:${title}:${progressStart}:${progressCeiling}`,
                progressStart,
                progressCeiling,
            );
            const mainFraction = this.advancePipInstallMainFraction(detailFraction);
            void this.emitBootstrapStage(
                title,
                detail,
                progressStart + (progressCeiling - progressStart) * mainFraction,
                true,
                0,
                size ? `0 B / ${this.formatByteCount(size)}` : "Preparing download",
                mainFraction,
            );
            return true;
        }

        const cached = line.match(/^Using cached\s+(.+?)(?:\s+\(([^)]+)\))?$/i);
        if (cached?.[1]) {
            const now = Date.now();
            const size = cached[2] ? this.parseByteCount(cached[2]) : undefined;
            const detail = `Using cached ${cached[1]}.`;
            this.pipDownloadProgress = {
                filename: cached[1],
                downloadedBytes: size ?? 0,
                totalBytes: size ?? 0,
                displayFraction: 1,
                startedAt: now,
                lastBytes: size ?? 0,
                lastAt: now,
                lastByteProgressAt: now,
            };
            const detailFraction = this.advancePipInstallDetailMainFraction(
                `pip-detail:${title}:${progressStart}:${progressCeiling}`,
                progressStart,
                progressCeiling,
            );
            const mainFraction = this.advancePipInstallMainFraction(detailFraction);
            void this.emitBootstrapStage(
                title,
                detail,
                progressStart + (progressCeiling - progressStart) * mainFraction,
                true,
                1,
                size
                    ? `${this.formatByteCount(size)} / ${this.formatByteCount(size)}`
                    : "Using cached package file",
                mainFraction,
            );
            return true;
        }

        const progress = line.match(/^Progress\s+(\d+)(?:\s+of\s+|\/)(\d+)/i);
        if (progress?.[1] && progress[2]) {
            return this.emitPipDownloadProgress(
                Number(progress[1]),
                Number(progress[2]),
                progressStart,
                progressCeiling,
                title,
            );
        }

        const barProgress = line.match(/(\d+(?:\.\d+)?)\s*([KMGT]?B)\s*\/\s*(\d+(?:\.\d+)?)\s*([KMGT]?B)(?:\s+(\d+(?:\.\d+)?)\s*([KMGT]?B)\/s)?(?:\s+eta\s+([0-9:]+))?/i);
        if (barProgress?.[1] && barProgress[2] && barProgress[3] && barProgress[4]) {
            const downloadedBytes = this.parseByteCount(`${barProgress[1]} ${barProgress[2]}`);
            const totalBytes = this.parseByteCount(`${barProgress[3]} ${barProgress[4]}`);
            if (downloadedBytes === undefined || totalBytes === undefined) return false;
            return this.emitPipDownloadProgress(
                downloadedBytes,
                totalBytes,
                progressStart,
                progressCeiling,
                title,
                barProgress[5] && barProgress[6] ? this.parseByteCount(`${barProgress[5]} ${barProgress[6]}`) : undefined,
                barProgress[7],
            );
        }

        return false;
    }

    private emitPipDownloadProgress(
        downloadedBytes: number,
        totalBytes: number,
        progressStart: number,
        progressCeiling: number,
        title: string,
        reportedBytesPerSecond?: number,
        reportedEta?: string,
    ): boolean {
        if (!Number.isFinite(downloadedBytes) || !Number.isFinite(totalBytes)) return false;
        const knownTotalBytes = totalBytes > 0 ? totalBytes : this.pipDownloadProgress?.totalBytes ?? 0;
        if (knownTotalBytes <= 0) {
            return this.emitUnknownSizePipDownloadProgress(
                downloadedBytes,
                progressStart,
                progressCeiling,
                title,
                reportedBytesPerSecond,
                reportedEta,
            );
        }

        const now = Date.now();
        const state = this.pipDownloadProgress ?? {
            filename: "package file",
            downloadedBytes: 0,
            totalBytes: knownTotalBytes,
            startedAt: now,
            lastBytes: 0,
            lastAt: now,
            lastByteProgressAt: now,
        };
        const elapsedMs = Math.max(1, now - state.lastAt);
        const deltaBytes = Math.max(0, downloadedBytes - state.lastBytes);
        const bytesPerSecond = reportedBytesPerSecond && reportedBytesPerSecond > 0
            ? reportedBytesPerSecond
            : deltaBytes > 0
                ? deltaBytes / (elapsedMs / 1000)
                : downloadedBytes / Math.max(1, (now - state.startedAt) / 1000);
        const fraction = clamp01(downloadedBytes / knownTotalBytes);
        state.downloadedBytes = downloadedBytes;
        state.totalBytes = knownTotalBytes;
        state.displayFraction = fraction;
        if (deltaBytes > 0) state.lastByteProgressAt = now;
        state.lastBytes = downloadedBytes;
        state.lastAt = now;
        this.pipDownloadProgress = state;

        const etaSeconds = bytesPerSecond > 0 ? (knownTotalBytes - downloadedBytes) / bytesPerSecond : 0;
        const eta = reportedEta ? this.formatPipEta(reportedEta) : this.formatDuration(etaSeconds);
        const status = `${this.formatByteCount(downloadedBytes)} / ${this.formatByteCount(knownTotalBytes)} ${this.formatByteCount(bytesPerSecond)}/s ${eta} remaining`;
        const mainFraction = this.advancePipInstallMainFraction(0.08 + 0.86 * fraction);
        void this.emitBootstrapStage(
            title,
            `Downloading ${state.filename}.`,
            progressStart + (progressCeiling - progressStart) * mainFraction,
            true,
            fraction,
            status,
            mainFraction,
        );
        return true;
    }

    private emitUnknownSizePipDownloadProgress(
        downloadedBytes: number,
        progressStart: number,
        progressCeiling: number,
        title: string,
        reportedBytesPerSecond?: number,
        reportedEta?: string,
    ): boolean {
        if (!Number.isFinite(downloadedBytes) || downloadedBytes < 0) return false;

        const now = Date.now();
        const state = this.pipDownloadProgress ?? {
            filename: "package file",
            downloadedBytes: 0,
            totalBytes: 0,
            startedAt: now,
            lastBytes: 0,
            lastAt: now,
            lastByteProgressAt: now,
        };
        const elapsedMs = Math.max(1, now - state.lastAt);
        const deltaBytes = Math.max(0, downloadedBytes - state.lastBytes);
        const bytesPerSecond = reportedBytesPerSecond && reportedBytesPerSecond > 0
            ? reportedBytesPerSecond
            : deltaBytes > 0
                ? deltaBytes / (elapsedMs / 1000)
                : downloadedBytes / Math.max(1, (now - state.startedAt) / 1000);
        const inferredFraction = downloadedBytes > 0
            ? Math.min(0.95, 1 - Math.exp(-downloadedBytes / (32 * 1024 * 1024)))
            : state.displayFraction ?? 0;
        const fraction = Math.max(state.displayFraction ?? 0, inferredFraction);
        state.downloadedBytes = downloadedBytes;
        state.totalBytes = 0;
        state.displayFraction = fraction;
        if (deltaBytes > 0) state.lastByteProgressAt = now;
        state.lastBytes = downloadedBytes;
        state.lastAt = now;
        this.pipDownloadProgress = state;

        const speedText = bytesPerSecond > 0 ? ` ${this.formatByteCount(bytesPerSecond)}/s` : "";
        const etaText = reportedEta ? ` ${this.formatPipEta(reportedEta)} remaining` : "";
        const status = `${this.formatByteCount(downloadedBytes)} downloaded${speedText}${etaText}`;
        const mainFraction = this.advancePipInstallMainFraction(0.08 + 0.72 * fraction);
        void this.emitBootstrapStage(
            title,
            `Downloading ${state.filename}.`,
            progressStart + (progressCeiling - progressStart) * mainFraction,
            true,
            fraction,
            status,
            mainFraction,
        );
        return true;
    }

    private formatPipEta(rawEta: string): string {
        const parts = rawEta.split(":").map((part) => Number(part));
        if (parts.some((part) => !Number.isFinite(part))) return rawEta;
        if (parts.length === 3) return this.formatDuration(parts[0] * 3600 + parts[1] * 60 + parts[2]);
        if (parts.length === 2) return this.formatDuration(parts[0] * 60 + parts[1]);
        return rawEta;
    }

    private advancePipInstallMainFraction(candidate: number): number {
        this.pipInstallMainFraction = Math.max(this.pipInstallMainFraction, clamp01(candidate));
        return this.pipInstallMainFraction;
    }

    private parseByteCount(text: string): number | undefined {
        const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)$/i);
        if (!match?.[1] || !match[2]) return undefined;
        const value = Number(match[1]);
        if (!Number.isFinite(value)) return undefined;
        const units: Record<string, number> = {
            B: 1,
            KB: 1024,
            MB: 1024 ** 2,
            GB: 1024 ** 3,
            TB: 1024 ** 4,
        };
        return Math.round(value * (units[match[2].toUpperCase()] ?? 1));
    }

    private handleRuntimeOutput(
        data: Buffer,
        accumulator: LineAccumulator,
        title = "Preparing Runtime",
        progressStart = 0,
        progressCeiling = 1,
        options: RuntimeProcessOptions = {},
    ): void {
        for (const line of accumulator.append(data)) {
            this.appendRecentOutput(line);
            if (options.outputShowsDownloadProgress === true && this.handlePipDownloadProgressLine(line, progressStart, progressCeiling, title)) {
                continue;
            }
            const detail = this.processStatusDetail(line);
            if (!detail) continue;

            const key = `process:${title}:${progressStart}:${progressCeiling}`;
            const now = Date.now();
            const last = this.lastProcessEmissionByKey.get(key) ?? 0;
            if (now - last < 300) continue;
            this.lastProcessEmissionByKey.set(key, now);

            const progress = title === PackageInstallStageTitle
                ? this.advancePipInstallDetailProgress(key, progressStart, progressCeiling)
                : progressStart;
            void this.emitBootstrapStage(
                title,
                detail,
                progress,
                false,
                undefined,
                undefined,
            );
        }
    }

    private advancePipInstallDetailProgress(
        key: string,
        progressStart: number,
        progressCeiling: number,
    ): number {
        if (progressCeiling <= progressStart) return progressStart;

        const state = this.pipInstallDetailProgressStates.get(key) ?? {
            emittedDetails: 0,
            progress: progressStart,
        };
        state.emittedDetails += 1;

        const total = state.emittedDetails + DynamicPipInstallDetailReserveStepCount;
        const fraction = clamp01(state.emittedDetails / total);
        const nextProgress = progressStart + (progressCeiling - progressStart) * fraction;
        state.progress = Math.max(state.progress, nextProgress);
        this.pipInstallDetailProgressStates.set(key, state);
        return state.progress;
    }

    private advancePipInstallDetailMainFraction(
        key: string,
        progressStart: number,
        progressCeiling: number,
    ): number {
        if (progressCeiling <= progressStart) return 0;
        const progress = this.advancePipInstallDetailProgress(key, progressStart, progressCeiling);
        return clamp01((progress - progressStart) / (progressCeiling - progressStart));
    }

    private isUsefulProcessStatusLine(line: string): boolean {
        const prefixes = [
            "Collecting ", "Processing ", "Obtaining ",
            "Requirement already satisfied: ", "Using cached ",
            "Installing collected packages:", "Successfully installed ", "Preparing metadata",
            "Installing build dependencies", "Getting requirements to build wheel",
        ];
        return prefixes.some((prefix) => line.startsWith(prefix));
    }

    private processStatusDetail(text: string): string | undefined {
        const normalized = text.replace(/\r/g, "\n").replace(/\u001B/g, "");
        const lines = normalized
            .split(/\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        const line = [...lines].reverse().find((candidate) => this.isUsefulProcessStatusLine(candidate));
        if (!line) return undefined;

        if (line.startsWith("Requirement already satisfied: ")) {
            return `Already satisfied: ${line.slice("Requirement already satisfied: ".length)}.`;
        }
        if (line.startsWith("Collecting ")) {
            return `Collecting ${line.slice("Collecting ".length)}.`;
        }
        if (line.startsWith("Processing ")) {
            return `Processing ${this.filenameFromPipProcessingValue(line.slice("Processing ".length))}.`;
        }
        if (line.startsWith("Obtaining ")) {
            return `Obtaining ${line.slice("Obtaining ".length)}.`;
        }
        if (line.startsWith("Using cached ")) {
            return `Using cached ${line.slice("Using cached ".length)}.`;
        }
        if (line.startsWith("Installing collected packages:")) {
            return "Installing dependency packages.";
        }
        if (line.startsWith("Successfully installed ")) {
            return "Finished installing packages.";
        }

        return line.endsWith(".") ? line : `${line}.`;
    }

    private normalizePackageName(name: string): string {
        return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
    }

    private filenameFromUrl(url: string): string {
        try {
            const parsed = new URL(url);
            const name = decodeURIComponent(path.basename(parsed.pathname));
            return name || "downloaded-package";
        } catch {
            return path.basename(url.split("?", 1)[0]) || "downloaded-package";
        }
    }

    private filenameFromPipProcessingValue(value: string): string {
        const trimmed = value.trim();
        if (!trimmed) return "package file";
        if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return this.filenameFromUrl(trimmed);
        return path.basename(trimmed) || trimmed;
    }

    private async completeInstallationCacheStage(...cacheKinds: RuntimeInstallationCacheKind[]): Promise<void> {
        if (!AppPaths.shouldReclaimRuntimeCache() || cacheKinds.length === 0) return;

        const cacheKindsOwnedByMain = cacheKinds.filter(cacheKind =>
            cacheKind !== "electron" || !this.electronRuntimeReplacementPending,
        );
        await this.reclaimOrDeferInstallationCacheStage(cacheKindsOwnedByMain);
    }

    private async runInstallationStageWithFailureCacheCleanup<T>(
        cacheKinds: RuntimeInstallationCacheKind[],
        operation: () => Promise<T>,
    ): Promise<T> {
        try {
            const result = await operation();
            if (this.lastRuntimeOperationSkipped) {
                await this.cleanupFailedInstallationCacheStage(cacheKinds);
            }
            return result;
        } catch (error) {
            await this.cleanupFailedInstallationCacheStage(cacheKinds);
            throw error;
        }
    }

    private async cleanupFailedInstallationCacheStage(cacheKinds: RuntimeInstallationCacheKind[]): Promise<void> {
        if (!AppPaths.shouldReclaimRuntimeCache() || cacheKinds.length === 0) return;

        if (cacheKinds.includes("electron")) {
            this.electronRuntimeReplacementPending = false;
            this.electronRuntimeReplacement = undefined;
        }
        await this.reclaimOrDeferInstallationCacheStage(cacheKinds);
    }

    private async reclaimOrDeferInstallationCacheStage(cacheKinds: RuntimeInstallationCacheKind[]): Promise<void> {
        const immediatelyReclaimable = new Set<RuntimeInstallationCacheKind>();
        for (const cacheKind of cacheKinds) {
            if (this.hasPendingRuntimeReplacement()) {
                this.pendingRuntimeInstallationCacheCleanup.add(cacheKind);
            } else {
                immediatelyReclaimable.add(cacheKind);
            }
        }

        await this.reclaimRuntimeInstallationCaches(immediatelyReclaimable);
    }

    private async reclaimRuntimeInstallationCaches(cacheKinds: Iterable<RuntimeInstallationCacheKind>): Promise<void> {
        for (const cacheKind of new Set(cacheKinds)) {
            const cacheDirectory = cacheKind === "python"
                ? AppPaths.pythonDownloadCacheDirectory()
                : cacheKind === "package"
                    ? AppPaths.packageDownloadCacheDirectory()
                    : AppPaths.electronDownloadCacheDirectory();
            await this.reclaimInstallationCacheDirectory(cacheDirectory);
        }
    }

    private async reclaimInstallationCacheDirectory(cacheDirectory: string): Promise<void> {
        try {
            await fs.promises.rm(cacheDirectory, { recursive: true, force: true });
        } catch (error) {
            this.appendRecentOutput(`Cache cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async emitBootstrapStage(
        title: string,
        detail: string,
        progress: number,
        showsDownloadProgress: boolean,
        downloadProgress: number | undefined,
        downloadStatus: string | undefined,
        mainProgressFraction?: number,
        progressStep?: string,
    ): Promise<void> {
        const clampedProgress = clamp01(progress);
        const clampedDownloadProgress = downloadProgress == null ? undefined : clamp01(downloadProgress);
        const inferredMainProgressFraction = runtimeStageMainProgressFraction(title, clampedProgress)
            ?? electronStageMainProgressFraction(title, clampedProgress);
        const clampedMainProgressFraction = inferredMainProgressFraction
            ?? (mainProgressFraction == null ? undefined : clamp01(mainProgressFraction));
        let stageDownloadProgress = showsDownloadProgress ? clampedDownloadProgress : undefined;
        let stageDownloadStatus = showsDownloadProgress ? downloadStatus : undefined;

        const lowerBound = Math.min(this.activeProgressRange[0], this.activeProgressRange[1]);
        const upperBound = Math.max(this.activeProgressRange[0], this.activeProgressRange[1]);
        const mappedProgress = lowerBound + (upperBound - lowerBound) * clampedProgress;
        const stage = launchStage({
            title,
            detail,
            progress: mappedProgress,
            progressStep,
            showsDownloadProgress,
            mainProgressFraction: clampedMainProgressFraction,
            downloadProgress: stageDownloadProgress,
            downloadStatus: stageDownloadStatus,
        });
        this.publishBootstrapStage(stage);
    }

    private publishBootstrapStage(stage: LaunchStage): void {
        if (stage.showsDownloadProgress) {
            this.downloadPauseAllowed = true;
        } else {
            this.downloadPauseAllowed = false;
            if (this.downloadPauseRequested) {
                this.traceDownload("resume-after-download-stage", { title: stage.title });
                this.setCurrentDownloadPaused(false);
            }
        }

        // setDownloadPaused() publishes the paused label independently. Suppress
        // download-stage churn while paused so queued resolver or completion events
        // cannot advance the progress bar or switch the visible file.
        if (this.downloadPauseRequested && stage.showsDownloadProgress) return;

        const now = Date.now();
        if (this.isHoldingAfterCompletedDownload(now)) {
            if (this.isDownloadCompletionStage(stage)) {
                this.heldCompletionStages.push(stage);
            } else {
                this.heldStage = stage;
            }
            this.scheduleHeldStagePublish(this.downloadCompletionHoldUntil - now);
            return;
        }

        this.publishBootstrapStageImmediately(stage);
    }

    private isDownloadCompletionStage(stage: LaunchStage): boolean {
        return stage.showsDownloadProgress && (stage.downloadProgress ?? 0) >= 1;
    }

    private isHoldingAfterCompletedDownload(now: number): boolean {
        return now < this.downloadCompletionHoldUntil;
    }

    private scheduleHeldStagePublish(delayMs: number): void {
        if (this.stageHoldTimer) return;
        const sequence = this.stageSequence;
        this.stageHoldTimer = setTimeout(() => {
            this.stageHoldTimer = undefined;
            if (sequence !== this.stageSequence) {
                this.heldStage = undefined;
                return;
            }
            this.flushHeldStage();
        }, Math.max(0, delayMs));
    }

    private flushHeldStage(): void {
        if (this.stageHoldTimer) {
            clearTimeout(this.stageHoldTimer);
            this.stageHoldTimer = undefined;
        }
        const completionStage = this.heldCompletionStages.shift();
        if (completionStage) {
            this.publishBootstrapStageImmediately(completionStage);
            if (this.heldCompletionStages.length > 0 || this.heldStage) {
                const now = Date.now();
                if (this.isHoldingAfterCompletedDownload(now)) {
                    this.scheduleHeldStagePublish(this.downloadCompletionHoldUntil - now);
                } else {
                    this.flushHeldStage();
                }
            }
            return;
        }

        const stage = this.heldStage;
        this.heldStage = undefined;
        if (stage) this.publishBootstrapStageImmediately(stage);
    }

    private clearHeldStage(): void {
        if (this.stageHoldTimer) {
            clearTimeout(this.stageHoldTimer);
            this.stageHoldTimer = undefined;
        }
        this.heldStage = undefined;
        this.heldCompletionStages = [];
        this.downloadCompletionHoldUntil = 0;
    }

    private publishBootstrapStageImmediately(stage: LaunchStage): void {
        this.emit("stage", stage);
        this.transientStageUpdate?.(stage);
        if (stage.showsDownloadProgress && (stage.downloadProgress ?? 0) >= 1) {
            this.downloadCompletionHoldUntil = Date.now() + CompletedDownloadStageHoldMs;
        } else if (!this.isHoldingAfterCompletedDownload(Date.now())) {
            this.downloadCompletionHoldUntil = 0;
        }
    }

    private appendRecentOutput(line: string): void {
        this.recentOutput.push(line);
        if (this.recentOutput.length > 60) this.recentOutput.splice(0, this.recentOutput.length - 60);
    }

    private traceDownload(event: string, data?: unknown): void {
        const payload = data == null ? "" : ` ${JSON.stringify(data)}`;
        console.info(`[download] ${event}${payload}`);
    }

    private preferTunaPyPIForCurrentRun(): void {
        this.preferTunaPyPI = true;
        this.preferTunaPyPIArtifactFiles = true;
    }

    private preferTunaPyPIArtifactFilesForCurrentRun(): void {
        this.preferTunaPyPIArtifactFiles = true;
    }

    private isExplicitNetworkFailure(error: unknown): boolean {
        const pending: unknown[] = [error];
        const seen = new Set<object>();
        let nativeFetchFailure = false;

        while (pending.length > 0) {
            const current = pending.shift();
            if (typeof current !== "object" || current === null) {
                const message = String(current ?? "");
                if (ExplicitNetworkFailurePattern.test(message)) {
                    return true;
                }
                continue;
            }
            if (seen.has(current)) continue;
            seen.add(current);

            const record = current as { code?: unknown; cause?: unknown; errors?: unknown };
            const code = String(record.code ?? "");
            if (ExplicitNetworkFailureCodes.has(code)) {
                return true;
            }

            const message = current instanceof Error ? current.message : String(current);
            if (ExplicitNetworkFailurePattern.test(message)) {
                return true;
            }
            if (current instanceof TypeError && /^fetch failed$/i.test(message) && record.cause != null) {
                nativeFetchFailure = true;
            }

            if (record.cause != null) pending.push(record.cause);
            if (Array.isArray(record.errors)) pending.push(...record.errors);
        }

        // Node only emits this TypeError after its native fetch request has failed.
        // This does not use an application timer or classify AbortError as a network failure.
        return nativeFetchFailure;
    }

    private async fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
        return await this.fetchBody(url, async response => {
            const body = await response.arrayBuffer();
            if (body.byteLength < 512 * 1024) {
                return JSON.parse(Buffer.from(body).toString("utf8")) as T;
            }
            return await parseJsonInBackground<T>(body, this.activeRuntimeOperationAbortController?.signal);
        }, headers);
    }

    private async fetchBuffer(url: string): Promise<Buffer> {
        return await this.fetchBody(url, async (response) => Buffer.from(await response.arrayBuffer()));
    }

    private async fetchBody<T>(
        url: string,
        readBody: (response: Response) => Promise<T>,
        headers?: Record<string, string>,
    ): Promise<T> {
        this.throwIfRuntimeOperationCancelled();
        const signal = this.activeRuntimeOperationAbortController?.signal;
        try {
            const response = await fetch(url, { cache: "no-store", headers, signal });
            this.throwIfRuntimeOperationCancelled();
            if (!response.ok) throw new Error(`Invalid response ${response.status} from ${url}`);
            const body = await readBody(response);
            this.throwIfRuntimeOperationCancelled();
            return body;
        } catch (error) {
            if (signal?.aborted || this.lastRuntimeOperationSkipped) {
                throw new ManagedRuntimeMutationCancelledError();
            }
            throw error;
        }
    }

    private throwIfRuntimeOperationCancelled(): void {
        if (this.lastRuntimeOperationSkipped || this.activeRuntimeOperationAbortController?.signal.aborted) {
            throw new ManagedRuntimeMutationCancelledError();
        }
    }
}
