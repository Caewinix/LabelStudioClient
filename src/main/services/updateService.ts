import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import { AppPaths } from './appPaths';

const execFileAsync = promisify(execFile);

export interface RuntimeVersions {
  electronVersion: string;
  packageVersion: string;
  pythonVersion: string;
}

export interface ElectronCheckResult {
  currentElectronVersion: string;
  latestElectronVersion: string;
  latestCEFVersion: string;
  platform: string;
  updateAvailable: boolean;
}

export interface PackageCheckResult {
  currentPackageVersion: string;
  currentPythonVersion: string;
  latestPackageVersion: string;
  requiresPython: string;
  minimumPythonVersion: string;
  pythonSatisfiesLatestPackage: boolean;
  updateAvailable: boolean;
}

export interface PythonCheckResult {
  currentPythonVersion: string;
  latestPackageVersion: string;
  requiresPython: string;
  minimumPythonVersion: string;
  pythonSatisfiesLatestPackage: boolean;
  latestInstallerVersion: string;
  updateAvailable: boolean;
}

function compareVersions(a: string, b: string): number {
  if (!a || a === 'Not installed') return -1;
  if (!b || b === 'Unknown') return 0;
  const pa = a.split(/[.-]/).map(x => Number.parseInt(x, 10)).filter(Number.isFinite);
  const pb = b.split(/[.-]/).map(x => Number.parseInt(x, 10)).filter(Number.isFinite);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function camelizeKey(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[camelizeKey(key)] = camelize(v);
    return out;
  }
  return value;
}

interface NpmProject { version?: string; 'dist-tags'?: { latest?: string }; }

interface VersionFetchOptions {
  force?: boolean;
}

export class UpdateService {
  private cachedVersions?: RuntimeVersions;
  private versionFetchPromise?: Promise<RuntimeVersions>;
  private versionCacheEpoch = 0;

  primeVersionCache(): void {
    if (this.cachedVersions || this.versionFetchPromise) return;
    void this.fetchVersions().catch(() => {
      // Version reads already have local fallbacks.  A failed warm-up should not
      // affect startup; callers can request the versions again later.
    });
  }

  invalidateVersionCache(): void {
    this.cachedVersions = undefined;
    this.versionFetchPromise = undefined;
    this.versionCacheEpoch += 1;
  }

  async refreshVersionCache(): Promise<RuntimeVersions> {
    return await this.fetchVersions({ force: true });
  }

  versionSnapshot(): RuntimeVersions {
    return this.cachedVersions ?? {
      electronVersion: this.currentElectronVersion(),
      packageVersion: this.packageVersionFromMetadata() ?? 'Not installed',
      pythonVersion: this.pythonVersionFromRuntimeFiles(AppPaths.runtimeRoot()) ?? 'Unknown'
    };
  }

  async fetchVersions(options: VersionFetchOptions = {}): Promise<RuntimeVersions> {
    if (!options.force) {
      if (this.cachedVersions) return this.cachedVersions;
      if (this.versionFetchPromise) return await this.versionFetchPromise;
    }

    if (options.force) {
      this.cachedVersions = undefined;
      this.versionCacheEpoch += 1;
    }

    const epoch = this.versionCacheEpoch;
    const promise = this.readVersions()
      .then(versions => {
        if (epoch === this.versionCacheEpoch) this.cachedVersions = versions;
        return versions;
      })
      .finally(() => {
        if (this.versionFetchPromise === promise) this.versionFetchPromise = undefined;
      });

    this.versionFetchPromise = promise;
    return await promise;
  }

  private async readVersions(): Promise<RuntimeVersions> {
    try {
      const versions = await this.run<Pick<RuntimeVersions, 'packageVersion' | 'pythonVersion'>>('versions', 15_000);
      if (this.hasReadableVersion(versions.packageVersion) && this.hasReadableVersion(versions.pythonVersion)) {
        return {
          electronVersion: this.currentElectronVersion(),
          packageVersion: versions.packageVersion,
          pythonVersion: versions.pythonVersion
        };
      }

      const fallbackVersions = await this.fallbackRuntimeVersions();
      return {
        electronVersion: this.currentElectronVersion(),
        packageVersion: this.readableVersion(versions.packageVersion, fallbackVersions.packageVersion),
        pythonVersion: this.readableVersion(versions.pythonVersion, fallbackVersions.pythonVersion)
      };
    } catch {
      // The update window should still show local versions when the runtime
      // manager script is missing, slow to start, or temporarily broken.
      const fallbackVersions = await this.fallbackRuntimeVersions();
      return {
        electronVersion: this.currentElectronVersion(),
        packageVersion: fallbackVersions.packageVersion,
        pythonVersion: fallbackVersions.pythonVersion
      };
    }
  }

