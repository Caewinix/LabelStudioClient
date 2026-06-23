import fs from "node:fs";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { inflateRawSync } from "node:zlib";
import { app } from "electron";
import { AppPaths } from "./appPaths";
import { LaunchStage, launchStage, clamp01 } from "./launchModels";
import { UpdateService } from "./updateService";
import { LineAccumulator } from "./lineAccumulator";
import { ManagedDownloadTask, formatDownloadStatus, type DownloadProgress } from "./managedDownload";

export enum BootstrapMode {
  ensureAll = "ensure-all",
  updatePython = "update-python",
  ensurePackage = "ensure-package",
  updatePackage = "update-package",
  ensureElectron = "ensure-electron",
  updateElectron = "update-electron",
  updateAll = "update-all",
}

interface NpmElectronPackage {
  version?: string;
  dist?: { tarball?: string; fileCount?: number; unpackedSize?: number };
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

interface PackageDownloadInfo {
  version: string;
  requiresPython: string;
  url: string;
  filename: string;
  size?: number;
}

interface RuntimeArchiveInfo {
  url: string;
  filename: string;
  size?: number;
  fallbackUrls?: string[];
}

interface WheelhouseArtifact {
  name: string;
  version: string;
  url: string;
  filename: string;
  requested: boolean;
  size?: number;
}

interface PipInstallReportItem {
  metadata?: { name?: string; version?: string };
  requested?: boolean;
  is_direct?: boolean;
  download_info?: {
    url?: string;
    archive_info?: { hashes?: Record<string, string>; hash?: string };
  };
}

interface PipInstallReport {
  install?: PipInstallReportItem[];
}

interface MinicondaInstallerInfo extends RuntimeArchiveInfo {
  pythonSeries: string;
  installerVersion: string;
}

const AnacondaMinicondaBaseUrl = "https://repo.anaconda.com/miniconda/";
const TunaMinicondaBaseUrl = "https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/";
const CompletedDownloadStageHoldMs = 100;

const RuntimeBootstrapProgressSteps = [
  "prepareRuntime",
  "downloadPython",
  "expandRuntime",
  "installRuntime",
  "preparePackage",
  "bootstrapPip",
  "planInstallation",
  "downloadWheelhouse",
  "installPackage",
  "optimizeRuntime",
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

function electronStepStart(step: ElectronUpdateProgressStep): number {
  return progressStepStart(ElectronUpdateProgressSteps, step);
}

function electronStepEnd(step: ElectronUpdateProgressStep): number {
  return progressStepEnd(ElectronUpdateProgressSteps, step);
}

type RuntimeInstallResult = "completed" | "skipped";

export class RuntimeBootstrapService extends EventEmitter {
  private currentProcess?: ChildProcessWithoutNullStreams;
  private activeDownloadTask?: ManagedDownloadTask;
  private downloadPauseRequested = false;
  private recentOutput: string[] = [];
  private stdoutAccumulator = new LineAccumulator();
  private stderrAccumulator = new LineAccumulator();
  private activeProgressRange: [number, number] = [0, 1];
  private lastProcessEmissionByKey = new Map<string, number>();
  private lastRuntimeValidationError = "";
  private electronRuntimeReplacementPending = false;
  private minicondaInstallersPromise?: Promise<MinicondaInstallerInfo[]>;
  private stageHoldTimer?: NodeJS.Timeout;
  private heldStage?: LaunchStage;
  private downloadCompletionHoldUntil = 0;
  private stageSequence = 0;
  transientStageUpdate?: (stage: LaunchStage) => void;
  private readonly updateService = new UpdateService();

  async ensureRuntime(
    mode: BootstrapMode = BootstrapMode.ensureAll,
    progressRange: [number, number] = [0, 1],
  ): Promise<void> {
    this.activeProgressRange = progressRange;
    this.recentOutput = [];
    this.stdoutAccumulator = new LineAccumulator();
    this.stderrAccumulator = new LineAccumulator();
    this.lastProcessEmissionByKey.clear();
    this.electronRuntimeReplacementPending = false;
    this.stageSequence += 1;
    this.clearHeldStage();

    AppPaths.downloadCacheDirectory();
    const pythonCacheDirectory = AppPaths.pythonDownloadCacheDirectory();
    const electronCacheDirectory = AppPaths.electronDownloadCacheDirectory();
    const packageCacheDirectory = AppPaths.packageDownloadCacheDirectory();
    const runtimeRoot = AppPaths.bundledRuntimeRoot();
    fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });

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
          await this.updateElectronDependency();
          break;
        case BootstrapMode.ensureAll:
        case BootstrapMode.ensurePackage:
          await this.ensurePackageRuntime(pythonCacheDirectory, runtimeRoot);
          await this.ensureElectronRuntime(false, runtimeStepStart("checkElectron"), runtimeStepEnd("checkElectron"));
          break;
        case BootstrapMode.updatePackage:
          await this.updatePackage(pythonCacheDirectory, runtimeRoot);
          break;
        case BootstrapMode.updatePython:
          await this.updatePython(pythonCacheDirectory, runtimeRoot);
          break;
        case BootstrapMode.updateAll:
          await this.updateAll(pythonCacheDirectory, runtimeRoot);
          await this.ensureElectronRuntime(true, runtimeStepStart("checkElectron"), runtimeStepEnd("checkElectron"));
          break;
      }

      this.updateService.invalidateVersionCache();