  private hasReadableVersion(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private readableVersion(value: unknown, fallback: string): string {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 ? text : fallback;
  }

  private async fallbackRuntimeVersions(): Promise<Pick<RuntimeVersions, 'packageVersion' | 'pythonVersion'>> {
    return {
      packageVersion: this.packageVersionFromMetadata() ?? 'Not installed',
      pythonVersion: await this.pythonVersionFromRuntime() ?? 'Unknown'
    };
  }

  async checkElectron(): Promise<ElectronCheckResult> {
    const currentElectronVersion = this.currentElectronVersion();
    const latestElectronVersion = await this.latestElectronVersion();
    return {
      currentElectronVersion,
      latestElectronVersion,
      latestCEFVersion: 'Electron bundled Chromium',
      platform: `${process.platform}-${process.arch}`,
      updateAvailable: compareVersions(currentElectronVersion, latestElectronVersion) < 0
    };
  }

  async checkPackage(): Promise<PackageCheckResult> {
    return await this.run<PackageCheckResult>('check-package');
  }

  async checkPython(): Promise<PythonCheckResult> {
    return await this.run<PythonCheckResult>('check-python');
  }

  private async latestElectronVersion(): Promise<string> {
    const project = await this.fetchJson<NpmProject>('https://registry.npmjs.org/electron/latest');
    return project.version ?? project['dist-tags']?.latest ?? this.currentElectronVersion();
  }

  private currentElectronVersion(): string {
    return process.versions.electron ?? this.electronVersionFromPackageJson() ?? 'Unknown';
  }

  private electronVersionFromPackageJson(): string | undefined {
    for (const filePath of [
      path.join(AppPaths.projectRoot(), 'node_modules', 'electron', 'package.json'),
      path.join(AppPaths.projectRoot(), 'package.json')
    ]) {
      try {
        const json = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
          version?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const version = filePath.includes(`${path.sep}node_modules${path.sep}`)
          ? json.version
          : json.dependencies?.electron ?? json.devDependencies?.electron;
        const normalized = version?.trim().replace(/^[~^]/, '');
        if (normalized) return normalized;
      } catch {
        // Try the next known package location.
      }
    }

    return undefined;
  }

  private packageVersionFromMetadata(): string | undefined {
    for (const sitePackages of this.sitePackagesDirectories(AppPaths.runtimeRoot())) {
      if (!fs.existsSync(sitePackages)) continue;

      let entries: string[];
      try {
        entries = fs.readdirSync(sitePackages);
      } catch {
        continue;
      }

      const versions = entries
        .filter(entry => /^label[-_.]studio-[^-]+\.dist-info$/i.test(entry))
        .map(entry => this.versionFromPackageMetadata(path.join(sitePackages, entry, 'METADATA')))
        .filter((version): version is string => Boolean(version));

      if (versions.length > 0) {
        return versions.sort((left, right) => compareVersions(right, left))[0];
      }
    }

    return undefined;
  }

  private versionFromPackageMetadata(metadataPath: string): string | undefined {
    try {
      const text = fs.readFileSync(metadataPath, 'utf8');
      const name = text.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
      if (name?.toLowerCase() !== 'label-studio') return undefined;
      return text.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
    } catch {
      return undefined;
    }
  }

  private sitePackagesDirectories(runtimeRoot: string): string[] {
    const directories = new Set<string>();
    directories.add(path.join(runtimeRoot, 'Lib', 'site-packages'));

    const libRoot = path.join(runtimeRoot, 'lib');
    for (const pythonDirectory of this.childDirectoriesMatching(libRoot, /^python\d+(?:\.\d+)?$/)) {
      directories.add(path.join(pythonDirectory, 'site-packages'));
    }

    const frameworkVersions = path.join(runtimeRoot, 'Library', 'Frameworks', 'Python.framework', 'Versions');
    for (const versionDirectory of this.childDirectoriesMatching(frameworkVersions, /^(?:Current|\d+(?:\.\d+)*)$/)) {
      const frameworkLib = path.join(versionDirectory, 'lib');
      for (const pythonDirectory of this.childDirectoriesMatching(frameworkLib, /^python\d+(?:\.\d+)?$/)) {
        directories.add(path.join(pythonDirectory, 'site-packages'));
      }
    }

    return [...directories];
  }

  private childDirectoriesMatching(parent: string, pattern: RegExp): string[] {
    try {
      return fs.readdirSync(parent, { withFileTypes: true })
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
        .filter(entry => pattern.test(entry.name))
        .map(entry => path.join(parent, entry.name));
    } catch {
      return [];
    }
  }

  private async pythonVersionFromRuntime(): Promise<string | undefined> {
    const pythonURL = AppPaths.runtimePython();
    if (AppPaths.isExecutable(pythonURL)) {
      try {
        const { stdout, stderr } = await execFileAsync(pythonURL, ['--version'], {
          cwd: AppPaths.runtimePythonDir(),
          env: AppPaths.makePythonEnvironment(),
          timeout: 10_000,
          maxBuffer: 1024 * 1024
        });
        const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        const version = text.match(/Python\s+([^\s]+)/)?.[1];
        if (version) return version;
      } catch {
        // Fall through to the framework metadata below.
      }
    }

    return this.pythonVersionFromRuntimeFiles(AppPaths.runtimeRoot());
  }

  private pythonVersionFromRuntimeFiles(runtimeRoot: string): string | undefined {
    if (process.platform !== 'darwin') {
      return this.pythonVersionFromPyvenvConfig(runtimeRoot)
        ?? this.pythonVersionFromPortablePatchlevel(runtimeRoot);
    }

    const frameworkVersions = path.join(runtimeRoot, 'Library', 'Frameworks', 'Python.framework', 'Versions');
    const candidates = this.childDirectoriesMatching(frameworkVersions, /^(?:Current|\d+(?:\.\d+)*)$/)
      .flatMap(versionDirectory => this.patchlevelCandidates(versionDirectory));

    for (const candidate of candidates) {
      const version = this.pythonVersionFromPatchlevel(candidate);
      if (version) return version;
    }

    return this.childDirectoriesMatching(frameworkVersions, /^\d+(?:\.\d+)*$/)
      .map(directory => path.basename(directory))
      .sort((left, right) => compareVersions(right, left))[0];
  }

  private pythonVersionFromPyvenvConfig(runtimeRoot: string): string | undefined {
    try {
      const text = fs.readFileSync(path.join(runtimeRoot, 'pyvenv.cfg'), 'utf8');
      return text.match(/^version\s*=\s*(.+)$/mi)?.[1]?.trim();
    } catch {
      return undefined;
    }
  }

  private pythonVersionFromPortablePatchlevel(runtimeRoot: string): string | undefined {
    const includeRoot = path.join(runtimeRoot, 'include');
    const candidates = this.childDirectoriesMatching(includeRoot, /^python\d+(?:\.\d+)?$/)
      .map(directory => path.join(directory, 'patchlevel.h'));

    for (const candidate of candidates) {
      const version = this.pythonVersionFromPatchlevel(candidate);
      if (version) return version;
    }

    return undefined;
  }

  private patchlevelCandidates(versionDirectory: string): string[] {
    const includeRoot = path.join(versionDirectory, 'include');
    return this.childDirectoriesMatching(includeRoot, /^python\d+(?:\.\d+)?$/)
      .map(directory => path.join(directory, 'patchlevel.h'));
  }

  private pythonVersionFromPatchlevel(filePath: string): string | undefined {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      return text.match(/#define\s+PY_VERSION\s+"([^"]+)"/)?.[1];
    } catch {
      return undefined;
    }
  }

  private async run<T>(command: string, timeout?: number): Promise<T> {
    const pythonURL = AppPaths.runtimePython();
    const scriptURL = AppPaths.runtimeManagerScript();

    if (!AppPaths.isExecutable(pythonURL)) throw new Error(`Embedded Python runtime is missing: ${pythonURL}`);
    if (!fs.existsSync(scriptURL)) throw new Error(`Runtime management script is missing: ${scriptURL}`);

    try {
      const { stdout, stderr } = await execFileAsync(pythonURL, [scriptURL, command], {
        cwd: AppPaths.runtimePythonDir(),
        env: AppPaths.makePythonEnvironment(),
        timeout,
        maxBuffer: 1024 * 1024 * 8
      });
      return this.decodePayload<T>(String(stdout ?? ''), String(stderr ?? ''));
    } catch (error: unknown) {
      const err = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
      const stderrText = String(err.stderr ?? '').trim();
      if (typeof err.code === 'number') {
        if (!stderrText) throw new Error(`The embedded runtime command exited with status ${err.code}.`);
        throw new Error(`The embedded runtime command exited with status ${err.code}:\n\n${stderrText}`);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private combinedText(stdout: string, stderr: string): string {
    const stdoutText = stdout.trim();
    const stderrText = stderr.trim();
    if (!stdoutText) return stderrText;
    if (!stderrText) return stdoutText;
    return `${stdoutText}\n${stderrText}`;
  }

  private decodePayload<T>(stdout: string, stderr: string): T {
    const candidates: string[] = [];
    const trimmedStdout = stdout.trim();
    const trimmedStderr = stderr.trim();
    if (trimmedStdout) candidates.push(trimmedStdout);
    if (trimmedStderr) candidates.push(trimmedStderr);
    const combined = [trimmedStdout, trimmedStderr].filter(Boolean).join('\n');
    for (const line of combined.split(/\r?\n/).map(v => v.trim()).filter(v => v.startsWith('{') && v.endsWith('}')).reverse()) {
      candidates.push(line);
    }
    for (const candidate of candidates) {
      try { return camelize(JSON.parse(candidate)) as T; } catch { /* continue */ }
    }
    if (!combined) throw new Error('The embedded runtime did not return a readable JSON response.');
    throw new Error(`The embedded runtime returned an unexpected response:\n\n${combined}`);
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Invalid response ${response.status} from ${url}`);
    return await response.json() as T;
  }

  appVersionString(): string {
    return app.getVersion()
    // const buildVersion = process.env.LABEL_STUDIO_BUILD_VERSION || '1';
    // return `${app.getVersion()} (${buildVersion})`;
  }
}