      if (AppPaths.shouldReclaimRuntimeCache()) {
        await this.emitBootstrapStage(
          "Reclaiming Cache",
          "Removing downloaded cache files.",
          runtimeStepStart("cache"),
          false,
          undefined,
          undefined,
        );
        this.reclaimDownloadCache(pythonCacheDirectory);
        if (!this.electronRuntimeReplacementPending) {
          this.reclaimDownloadCache(electronCacheDirectory);
        }
        this.reclaimDownloadCache(packageCacheDirectory);
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
    } finally {
      this.clearHeldStage();
      this.transientStageUpdate = undefined;
      this.activeProgressRange = [0, 1];
      this.currentProcess = undefined;
      this.activeDownloadTask = undefined;
    }
  }

  async fetchVersions(): Promise<import("./updateService").RuntimeVersions> {
    return await this.updateService.fetchVersions();
  }

  versionSnapshot(): import("./updateService").RuntimeVersions {
    return this.updateService.versionSnapshot();
  }

  primeVersionCache(): void {
    this.updateService.primeVersionCache();
  }

  invalidateVersionCache(): void {
    this.updateService.invalidateVersionCache();
  }

  hasPendingElectronRuntimeReplacement(): boolean {
    return this.electronRuntimeReplacementPending;
  }

  async refreshVersionCache(): Promise<import("./updateService").RuntimeVersions> {
    return await this.updateService.refreshVersionCache();
  }

  appVersionString(): string {
    return this.updateService.appVersionString();
  }

  async checkElectron(): Promise<import("./updateService").ElectronCheckResult> {
    return await this.updateService.checkElectron();
  }

  async checkPackage(): Promise<import("./updateService").PackageCheckResult> {
    return await this.updateService.checkPackage();
  }

  async checkPython(): Promise<import("./updateService").PythonCheckResult> {
    return await this.updateService.checkPython();
  }

  hasUsableElectronRuntime(): boolean {
    return Boolean(process.versions.electron);
  }

  toggleCurrentDownloadPause(): boolean {
    return this.setCurrentDownloadPaused(!this.downloadPauseRequested);
  }

  setCurrentDownloadPaused(paused: boolean): boolean {
    this.downloadPauseRequested = paused;
    if (paused) {
      this.activeDownloadTask?.pause();
      return true;
    }
    this.activeDownloadTask?.resumeIfPaused();
    return false;
  }

  pauseCurrentDownload(): boolean {
    return this.setCurrentDownloadPaused(true);
  }

  resumeCurrentDownload(): void {
    this.setCurrentDownloadPaused(false);
  }

  cancelCurrentDownloadAndSkip(): void {
    // Swift parity: cancelForSkip belongs to the active download delegate only.
    // It must not mark the whole bootstrap session as globally cancelled,
    // otherwise later subprocess exits can be incorrectly treated as success.
    this.downloadPauseRequested = false;
    this.activeDownloadTask?.cancelForSkip();
  }

  stop(): void {
    this.downloadPauseRequested = false;
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

  private async ensurePackageRuntime(pythonCacheDirectory: string, runtimeRoot: string): Promise<void> {
    const pkg = await this.latestPackageDownload();
    const runtimeValid = await this.validateRuntime(runtimeRoot);

    if (!runtimeValid) {
      const targetPython = await this.packageTargetPythonVersion(pkg.requiresPython);
      await this.installRuntimeReplacingExisting(targetPython, pythonCacheDirectory, runtimeRoot);
    } else if (!(await this.embeddedPythonSatisfies(pkg.requiresPython, runtimeRoot))) {
      const targetPython = await this.packageTargetPythonVersion(pkg.requiresPython);
      await this.installRuntimeReplacingExisting(targetPython, pythonCacheDirectory, runtimeRoot);
    }

    if (!(await this.packageInstalled(runtimeRoot))) {
      await this.installPackageWithManagedDownload(pkg, runtimeRoot, false);
    }
  }

  private async updatePackage(pythonCacheDirectory: string, runtimeRoot: string): Promise<void> {
    const pkg = await this.latestPackageDownload();
    const runtimeValid = await this.validateRuntime(runtimeRoot);
    const pythonSatisfiesPackage = runtimeValid
      ? await this.embeddedPythonSatisfies(pkg.requiresPython, runtimeRoot)
      : false;

    if (!runtimeValid || !pythonSatisfiesPackage) {
      const targetPython = await this.packageTargetPythonVersion(pkg.requiresPython);
      await this.installRuntimeReplacingExisting(targetPython, pythonCacheDirectory, runtimeRoot);
    }

    await this.installPackageWithManagedDownload(pkg, runtimeRoot, true);
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
  ): Promise<RuntimeInstallResult> {
    const runtimeParent = path.dirname(runtimeRoot);
    const stagingRoot = path.join(runtimeParent, `${path.basename(runtimeRoot)}.installing-${randomUUID()}`);
    const backupRoot = path.join(runtimeParent, `${path.basename(runtimeRoot)}.backup-${randomUUID()}`);
    const hadRuntime = fs.existsSync(runtimeRoot);

    try {
      const didInstallRuntime = await this.installRuntime(pythonVersion, pythonCacheDirectory, stagingRoot);
      if (didInstallRuntime === "skipped") {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        return "skipped";
      }
      await this.installPackageWithManagedDownload(pkg, stagingRoot, true);
      this.replaceRuntime(stagingRoot, runtimeRoot, backupRoot, hadRuntime);
      fs.rmSync(backupRoot, { recursive: true, force: true });
      return "completed";
    } catch (error) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      if (fs.existsSync(backupRoot)) {
        this.restoreRuntimeBackup(backupRoot, runtimeRoot, hadRuntime);
      }
      throw error;
    }
  }

  private async installRuntimeReplacingExisting(
    version: string,
    cacheDirectory: string,
    runtimeRoot: string,
  ): Promise<RuntimeInstallResult> {
    const runtimeParent = path.dirname(runtimeRoot);
    const stagingRoot = path.join(runtimeParent, `${path.basename(runtimeRoot)}.installing-${randomUUID()}`);
    const backupRoot = path.join(runtimeParent, `${path.basename(runtimeRoot)}.backup-${randomUUID()}`);
    const hadRuntime = fs.existsSync(runtimeRoot);

    try {
      const didInstallRuntime = await this.installRuntime(version, cacheDirectory, stagingRoot);
      if (didInstallRuntime === "skipped") {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        return "skipped";
      }
      this.replaceRuntime(stagingRoot, runtimeRoot, backupRoot, hadRuntime);
      fs.rmSync(backupRoot, { recursive: true, force: true });
      return "completed";
    } catch (error) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      if (fs.existsSync(backupRoot)) {
        this.restoreRuntimeBackup(backupRoot, runtimeRoot, hadRuntime);
      }
      throw error;
    }
  }

  private replaceRuntime(stagedRuntime: string, runtimeRoot: string, backupRoot: string, hadRuntime: boolean): void {
    if (!hadRuntime) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      fs.renameSync(stagedRuntime, runtimeRoot);
      return;
    }

    fs.rmSync(backupRoot, { recursive: true, force: true });
    fs.renameSync(runtimeRoot, backupRoot);
    try {
      fs.renameSync(stagedRuntime, runtimeRoot);
    } catch (error) {
      if (!fs.existsSync(runtimeRoot) && fs.existsSync(backupRoot)) {
        fs.renameSync(backupRoot, runtimeRoot);
      }
      throw error;
    }
  }

  private restoreRuntimeBackup(backupRoot: string, runtimeRoot: string, hadRuntime: boolean): void {
    if (!hadRuntime) return;
    if (!fs.existsSync(runtimeRoot) && fs.existsSync(backupRoot)) {
      fs.renameSync(backupRoot, runtimeRoot);
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
    fs.rmSync(expandedDirectory, { recursive: true, force: true });
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

    await this.emitBootstrapStage(
      "Installing Runtime",
      "Installing the managed Python runtime for Label Studio.",
      runtimeStepStart("installRuntime"),
      false,
      undefined,
      undefined,
    );
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    const frameworkVersions = path.join(runtimeRoot, "Library", "Frameworks", "Python.framework", "Versions");
    fs.mkdirSync(frameworkVersions, { recursive: true });
    fs.cpSync(payloadVersion, path.join(frameworkVersions, series), { recursive: true, verbatimSymlinks: true });

    const runtimePythonSource = path.join(frameworkVersions, series, "Resources", "Python.app", "Contents", "MacOS", "Python");
    const runtimePythonTarget = path.join(runtimeRoot, "bin", "Python");
    fs.mkdirSync(path.dirname(runtimePythonTarget), { recursive: true });
    fs.rmSync(runtimePythonTarget, { force: true });
    fs.copyFileSync(runtimePythonSource, runtimePythonTarget);
    fs.chmodSync(runtimePythonTarget, 0o755);

    fs.rmSync(path.join(frameworkVersions, series, "Resources", "Python.app"), { recursive: true, force: true });

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
    const installer = await this.minicondaInstaller(version);
    const installerPath = path.join(cacheDirectory, installer.filename);

    await this.emitBootstrapStage(
      "Downloading Python",
      `Downloading the embedded Python ${version} runtime package.`,
      fs.existsSync(installerPath) ? runtimeStepEnd("downloadPython") : runtimeStepStart("downloadPython"),
      true,
      fs.existsSync(installerPath) ? 1 : 0,
      fs.existsSync(installerPath) ? "Download complete" : "Preparing download",
    );

    if (!fs.existsSync(installerPath)) {
      const result = await this.downloadFileWithFallback(
        [installer.url, ...(installer.fallbackUrls ?? [])],
        installerPath,
        installer.size,
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
      "Installing the Anaconda Python runtime package.",
      runtimeStepStart("expandRuntime"),
      false,
      undefined,
      undefined,
    );
    await this.emitBootstrapStage(
      "Runtime Expanded",
      "The Anaconda runtime installer is ready.",
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
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });
    await this.runMinicondaInstaller(installerPath, runtimeRoot);
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

  private async runMinicondaInstaller(installerPath: string, runtimeRoot: string): Promise<void> {
    if (process.platform === "win32") {
      await this.runLocalProcess(
        installerPath,
        [
          "/S",
          "/InstallationType=JustMe",
          "/RegisterPython=0",
          "/AddToPath=0",
          `/D=${runtimeRoot}`,
        ],
        AppPaths.projectRoot(),
      );
      return;
    }

    try { fs.chmodSync(installerPath, 0o755); } catch { /* ignore */ }
    await this.runLocalProcess(
      "bash",
      [installerPath, "-b", "-f", "-p", runtimeRoot],
      AppPaths.projectRoot(),
    );
  }

  private prepareAnacondaRuntimeFiles(runtimeRoot: string): void {
    const runtimePython = this.runtimePython(runtimeRoot);
    if (!fs.existsSync(runtimePython)) {
      throw new Error(`Missing Anaconda Python executable after install: ${runtimePython}`);
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

    for (const file of this.runtimeMachOCandidates(runtimeRoot, series)) {
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

  private runtimeMachOCandidates(runtimeRoot: string, series: string): string[] {
    const candidates = new Set<string>();
    const frameworkVersionRoot = path.join(runtimeRoot, "Library", "Frameworks", "Python.framework", "Versions", series);
    const add = (file: string) => {
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) candidates.add(file);
      } catch { /* ignore */ }
    };
    const walk = (directory: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const child = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(child);
          continue;
        }
        if (!entry.isFile()) continue;
        if (this.isRuntimeMachOCandidate(child)) add(child);
      }
    };

    add(this.runtimePython(runtimeRoot));
    add(path.join(frameworkVersionRoot, "Python"));
    walk(path.join(frameworkVersionRoot, "bin"));
    walk(path.join(frameworkVersionRoot, "lib"));
    return [...candidates].sort();
  }

  private isRuntimeMachOCandidate(file: string): boolean {
    const basename = path.basename(file);
    const ext = path.extname(file);
    if (ext === ".so" || ext === ".dylib") return true;
    if (basename === "Python") return true;
    if (/^python\d+(?:\.\d+)?$/.test(basename)) return true;

    try {
      const stat = fs.statSync(file);
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
    return await this.validateRuntime(runtimeRoot);
  }

  private async embeddedPythonSatisfies(requiresPython: string, runtimeRoot: string): Promise<boolean> {
    const version = await this.currentPythonVersion(runtimeRoot).catch(() => "");
    return this.pythonVersionSatisfies(version, requiresPython);
  }

  private async packageInstalled(runtimeRoot: string): Promise<boolean> {
    const version = await this.currentPackageVersion(runtimeRoot).catch(() => "Not installed");
    return Boolean(version && version !== "Not installed");
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
  ): Promise<void> {
    const wheelhouseDirectory = AppPaths.packageWheelhouseCacheDirectory();
    const planDirectory = AppPaths.packagePlanCacheDirectory();
    fs.mkdirSync(wheelhouseDirectory, { recursive: true });
    fs.mkdirSync(planDirectory, { recursive: true });

    await this.emitBootstrapStage(
      "Preparing Package",
      "Checking whether label-studio is already installed in the managed runtime.",
      runtimeStepStart("preparePackage"),
      false,
      undefined,
      undefined,
    );

    await this.emitBootstrapStage(
      "Bootstrapping pip",
      "Preparing pip inside the managed Python runtime.",
      runtimeStepStart("bootstrapPip"),
      false,
      undefined,
      undefined,
    );
    await this.ensureRuntimePip(runtimeRoot);

    await this.emitBootstrapStage(
      "Pip Ready",
      "The embedded Python package installer is ready.",
      runtimeStepEnd("bootstrapPip"),
      false,
      undefined,
      undefined,
    );

    const artifacts = await this.resolveWheelhouseArtifacts(pkg.version, upgrade, runtimeRoot, planDirectory);
    const result = await this.downloadWheelhouseArtifacts(artifacts, wheelhouseDirectory, runtimeRoot);
    if (result === "skipped") return;

    await this.installPackageFromWheelhouse(artifacts, wheelhouseDirectory, runtimeRoot, upgrade);

    await this.emitBootstrapStage(
      "Optimizing Runtime",
      "Collecting static assets for the embedded Label Studio runtime.",
      runtimeStepStart("optimizeRuntime"),
      false,
      undefined,
      undefined,
    );
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

    await this.emitBootstrapStage(
      "Runtime Optimized",
      "Embedded static assets are ready.",
      runtimeStepEnd("optimizeRuntime"),
      false,
      undefined,
      undefined,
    );
  }

  private async ensureRuntimePip(runtimeRoot: string): Promise<void> {
    const cwd = this.runtimePythonDir(runtimeRoot);
    const env = AppPaths.makePythonEnvironmentForRuntime(runtimeRoot);
    try {
      await this.runRuntimePythonProcess(["-m", "pip", "--version"], cwd, env, true);
      return;
    } catch { /* install pip below */ }

    await this.runRuntimePythonProcess(
      ["-m", "ensurepip", "--upgrade"],
      cwd,
      env,
      false,
      runtimeStepStart("bootstrapPip"),
      runtimeStepEnd("bootstrapPip"),
      "Bootstrapping pip",
    );
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
    const project = await this.fetchJson<PyPIProject>("https://pypi.org/pypi/label-studio/json");
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

  private async resolveWheelhouseArtifacts(
    version: string,
    upgrade: boolean,
    runtimeRoot: string,
    planDirectory: string,
  ): Promise<WheelhouseArtifact[]> {
    const pythonVersion = await this.currentPythonVersion(runtimeRoot);
    await this.emitBootstrapStage(
      "Planning Installation",
      `Preparing the pip installation plan for Python ${this.pythonSeries(pythonVersion)}.`,
      runtimeStepStart("planInstallation"),
      false,
      undefined,
      undefined,
    );

    const reportPath = path.join(
      planDirectory,
      `pip-plan-label-studio-${version.replace(/[^A-Za-z0-9._-]/g, "_")}-python-${pythonVersion.replace(/[^A-Za-z0-9._-]/g, "_")}-${process.arch}.json`,
    );

    let report: PipInstallReport | undefined;
    if (fs.existsSync(reportPath)) {
      try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as PipInstallReport; } catch { report = undefined; }
    }

    if (report?.install?.length) {
      await this.emitBootstrapStage(
        "Planning Installation",
        "Using the cached pip installation plan.",
        runtimeStepEnd("planInstallation"),
        false,
        undefined,
        undefined,
      );
    } else {
      await this.emitBootstrapStage(
        "Planning Installation",
        "Asking pip to calculate the exact package plan.",
        runtimeStepStart("planInstallation"),
        false,
        undefined,
        undefined,
      );
      fs.rmSync(reportPath, { force: true });
      const spec = version && version !== "Unknown" ? `label-studio==${version}` : "label-studio";
      const args = [
        "-m", "pip", "install",
        "--dry-run", "--ignore-installed", "--report", reportPath,
        "--disable-pip-version-check", "--no-input", "--retries", "5", "--progress-bar", "off",
      ];
      // Swift does not add --upgrade while creating the dry-run plan; the plan
      // command is stable for both initial install and update paths. The actual
      // offline install below always includes --upgrade.
      void upgrade;
      args.push(spec);
      await this.runRuntimePythonProcess(
        args,
        this.runtimePythonDir(runtimeRoot),
        AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
        false,
        runtimeStepStart("planInstallation"),
        runtimeStepEnd("planInstallation"),
        "Planning Installation",
      );
      report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as PipInstallReport;
    }

    const entriesByURL = new Map<string, WheelhouseArtifact>();
    for (const item of report.install ?? []) {
      const rawURL = item.download_info?.url;
      if (!rawURL) {
        throw new Error("pip reported a package entry without a download URL.");
      }
      let parsed: URL;
      try {
        parsed = new URL(rawURL);
      } catch {
        throw new Error(`pip reported an invalid package URL: ${rawURL}`);
      }
      if (!/^https?:$/i.test(parsed.protocol) && parsed.protocol !== "file:") {
        throw new Error(`pip reported an unsupported package URL: ${rawURL}`);
      }
      const filename = this.filenameFromUrl(rawURL);
      if (!filename) {
        throw new Error(`Unable to determine package filename from ${rawURL}`);
      }
      entriesByURL.set(rawURL, {
        name: this.normalizePackageName(item.metadata?.name ?? filename),
        version: item.metadata?.version ?? "unknown",
        url: rawURL,
        filename,
        requested: Boolean(item.requested),
      });
    }

    return [...entriesByURL.values()].sort((left, right) => {
      if (left.requested !== right.requested) return left.requested ? 1 : -1;
      return left.name.localeCompare(right.name);
    });
  }

  private async downloadWheelhouseArtifacts(
    artifacts: WheelhouseArtifact[],
    wheelhouseDirectory: string,
    runtimeRoot: string,
  ): Promise<"completed" | "skipped"> {
    const missing = artifacts
      .map((artifact, index) => ({ artifact, index }))
      .filter(({ artifact }) => !fs.existsSync(path.join(wheelhouseDirectory, artifact.filename)));

    if (artifacts.length === 0) {
      await this.emitBootstrapStage(
        "Wheelhouse Ready",
        "No package files are required.",
        runtimeStepEnd("downloadWheelhouse"),
        false,
        undefined,
        undefined,
      );
      return "completed";
    }

    if (missing.length === 0) {
      await this.emitBootstrapStage(
        "Wheelhouse Ready",
        "All package files are already cached locally.",
        runtimeStepEnd("downloadWheelhouse"),
        false,
        undefined,
        undefined,
      );
      return "completed";
    }

    // Keep the secondary download lane visible for the whole wheelhouse
    // transfer phase.  Do not emit a non-download stage here: the splash
    // renderer hides the wheelhouse progress bar whenever
    // showsDownloadProgress is false.
    await this.emitBootstrapStage(
      "Downloading Wheelhouse",
      "Checking cached package files before downloading missing files.",
      runtimeStepStart("downloadWheelhouse"),
      true,
      0,
      "Preparing download",
      0,
    );

    const wheelhouseCount = Math.max(missing.length, 1);
    for (const { artifact, index } of missing) {
      const destination = path.join(wheelhouseDirectory, artifact.filename);
      const itemFractionStart = index / wheelhouseCount;
      const itemFractionEnd = (index + 1) / wheelhouseCount;
      const itemStart = runtimeStepProgress("downloadWheelhouse", itemFractionStart);
      const itemEnd = runtimeStepProgress("downloadWheelhouse", itemFractionEnd);

      // Show the wheelhouse download bar before the first network progress
      // callback.  The bar must not disappear just because the request is
      // waiting for a connection or checking Range/Content-Length.
      await this.emitBootstrapStage(
        "Downloading Wheelhouse",
        `Downloading ${artifact.name} ${artifact.version}.`,
        itemStart,
        true,
        0,
        artifact.size && artifact.size > 0
          ? `0 MB  /  ${this.formatByteCountForStatus(artifact.size)}`
          : "0 MB  /  Unknown",
        itemFractionStart,
      );

      const result = await this.downloadFile(
        artifact.url,
        destination,
        artifact.size,
        "Downloading Wheelhouse",
        `Downloading ${artifact.name} ${artifact.version}.`,
        itemStart,
        itemEnd,
        progress => itemFractionStart + (itemFractionEnd - itemFractionStart) * clamp01(progress.fraction),
      );
      if (result === "skipped") {
        if (await this.hasInstalledPackage(runtimeRoot)) return "skipped";
        throw new Error("Dependency download was cancelled before the embedded package was available.");
      }
    }

    await this.emitBootstrapStage(
      "Wheelhouse Ready",
      "All package files are available locally.",
      runtimeStepEnd("downloadWheelhouse"),
      false,
      undefined,
      undefined,
    );
    return "completed";
  }

  private formatByteCountForStatus(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
    const megabytes = bytes / 1_048_576;
    if (megabytes >= 10) return `${megabytes.toFixed(0)} MB`;
    return `${megabytes.toFixed(1)} MB`;
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
    const installPaths = installEntries.map((entry) => path.join(wheelhouseDirectory, entry.filename));
    const requested = installEntries.find((v) => v.requested);

    await this.emitBootstrapStage(
      "Installing Label Studio",
      `Installing label-studio${requested?.version ? ` ${requested.version}` : ""} with pip.`,
      runtimeStepStart("installPackage"),
      false,
      undefined,
      undefined,
    );

    const args = [
      "-m", "pip", "install", "--upgrade",
      "--disable-pip-version-check", "--no-input", "--retries", "5", "--progress-bar", "off",
      "--no-index", "--find-links", wheelhouseDirectory, "--no-deps",
    ];
    if (!upgrade) { /* Swift still uses a stable install command with upgrade semantics. */ }
    args.push(...installPaths);
    await this.runRuntimePythonProcess(
      args,
      this.runtimePythonDir(runtimeRoot),
      AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
      false,
      runtimeStepStart("installPackage"),
      runtimeStepEnd("installPackage"),
      "Installing Label Studio",
    );

    await this.emitBootstrapStage(
      "Label Studio Installed",
      "Label Studio package files are installed in the embedded runtime.",
      runtimeStepEnd("installPackage"),
      false,
      undefined,
      undefined,
    );
  }

  private async packageTargetPythonVersion(requiresPython: string): Promise<string> {
    const minimumSeries = this.minimumPythonSeries(requiresPython);
    if (minimumSeries) {
      const version = await this.latestInstallerVersionForSeries(minimumSeries);
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

  private async latestInstallerVersionForSeries(series: string): Promise<string | undefined> {
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
      const installers = await this.availableMinicondaInstallers();
      const versions = installers.map((installer) => installer.pythonSeries);
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

    return await this.minicondaInstaller(version);
  }

  private async minicondaInstaller(version: string): Promise<MinicondaInstallerInfo> {
    const requestedSeries = this.pythonSeries(version);
    const installers = await this.availableMinicondaInstallers();
    const candidates = installers
      .filter((installer) => installer.pythonSeries === requestedSeries)
      .sort((left, right) => this.compareVersionNumbers(right.installerVersion, left.installerVersion));
    const chosen = candidates[0];
    if (!chosen) {
      throw new Error(`Unable to find an Anaconda Python ${requestedSeries} installer for ${process.platform}-${process.arch}.`);
    }
    return chosen;
  }

  private async availableMinicondaInstallers(): Promise<MinicondaInstallerInfo[]> {
    this.minicondaInstallersPromise ??= this.fetchMinicondaInstallers();
    return await this.minicondaInstallersPromise;
  }

  private async fetchMinicondaInstallers(): Promise<MinicondaInstallerInfo[]> {
    const suffix = this.minicondaInstallerPlatformSuffix();
    const html = await this.fetchTextWithFallback([
      `${AnacondaMinicondaBaseUrl}`,
      `${TunaMinicondaBaseUrl}`,
    ]);
    const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`href="(Miniconda3-py(\\d+)_([^"]+)-${escapedSuffix})"`, "g");
    const installers = [...html.matchAll(pattern)]
      .map((match) => {
        const filename = this.decodeHtmlAttribute(match[1] ?? "");
        const pythonSeries = this.minicondaPythonSeries(match[2] ?? "");
        const installerVersion = match[3] ?? "0";
        return {
          filename,
          pythonSeries,
          installerVersion,
          url: new URL(filename, AnacondaMinicondaBaseUrl).toString(),
          fallbackUrls: [new URL(filename, TunaMinicondaBaseUrl).toString()],
        };
      })
      .filter((installer) => installer.filename && installer.pythonSeries);
    return installers;
  }

  private minicondaInstallerPlatformSuffix(): string {
    if (process.platform === "win32") {
      if (process.arch === "x64") return "Windows-x86_64.exe";
      if (process.arch === "arm64") return "Windows-aarch64.exe";
    }

    if (process.platform === "linux") {
      if (process.arch === "x64") return "Linux-x86_64.sh";
      if (process.arch === "arm64") return "Linux-aarch64.sh";
      if (process.arch === "ppc64") return "Linux-ppc64le.sh";
      if (process.arch === "s390x") return "Linux-s390x.sh";
    }

    throw new Error(`Unsupported Anaconda Python runtime platform: ${process.platform}-${process.arch}.`);
  }

  private minicondaPythonSeries(text: string): string {
    if (text.length < 2 || !/^\d+$/.test(text)) return "";
    return `${text[0]}.${text.slice(1)}`;
  }

  private decodeHtmlAttribute(value: string): string {
    return value
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x2F;/gi, "/");
  }

  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Invalid response ${response.status} from ${url}`);
    return await response.text();
  }

  private async fetchTextWithFallback(urls: string[]): Promise<string> {
    let lastError: unknown;
    for (const url of urls) {
      try {
        return await this.fetchText(url);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
    try {
      const output = await this.runRuntimePythonProcess(
        ["-m", "pip", "show", "label-studio"],
        this.runtimePythonDir(runtimeRoot),
        AppPaths.makePythonEnvironmentForRuntime(runtimeRoot),
        true,
      );
      return output.split(/\r?\n/).some((line) => line.startsWith("Version:"));
    } catch {
      return false;
    }
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
    this.removeTreeIfExists(stagingRoot);
    fs.mkdirSync(stagingRoot, { recursive: true });

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

      try {
        this.appendElectronUpdateLog(`Attempting live macOS Electron runtime replacement. source=${sourceApp} target=${targetApp}`);
        this.replaceMacElectronRuntime(sourceApp, targetApp);
        const codesignOutput = await this.runLocalProcess("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", targetApp], AppPaths.projectRoot(), true);
        if (codesignOutput.trim().length > 0) this.appendElectronUpdateLog(`Live macOS Electron runtime ad-hoc signing output: ${codesignOutput.trim()}`);
        this.appendElectronUpdateLog("Live macOS Electron runtime replacement applied.");
        await this.emitBootstrapStage("Electron Updated", "Electron runtime files were replaced. Restart Label Studio to use the new runtime.", electronStepEnd("installElectron"), false, undefined, undefined);
      } catch (error) {
        this.appendElectronUpdateLog(`Live macOS Electron runtime replacement failed; scheduling replacement for quit. ${error instanceof Error ? error.message : String(error)}`);
        await this.emitBootstrapStage("Installing Electron", "Runtime is still in use. Scheduling replacement for app quit.", electronStepStart("installElectron"), false, undefined, undefined);
        this.scheduleMacElectronReplacement(stagingRoot, sourceApp, targetApp);
        replacementScheduled = true;
        await this.emitBootstrapStage("Electron Update Ready", "Quit Label Studio to install the downloaded Electron runtime.", electronStepEnd("installElectron"), false, undefined, undefined);
      }
    } finally {
      if (!replacementScheduled) this.tryRemoveTree(stagingRoot, "Electron staging cleanup");
    }
  }

  private macElectronDownloadURLs(version: string): string[] {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const targets = [`darwin-${arch}`];
    if (!targets.includes("darwin-universal")) targets.unshift("darwin-universal");
    return targets.map((target) => `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${target}.zip`);
  }

  private async updatePackagedPortableElectron(version: string): Promise<void> {
    if (process.platform === "linux" && process.env.APPIMAGE) {
      throw new Error("Linux AppImage packages are read-only at runtime. Use the Linux directory/tar package for in-place Electron runtime updates.");
    }

    const normalizedVersion = version.replace(/^v/i, "");
    const targets = this.portableElectronDownloadTargets();
    const archivePath = path.join(AppPaths.electronDownloadCacheDirectory(), `electron-v${normalizedVersion}-${targets[0]}.zip`);
    const urls = targets.map((target) => `https://github.com/electron/electron/releases/download/v${normalizedVersion}/electron-v${normalizedVersion}-${target}.zip`);

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
    this.removeTreeIfExists(stagingRoot);
    fs.mkdirSync(stagingRoot, { recursive: true });

    try {
      await this.emitBootstrapStage(
        "Expanding Electron",
        "Expanding the downloaded Electron runtime.",
        electronStepStart("expandElectron"),
        false,
        undefined,
        undefined,
      );
      this.extractZipArchive(archivePath, stagingRoot);

      const sourceRoot = this.findExtractedPortableElectronRoot(stagingRoot);
      const targetRoot = AppPaths.projectRoot();
      this.assertPackagedPortableElectronTarget(sourceRoot, targetRoot);

      await this.emitBootstrapStage(
        "Installing Electron",
        "Scheduling the Electron runtime replacement for app quit.",
        electronStepStart("installElectron"),
        false,
        undefined,
        undefined,
      );
      this.schedulePortableElectronReplacement(stagingRoot, sourceRoot, targetRoot);

      await this.emitBootstrapStage("Electron Update Ready", "Quit Label Studio to install the downloaded Electron runtime.", electronStepEnd("installElectron"), false, undefined, undefined);
    } catch (error) {
      this.tryRemoveTree(stagingRoot, "Electron staging cleanup");
      throw error;
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
    this.assertWritableDirectory(targetRoot);
  }

  private assertWritableDirectory(directory: string): void {
    const probe = path.join(directory, `.electron-update-write-test-${randomUUID()}`);
    try {
      fs.writeFileSync(probe, "");
      fs.rmSync(probe, { force: true });
    } catch (error) {
      throw new Error(`The app install directory is not writable: ${directory}\n\n${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scheduleMacElectronReplacement(stagingRoot: string, sourceApp: string, targetApp: string): void {
    const scriptPath = path.join(AppPaths.electronDownloadCacheDirectory(), `apply-electron-${randomUUID()}.sh`);
    fs.writeFileSync(scriptPath, this.macElectronReplacementScript(stagingRoot, sourceApp, targetApp, scriptPath), "utf8");
    fs.chmodSync(scriptPath, 0o755);
    this.assertShellScriptSyntax(scriptPath, "macOS Electron replacement");
    this.writeElectronUpdatePendingMarker("macos", sourceApp, targetApp, scriptPath);
    this.appendElectronUpdateLog(`Scheduled macOS Electron runtime update. helper=${scriptPath} source=${sourceApp} target=${targetApp} waitPid=${process.pid}`);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", [scriptPath], {
        detached: true,
        stdio: "ignore",
      });
    } catch (error) {
      this.clearElectronUpdateMarkers();
      throw error;
    }
    if (!child.pid) {
      this.clearElectronUpdateMarkers();
      throw new Error("Failed to start the macOS Electron replacement helper.");
    }
    this.electronRuntimeReplacementPending = true;
    this.appendElectronUpdateLog(`Started macOS Electron runtime update helper. helperPid=${child.pid}`);
    child.on("error", (error) => {
      this.clearElectronUpdateMarkers();
      this.appendElectronUpdateLog(`macOS Electron runtime update helper failed to start: ${error.message}`);
    });
    child.unref();
  }

  private schedulePortableElectronReplacement(stagingRoot: string, sourceRoot: string, targetRoot: string): void {
    if (process.platform === "win32") {
      const scriptPath = path.join(AppPaths.electronDownloadCacheDirectory(), `apply-electron-${randomUUID()}.ps1`);
      fs.writeFileSync(scriptPath, this.windowsElectronReplacementScript(stagingRoot, sourceRoot, targetRoot, scriptPath), "utf8");
      this.writeElectronUpdatePendingMarker("windows", sourceRoot, targetRoot, scriptPath);
      this.appendElectronUpdateLog(`Scheduled Windows Electron runtime update. helper=${scriptPath} source=${sourceRoot} target=${targetRoot} waitPid=${process.pid}`);
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
      } catch (error) {
        this.clearElectronUpdateMarkers();
        throw error;
      }
      if (!child.pid) {
        this.clearElectronUpdateMarkers();
        throw new Error("Failed to start the Windows Electron replacement helper.");
      }
      this.electronRuntimeReplacementPending = true;
      this.appendElectronUpdateLog(`Started Windows Electron runtime update helper. helperPid=${child.pid}`);
      child.on("error", (error) => {
        this.clearElectronUpdateMarkers();
        this.appendElectronUpdateLog(`Windows Electron runtime update helper failed to start: ${error.message}`);
      });
      child.unref();
      return;
    }

    if (process.platform === "linux") {
      const scriptPath = path.join(AppPaths.electronDownloadCacheDirectory(), `apply-electron-${randomUUID()}.sh`);
      fs.writeFileSync(scriptPath, this.linuxElectronReplacementScript(stagingRoot, sourceRoot, targetRoot, scriptPath), "utf8");
      fs.chmodSync(scriptPath, 0o755);
      this.assertShellScriptSyntax(scriptPath, "Linux Electron replacement");
      this.writeElectronUpdatePendingMarker("linux", sourceRoot, targetRoot, scriptPath);
      this.appendElectronUpdateLog(`Scheduled Linux Electron runtime update. helper=${scriptPath} source=${sourceRoot} target=${targetRoot} waitPid=${process.pid}`);
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("/bin/sh", [scriptPath], {
          detached: true,
          stdio: "ignore",
        });
      } catch (error) {
        this.clearElectronUpdateMarkers();
        throw error;
      }
      if (!child.pid) {
        this.clearElectronUpdateMarkers();
        throw new Error("Failed to start the Linux Electron replacement helper.");
      }
      this.electronRuntimeReplacementPending = true;
      this.appendElectronUpdateLog(`Started Linux Electron runtime update helper. helperPid=${child.pid}`);
      child.on("error", (error) => {
        this.clearElectronUpdateMarkers();
        this.appendElectronUpdateLog(`Linux Electron runtime update helper failed to start: ${error.message}`);
      });
      child.unref();
      return;
    }

    throw new Error(`Unsupported packaged Electron replacement platform: ${process.platform}-${process.arch}.`);
  }

  private macElectronReplacementScript(stagingRoot: string, sourceApp: string, targetApp: string, scriptPath: string): string {
    const sourceExecutable = path.join(sourceApp, "Contents", "MacOS", "Electron");
    const targetExecutable = app.getPath("exe");
    const sourceFrameworks = path.join(sourceApp, "Contents", "Frameworks");
    const targetFrameworks = path.join(targetApp, "Contents", "Frameworks");
    const logFile = AppPaths.electronUpdateApplyLogFile();
    const pendingMarker = AppPaths.electronUpdatePendingMarker();
    const applyingMarker = AppPaths.electronUpdateApplyingMarker();

    return [
      "#!/bin/sh",
      "set -u",
      `PID_TO_WAIT=${process.pid}`,
      `SOURCE_EXECUTABLE=${this.shellString(sourceExecutable)}`,
      `TARGET_EXECUTABLE=${this.shellString(targetExecutable)}`,
      `SOURCE_FRAMEWORKS=${this.shellString(sourceFrameworks)}`,
      `TARGET_FRAMEWORKS=${this.shellString(targetFrameworks)}`,
      `TARGET_APP=${this.shellString(targetApp)}`,
      `STAGING_ROOT=${this.shellString(stagingRoot)}`,
      `SCRIPT_PATH=${this.shellString(scriptPath)}`,
      `LOG_FILE=${this.shellString(logFile)}`,
      `PENDING_MARKER=${this.shellString(pendingMarker)}`,
      `APPLYING_MARKER=${this.shellString(applyingMarker)}`,
      "mkdir -p \"$(dirname \"$LOG_FILE\")\"",
      "exec >> \"$LOG_FILE\" 2>&1",
      "log() { printf '%s %s\\n' \"$(date '+%Y-%m-%dT%H:%M:%S')\" \"$1\" >> \"$LOG_FILE\"; }",
      "mark_applying() { rm -f \"$PENDING_MARKER\"; : > \"$APPLYING_MARKER\"; }",
      "clear_markers() { rm -f \"$PENDING_MARKER\" \"$APPLYING_MARKER\"; }",
      "wait_for_app_processes() {",
      "  attempts=0",
      "  while [ \"$attempts\" -lt 200 ]; do",
      "    if command -v pgrep >/dev/null 2>&1 && pgrep -f \"$TARGET_APP/Contents/\" >/dev/null 2>&1; then",
      "      attempts=$((attempts + 1))",
      "      sleep 0.25",
      "      continue",
      "    fi",
      "    return 0",
      "  done",
      "  log 'Timed out waiting for Electron helper processes to exit; attempting replacement anyway.'",
      "  return 0",
      "}",
      "replace_file() {",
      "  src=$1",
      "  dst=$2",
      "  dir=$(dirname \"$dst\")",
      "  base=$(basename \"$dst\")",
      "  temp=\"$dir/.$base.new-$$\"",
      "  backup=\"$dir/.$base.old-$$\"",
      "  rm -rf \"$temp\"",
      "  cp -p \"$src\" \"$temp\"",
      "  chmod 755 \"$temp\" 2>/dev/null || true",
      "  moved=0",
      "  if [ -e \"$dst\" ] || [ -L \"$dst\" ]; then mv \"$dst\" \"$backup\" && moved=1; fi",
      "  if mv \"$temp\" \"$dst\"; then",
      "    rm -rf \"$backup\"",
      "  else",
      "    rm -rf \"$temp\"",
      "    if [ \"$moved\" = \"1\" ] && [ ! -e \"$dst\" ] && [ -e \"$backup\" ]; then mv \"$backup\" \"$dst\"; fi",
      "    return 1",
      "  fi",
      "}",
      "replace_dir() {",
      "  src=$1",
      "  dst=$2",
      "  dir=$(dirname \"$dst\")",
      "  base=$(basename \"$dst\")",
      "  temp=\"$dir/.$base.new-$$\"",
      "  backup=\"$dir/.$base.old-$$\"",
      "  rm -rf \"$temp\"",
      "  cp -R -P -p \"$src\" \"$temp\"",
      "  moved=0",
      "  if [ -e \"$dst\" ] || [ -L \"$dst\" ]; then mv \"$dst\" \"$backup\" && moved=1; fi",
      "  if mv \"$temp\" \"$dst\"; then",
      "    rm -rf \"$backup\"",
      "  else",
      "    rm -rf \"$temp\"",
      "    if [ \"$moved\" = \"1\" ] && [ ! -e \"$dst\" ] && [ -e \"$backup\" ]; then mv \"$backup\" \"$dst\"; fi",
      "    return 1",
      "  fi",
      "}",
      "helper_kind() {",
      "  case \"$1\" in",
      "    *'(GPU)'*) printf '%s\\n' gpu ;;",
      "    *'(Plugin)'*) printf '%s\\n' plugin ;;",
      "    *'(Renderer)'*) printf '%s\\n' renderer ;;",
      "    *) printf '%s\\n' main ;;",
      "  esac",
      "}",
      "first_executable_in_app() {",
      "  app_path=$1",
      "  for executable in \"$app_path/Contents/MacOS\"/*; do",
      "    [ -f \"$executable\" ] && { printf '%s\\n' \"$executable\"; return 0; }",
      "  done",
      "  return 1",
      "}",
      "replace_helper_executables() {",
      "  for source_helper in \"$SOURCE_FRAMEWORKS\"/*.app; do",
      "    [ -d \"$source_helper\" ] || continue",
      "    source_kind=$(helper_kind \"$(basename \"$source_helper\")\")",
      "    source_executable=$(first_executable_in_app \"$source_helper\") || continue",
      "    for target_helper in \"$TARGET_FRAMEWORKS\"/*.app; do",
      "      [ -d \"$target_helper\" ] || continue",
      "      target_kind=$(helper_kind \"$(basename \"$target_helper\")\")",
      "      [ \"$source_kind\" = \"$target_kind\" ] || continue",
      "      target_executable=$(first_executable_in_app \"$target_helper\") || continue",
      "      replace_file \"$source_executable\" \"$target_executable\" || return 1",
      "    done",
      "  done",
      "}",
      "replace_framework_entries() {",
      "  for item in \"$SOURCE_FRAMEWORKS\"/* \"$SOURCE_FRAMEWORKS\"/.[!.]* \"$SOURCE_FRAMEWORKS\"/..?*; do",
      "    [ -e \"$item\" ] || [ -L \"$item\" ] || continue",
      "    name=${item##*/}",
      "    case \"$name\" in",
      "      *.framework) replace_dir \"$item\" \"$TARGET_FRAMEWORKS/$name\" || return 1 ;;",
      "      *.dylib|*.so) replace_file \"$item\" \"$TARGET_FRAMEWORKS/$name\" || return 1 ;;",
      "    esac",
      "  done",
      "}",
      "log 'macOS Electron runtime update helper started.'",
      "mark_applying",
      "while kill -0 \"$PID_TO_WAIT\" 2>/dev/null; do sleep 0.25; done",
      "wait_for_app_processes",
      "sleep 1",
      "log 'Applying macOS Electron runtime update.'",
      "if replace_file \"$SOURCE_EXECUTABLE\" \"$TARGET_EXECUTABLE\" && replace_framework_entries && replace_helper_executables; then",
      "  /usr/bin/codesign --force --deep --sign - \"$TARGET_APP\" >> \"$LOG_FILE\" 2>&1 || log 'Ad-hoc codesign failed.'",
      "  rm -rf \"$STAGING_ROOT\"",
      "  rm -f \"$SCRIPT_PATH\"",
      "  clear_markers",
      "  log 'macOS Electron runtime update applied.'",
      "else",
      "  log 'macOS Electron runtime update failed.'",
      "  clear_markers",
      "  exit 1",
      "fi",
      "",
    ].join("\n");
  }

  private windowsElectronReplacementScript(stagingRoot: string, sourceRoot: string, targetRoot: string, scriptPath: string): string {
    const sourceExecutableName = this.portableElectronSourceExecutableName();
    const targetExecutable = app.getPath("exe");
    const logFile = AppPaths.electronUpdateApplyLogFile();
    const pendingMarker = AppPaths.electronUpdatePendingMarker();
    const applyingMarker = AppPaths.electronUpdateApplyingMarker();
    return [
      "$ErrorActionPreference = 'Stop'",
      `$PidToWait = ${process.pid}`,
      `$SourceRoot = ${this.powerShellString(sourceRoot)}`,
      `$TargetRoot = ${this.powerShellString(targetRoot)}`,
      `$SourceExecutableName = ${this.powerShellString(sourceExecutableName)}`,
      `$TargetExecutable = ${this.powerShellString(targetExecutable)}`,
      `$StagingRoot = ${this.powerShellString(stagingRoot)}`,
      `$ScriptPath = ${this.powerShellString(scriptPath)}`,
      `$LogFile = ${this.powerShellString(logFile)}`,
      `$PendingMarker = ${this.powerShellString(pendingMarker)}`,
      `$ApplyingMarker = ${this.powerShellString(applyingMarker)}`,
      "function Write-UpdateLog([string] $Message) { Add-Content -LiteralPath $LogFile -Value ((Get-Date).ToString('s') + ' ' + $Message) }",
      "function Mark-Applying { if (Test-Path -LiteralPath $PendingMarker) { Remove-Item -LiteralPath $PendingMarker -Force }; New-Item -ItemType File -Path $ApplyingMarker -Force | Out-Null }",
      "function Clear-UpdateMarkers { if (Test-Path -LiteralPath $PendingMarker) { Remove-Item -LiteralPath $PendingMarker -Force }; if (Test-Path -LiteralPath $ApplyingMarker) { Remove-Item -LiteralPath $ApplyingMarker -Force } }",
      "function Replace-File([string] $Source, [string] $Target) {",
      "  $Directory = Split-Path -Parent $Target",
      "  $Name = Split-Path -Leaf $Target",
      "  $Temp = Join-Path $Directory ('.' + $Name + '.new-' + [guid]::NewGuid().ToString('N'))",
      "  $Backup = Join-Path $Directory ('.' + $Name + '.old-' + [guid]::NewGuid().ToString('N'))",
      "  Copy-Item -LiteralPath $Source -Destination $Temp -Force",
      "  $Moved = $false",
      "  try {",
      "    if (Test-Path -LiteralPath $Target) { Move-Item -LiteralPath $Target -Destination $Backup -Force; $Moved = $true }",
      "    Move-Item -LiteralPath $Temp -Destination $Target -Force",
      "  } catch {",
      "    if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Force }",
      "    if ($Moved -and -not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $Backup)) { Move-Item -LiteralPath $Backup -Destination $Target -Force }",
      "    throw",
      "  } finally {",
      "    if (Test-Path -LiteralPath $Backup) { Remove-Item -LiteralPath $Backup -Recurse -Force }",
      "  }",
      "}",
      "function Replace-Path([string] $Source, [string] $Target) {",
      "  $Item = Get-Item -LiteralPath $Source -Force",
      "  if ($Item.PSIsContainer) {",
      "    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }",
      "    Copy-Item -LiteralPath $Source -Destination $Target -Recurse -Force",
      "  } else {",
      "    Replace-File $Source $Target",
      "  }",
      "}",
      "try {",
      "  Write-UpdateLog 'Windows Electron runtime update helper started.'",
      "  Mark-Applying",
      "  while (Get-Process -Id $PidToWait -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }",
      "  Start-Sleep -Milliseconds 500",
      "  Write-UpdateLog 'Applying Electron runtime update.'",
      "  Replace-File (Join-Path $SourceRoot $SourceExecutableName) $TargetExecutable",
      "  Get-ChildItem -LiteralPath $SourceRoot -Force | ForEach-Object {",
      "    if ($_.Name -ine 'resources' -and $_.Name -ine $SourceExecutableName) {",
      "      Replace-Path $_.FullName (Join-Path $TargetRoot $_.Name)",
      "    }",
      "  }",
      "  Remove-Item -LiteralPath $StagingRoot -Recurse -Force",
      "  if (Test-Path -LiteralPath $ScriptPath) { Remove-Item -LiteralPath $ScriptPath -Force }",
      "  Clear-UpdateMarkers",
      "  Write-UpdateLog 'Electron runtime update applied.'",
      "} catch {",
      "  Write-UpdateLog ('Electron runtime update failed: ' + $_.Exception.Message)",
      "  Clear-UpdateMarkers",
      "  throw",
      "}",
    ].join("\r\n");
  }

  private linuxElectronReplacementScript(stagingRoot: string, sourceRoot: string, targetRoot: string, scriptPath: string): string {
    const sourceExecutableName = this.portableElectronSourceExecutableName();
    const targetExecutable = app.getPath("exe");
    const logFile = AppPaths.electronUpdateApplyLogFile();
    const pendingMarker = AppPaths.electronUpdatePendingMarker();
    const applyingMarker = AppPaths.electronUpdateApplyingMarker();
    return [
      "#!/bin/sh",
      "set -u",
      `PID_TO_WAIT=${process.pid}`,
      `SOURCE_ROOT=${this.shellString(sourceRoot)}`,
      `TARGET_ROOT=${this.shellString(targetRoot)}`,
      `SOURCE_EXECUTABLE_NAME=${this.shellString(sourceExecutableName)}`,
      `TARGET_EXECUTABLE=${this.shellString(targetExecutable)}`,
      `STAGING_ROOT=${this.shellString(stagingRoot)}`,
      `SCRIPT_PATH=${this.shellString(scriptPath)}`,
      `LOG_FILE=${this.shellString(logFile)}`,
      `PENDING_MARKER=${this.shellString(pendingMarker)}`,
      `APPLYING_MARKER=${this.shellString(applyingMarker)}`,
      "mkdir -p \"$(dirname \"$LOG_FILE\")\"",
      "exec >> \"$LOG_FILE\" 2>&1",
      "log() { printf '%s %s\\n' \"$(date '+%Y-%m-%dT%H:%M:%S')\" \"$1\" >> \"$LOG_FILE\"; }",
      "mark_applying() { rm -f \"$PENDING_MARKER\"; : > \"$APPLYING_MARKER\"; }",
      "clear_markers() { rm -f \"$PENDING_MARKER\" \"$APPLYING_MARKER\"; }",
      "replace_file() {",
      "  src=$1",
      "  dst=$2",
      "  dir=$(dirname \"$dst\")",
      "  base=$(basename \"$dst\")",
      "  temp=\"$dir/.$base.new-$$\"",
      "  backup=\"$dir/.$base.old-$$\"",
      "  cp -p \"$src\" \"$temp\"",
      "  moved=0",
      "  if [ -e \"$dst\" ] || [ -L \"$dst\" ]; then mv \"$dst\" \"$backup\" && moved=1; fi",
      "  if mv \"$temp\" \"$dst\"; then",
      "    rm -rf \"$backup\"",
      "  else",
      "    rm -f \"$temp\"",
      "    if [ \"$moved\" = \"1\" ] && [ ! -e \"$dst\" ] && [ -e \"$backup\" ]; then mv \"$backup\" \"$dst\"; fi",
      "    return 1",
      "  fi",
      "}",
      "replace_path() {",
      "  src=$1",
      "  dst=$2",
      "  if [ -d \"$src\" ] && [ ! -L \"$src\" ]; then",
      "    rm -rf \"$dst\"",
      "    cp -R -P -p \"$src\" \"$dst\"",
      "  else",
      "    replace_file \"$src\" \"$dst\"",
      "  fi",
      "}",
      "log 'Linux Electron runtime update helper started.'",
      "mark_applying",
      "while kill -0 \"$PID_TO_WAIT\" 2>/dev/null; do sleep 0.25; done",
      "sleep 0.5",
      "log 'Applying Electron runtime update.'",
      "if replace_file \"$SOURCE_ROOT/$SOURCE_EXECUTABLE_NAME\" \"$TARGET_EXECUTABLE\"; then",
      "  for item in \"$SOURCE_ROOT\"/* \"$SOURCE_ROOT\"/.[!.]* \"$SOURCE_ROOT\"/..?*; do",
      "    [ -e \"$item\" ] || [ -L \"$item\" ] || continue",
      "    name=${item##*/}",
      "    [ \"$name\" = 'resources' ] && continue",
      "    [ \"$name\" = \"$SOURCE_EXECUTABLE_NAME\" ] && continue",
      "    replace_path \"$item\" \"$TARGET_ROOT/$name\" || exit 1",
      "  done",
      "  rm -rf \"$STAGING_ROOT\"",
      "  rm -f \"$SCRIPT_PATH\"",
      "  clear_markers",
      "  log 'Electron runtime update applied.'",
      "else",
      "  log 'Electron runtime executable replacement failed.'",
      "  clear_markers",
      "  exit 1",
      "fi",
      "",
    ].join("\n");
  }

  private assertShellScriptSyntax(scriptPath: string, label: string): void {
    const result = spawnSync("/bin/sh", ["-n", scriptPath], { encoding: "utf8" });
    if (result.error) {
      throw new Error(`${label} helper could not be validated: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(output ? `${label} helper has invalid shell syntax.\n\n${output}` : `${label} helper has invalid shell syntax.`);
    }
  }

  private writeElectronUpdatePendingMarker(platform: string, source: string, target: string, helper: string): void {
    const content = [
      `createdAt=${new Date().toISOString()}`,
      `pid=${process.pid}`,
      `platform=${platform}`,
      `source=${source}`,
      `target=${target}`,
      `helper=${helper}`,
      "",
    ].join("\n");
    fs.writeFileSync(AppPaths.electronUpdatePendingMarker(), content, "utf8");
    this.removePathIfExists(AppPaths.electronUpdateApplyingMarker());
  }

  private clearElectronUpdateMarkers(): void {
    this.removePathIfExists(AppPaths.electronUpdatePendingMarker());
    this.removePathIfExists(AppPaths.electronUpdateApplyingMarker());
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

  private powerShellString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private shellString(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private extractZipArchive(archivePath: string, destinationRoot: string): void {
    const archive = fs.readFileSync(archivePath);
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

      this.extractZipEntry(
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
    }
  }

  private findZipEndOfCentralDirectory(archive: Buffer): number {
    const minimumOffset = Math.max(0, archive.length - 0xffff - 22);
    for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
      if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
    }
    throw new Error("Unable to find the ZIP central directory.");
  }

  private extractZipEntry(
    archive: Buffer,
    destinationRoot: string,
    fileName: string,
    compression: number,
    compressedSize: number,
    uncompressedSize: number,
    externalAttributes: number,
    localHeaderOffset: number,
    flags: number,
  ): void {
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
      this.removePathIfExists(destination);
      fs.mkdirSync(destination, { recursive: true });
      if (mode & 0o777) {
        try { fs.chmodSync(destination, mode & 0o777); } catch { /* ignore */ }
      }
      return;
    }

    const content = compression === 0
      ? Buffer.from(compressed)
      : compression === 8
        ? inflateRawSync(compressed)
        : undefined;
    if (!content) throw new Error(`Unsupported ZIP compression method ${compression}: ${fileName}`);
    if (content.length !== uncompressedSize) throw new Error(`ZIP entry size mismatch: ${fileName}`);

    fs.mkdirSync(path.dirname(destination), { recursive: true });

    if (fileType === 0o120000) {
      this.removePathIfExists(destination);
      fs.symlinkSync(content.toString("utf8"), destination);
      return;
    }

    this.removePathIfExists(destination);
    fs.writeFileSync(destination, content);
    const permissions = mode & 0o777;
    if (permissions) {
      try { fs.chmodSync(destination, permissions); } catch { /* ignore */ }
    } else if (process.platform !== "win32" && this.isPortableElectronExecutableName(path.basename(destination))) {
      try { fs.chmodSync(destination, 0o755); } catch { /* ignore */ }
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

  private removePathIfExists(target: string): void {
    this.removeTreeIfExists(target);
  }

  private tryRemoveTree(target: string, label: string): void {
    try {
      this.removeTreeIfExists(target);
    } catch (error) {
      this.appendRecentOutput(`${label} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private removeTreeIfExists(target: string): void {
    try {
      const stats = fs.lstatSync(target);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        for (const entry of fs.readdirSync(target)) {
          this.removeTreeIfExists(path.join(target, entry));
        }
        fs.rmdirSync(target);
        return;
      }

      fs.unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

  private replaceMacElectronRuntime(sourceApp: string, targetApp: string): void {
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

    this.replaceFileAtomically(sourceExecutable, targetExecutable, 0o755);

    for (const entry of fs.readdirSync(sourceFrameworks, { withFileTypes: true })) {
      const source = path.join(sourceFrameworks, entry.name);
      const target = path.join(targetFrameworks, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".framework")) {
        this.replaceDirectoryAtomically(source, target);
      } else if (entry.isFile() && (entry.name.endsWith(".dylib") || entry.name.endsWith(".so"))) {
        this.replaceFileAtomically(source, target, 0o755);
      }
    }

    this.replaceMacElectronHelperExecutables(sourceFrameworks, targetFrameworks);
  }

  private replaceMacElectronHelperExecutables(sourceFrameworks: string, targetFrameworks: string): void {
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

      this.replaceFileAtomically(sourceExecutable, targetExecutable, 0o755);
    }
  }

  private replaceFileAtomically(source: string, target: string, mode?: number): void {
    const directory = path.dirname(target);
    const baseName = path.basename(target);
    const temp = path.join(directory, `.${baseName}.new-${randomUUID()}`);
    const backup = path.join(directory, `.${baseName}.old-${randomUUID()}`);
    let movedTarget = false;

    fs.copyFileSync(source, temp);
    if (mode !== undefined) fs.chmodSync(temp, mode);

    try {
      if (fs.existsSync(target)) {
        fs.renameSync(target, backup);
        movedTarget = true;
      }
      fs.renameSync(temp, target);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      if (movedTarget && !fs.existsSync(target) && fs.existsSync(backup)) {
        fs.renameSync(backup, target);
      }
      throw error;
    } finally {
      fs.rmSync(backup, { force: true });
    }
  }

  private replaceDirectoryAtomically(source: string, target: string): void {
    const directory = path.dirname(target);
    const baseName = path.basename(target);
    const temp = path.join(directory, `.${baseName}.new-${randomUUID()}`);
    const backup = path.join(directory, `.${baseName}.old-${randomUUID()}`);
    let movedTarget = false;

    this.removeTreeIfExists(temp);
    fs.cpSync(source, temp, { recursive: true, verbatimSymlinks: true });

    try {
      if (fs.existsSync(target)) {
        fs.renameSync(target, backup);
        movedTarget = true;
      }
      fs.renameSync(temp, target);
    } catch (error) {
      this.tryRemoveTree(temp, "Directory replacement cleanup");
      if (movedTarget && !fs.existsSync(target) && fs.existsSync(backup)) {
        fs.renameSync(backup, target);
      }
      throw error;
    } finally {
      this.tryRemoveTree(backup, "Directory replacement backup cleanup");
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

  private async downloadFile(
    url: string,
    destination: string,
    expectedByteCount: number | undefined,
    title: string,
    detail: string,
    overallStart: number,
    overallEnd: number,
    mainProgressFractionForDownload?: (progress: DownloadProgress) => number | undefined,
  ): Promise<"completed" | "skipped"> {
    const task = new ManagedDownloadTask(url, destination, expectedByteCount, (progress) => {
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
    });
    this.activeDownloadTask = task;
    try {
      return await task.start(this.downloadPauseRequested);
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
      const appendLocked = (buf: Buffer) => {
        const text = buf.toString("utf8");
        combinedOutput += text;
        this.appendLockedOutput(lockedOutput, text);
      };
      const child = spawn(python, [script, ...args.map(String)], {
        cwd: hasRuntimePython ? AppPaths.runtimePythonDir() : AppPaths.projectRoot(),
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
        this.currentProcess = undefined;
        reject(new Error(`Failed to run runtime manager with ${python}: ${error.message}`));
      });
      child.on("exit", (code) => {
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
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let combinedOutput = "";
      const lockedOutput: string[] = [];
      const appendLocked = (buf: Buffer) => {
        const text = buf.toString("utf8");
        combinedOutput += text;
        this.appendLockedOutput(lockedOutput, text);
      };
      const executable = env.LABEL_STUDIO_RUNTIME_PYTHON ?? AppPaths.runtimePython();
      const child = spawn(executable, args, { cwd, env, shell: false });
      this.currentProcess = child;
      child.stdout.on("data", (chunk) => {
        const buf = Buffer.from(chunk);
        appendLocked(buf);
        if (!capture) this.handleRuntimeOutput(buf, this.stdoutAccumulator, title, progressStart, progressCeiling);
      });
      child.stderr.on("data", (chunk) => {
        const buf = Buffer.from(chunk);
        appendLocked(buf);
        if (!capture) this.handleRuntimeOutput(buf, this.stderrAccumulator, title, progressStart, progressCeiling);
      });
      child.on("error", (error) => {
        this.currentProcess = undefined;
        reject(new Error(`Failed to run ${executable}: ${error.message}`));
      });
      child.on("exit", (code) => {
        this.currentProcess = undefined;
        if (code === 0) resolve(combinedOutput);
        else {
          const text = this.lockedOutputText(lockedOutput) || combinedOutput.trim();
          reject(new Error(text ? `The embedded runtime command exited with status ${code}.\n\n${text}` : `The embedded runtime command exited with status ${code}.`));
        }
      });
    });
  }

  private async runLocalProcess(executable: string, args: string[], cwd: string, allowFailure = false): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const lockedOutput: string[] = [];
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
        this.currentProcess = undefined;
        if (allowFailure) resolve(`Failed to run ${executable}: ${error.message}`);
        else reject(error);
      });
      child.on("exit", (code) => {
        this.currentProcess = undefined;
        const text = this.lockedOutputText(lockedOutput);
        if (code === 0 || allowFailure) resolve(text);
        else reject(new Error(text ? `The embedded runtime command exited with status ${code}.\n\n${text}` : `The embedded runtime command exited with status ${code}.`));
      });
    });
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

  private handleRuntimeOutput(data: Buffer, accumulator: LineAccumulator, title = "Preparing Runtime", progressStart = 0, progressCeiling = 1): void {
    for (const line of accumulator.append(data)) {
      this.appendRecentOutput(line);
      const detail = this.processStatusDetail(line);
      if (!detail) continue;

      const key = `${title}:${progressStart}:${progressCeiling}`;
      const now = Date.now();
      const last = this.lastProcessEmissionByKey.get(key) ?? 0;
      if (now - last < 300) continue;
      this.lastProcessEmissionByKey.set(key, now);

      void this.emitBootstrapStage(title, detail, progressStart, false, undefined, undefined);
    }
  }

  private isUsefulProcessStatusLine(line: string): boolean {
    const prefixes = [
      "Collecting ", "Requirement already satisfied: ", "Using cached ",
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

    if (line.startsWith("Collecting ")) {
      return `Preparing ${line.slice("Collecting ".length)}.`;
    }
    if (line.startsWith("Requirement already satisfied: ")) {
      return `Already satisfied: ${line.slice("Requirement already satisfied: ".length)}.`;
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

  private reclaimDownloadCache(cacheDirectory: string): void {
    try {
      for (const entry of fs.readdirSync(cacheDirectory)) {
        if (entry === ".keep") continue;
        fs.rmSync(path.join(cacheDirectory, entry), { recursive: true, force: true });
      }
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
  ): Promise<void> {
    const clampedProgress = clamp01(progress);
    const clampedDownloadProgress = downloadProgress == null ? undefined : clamp01(downloadProgress);
    const clampedMainProgressFraction = mainProgressFraction == null ? undefined : clamp01(mainProgressFraction);
    const lowerBound = Math.min(this.activeProgressRange[0], this.activeProgressRange[1]);
    const upperBound = Math.max(this.activeProgressRange[0], this.activeProgressRange[1]);
    const mappedProgress = lowerBound + (upperBound - lowerBound) * clampedProgress;
    const stage = launchStage({
      title,
      detail,
      progress: mappedProgress,
      showsDownloadProgress,
      mainProgressFraction: clampedMainProgressFraction,
      downloadProgress: clampedDownloadProgress,
      downloadStatus,
    });
    this.publishBootstrapStage(stage);
  }

  private publishBootstrapStage(stage: LaunchStage): void {
    const now = Date.now();
    if (this.isHoldingAfterCompletedDownload(now)) {
      this.heldStage = stage;
      this.scheduleHeldStagePublish(this.downloadCompletionHoldUntil - now);
      return;
    }

    this.publishBootstrapStageImmediately(stage);
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

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Invalid response ${response.status} from ${url}`);
    return (await response.json()) as T;
  }
}
