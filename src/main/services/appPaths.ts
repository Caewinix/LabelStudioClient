import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

export class AppPaths {
  private static readonly macAppSupportDirectoryName = "Label Studio";
  private static readonly portableAppSupportDirectoryName = "label_studio";

  static appSupportDirectoryName(): string {
    return process.platform === "darwin"
      ? this.macAppSupportDirectoryName
      : this.portableAppSupportDirectoryName;
  }

  static runtimeDirectoryName(): string {
    return process.platform === "darwin" ? "Runtime" : "runtime";
  }

  static projectRoot(): string {
    if (app.isPackaged) {
      if (process.platform !== "darwin") {
        return path.dirname(process.resourcesPath);
      }

      // Packaged:
      //   process.resourcesPath = Label Studio.app/Contents/Resources
      //   projectRoot          = Label Studio.app
      //
      // This mirrors Swift:
      // executableURL
      //   .deletingLastPathComponent() -> Contents/MacOS
      //   .deletingLastPathComponent() -> Contents
      //   .deletingLastPathComponent() -> Label Studio.app
      return path.resolve(process.resourcesPath, "..", "..");
    }

    // Development mode:
    // Assume npm/electron is launched from electron-client project root.
    return process.cwd();
  }

  static resourcesRoot(): string {
    if (app.isPackaged) {
      // Packaged resources must be read from:
      //   Label Studio.app/Contents/Resources
      return process.resourcesPath;
    }

    // Development mode copies Assets/Python into dist for build, but source root
    // also contains Assets/Python. Using projectRoot keeps behavior simple and
    // predictable while developing.
    return this.projectRoot();
  }

  static bundledRuntimeRoot(): string {
    const override = process.env.LABEL_STUDIO_RUNTIME_ROOT;
    if (override && override.trim().length > 0) {
      return path.resolve(override);
    }

    if (app.isPackaged && process.platform === "darwin") {
      // Final packaged runtime location:
      //   Label Studio.app/Contents/Resources/Runtime
      return path.join(process.resourcesPath, "Runtime");
    }

    // Normal development runs must not mutate the source tree. Packaging scripts
    // set LABEL_STUDIO_RUNTIME_ROOT explicitly when they need projectRoot/Runtime
    // for extraResources.
    return path.join(app.getPath("userData"), this.runtimeDirectoryName());
  }

  static bundledRuntimePython(): string {
    return this.runtimePythonForRoot(this.bundledRuntimeRoot());
  }

  static runtimeRoot(): string {
    return this.bundledRuntimeRoot();
  }

  static runtimePython(): string {
    return this.runtimePythonForRoot(this.runtimeRoot());
  }

  static runtimePythonDir(): string {
    return path.dirname(this.runtimePython());
  }

  static runtimeBinDirectoryForRoot(runtimeRoot: string): string {
    if (process.platform === "darwin") {
      return path.join(runtimeRoot, "bin");
    }

    const runtimePython = this.firstExistingPath(this.runtimePythonCandidatesForRoot(runtimeRoot));
    if (runtimePython) return path.dirname(runtimePython);

    return process.platform === "win32"
      ? runtimeRoot
      : path.join(runtimeRoot, "bin");
  }

  static runtimePythonForRoot(runtimeRoot: string): string {
    if (process.platform === "darwin") {
      return path.join(runtimeRoot, "bin", "Python");
    }

    return this.firstExistingPath(this.runtimePythonCandidatesForRoot(runtimeRoot))
      ?? (process.platform === "win32"
        ? path.join(runtimeRoot, "python.exe")
        : path.join(runtimeRoot, "bin", "python3"));
  }

  private static runtimePythonCandidatesForRoot(runtimeRoot: string): string[] {
    if (process.platform === "win32") {
      return [
        path.join(runtimeRoot, "python.exe"),
        path.join(runtimeRoot, "Python.exe"),
        path.join(runtimeRoot, "Scripts", "python.exe"),
        path.join(runtimeRoot, "Scripts", "Python.exe"),
        path.join(runtimeRoot, "bin", "python.exe"),
      ];
    }

    return [
      path.join(runtimeRoot, "bin", "python3"),
      path.join(runtimeRoot, "bin", "python"),
      path.join(runtimeRoot, "bin", "Python"),
    ];
  }

  private static firstExistingPath(candidates: string[]): string | undefined {
    return candidates.find((candidate) => fs.existsSync(candidate));
  }

  static launcherScript(): string {
    return this.firstExistingResourceFile("launch_label_studio.py", this.pythonResourceDirectoryNames());
  }

  static runtimeManagerScript(): string {
    return this.firstExistingResourceFile("manage_runtime.py", this.pythonResourceDirectoryNames());
  }

  private static firstExistingResourceFile(filename: string, directories: string[]): string {
    for (const root of [this.resourcesRoot(), this.projectRoot(), path.join(this.projectRoot(), "dist")]) {
      for (const directory of directories) {
        const candidate = path.join(root, directory, filename);
        if (fs.existsSync(candidate)) return candidate;
      }
    }

    return path.join(this.projectRoot(), directories[0], filename);
  }

  static assetsDirectory(): string {
    for (const directory of this.assetResourceDirectoryNames()) {
      const bundled = path.join(this.resourcesRoot(), directory);
      if (fs.existsSync(bundled)) {
        return bundled;
      }
    }

    return path.join(this.projectRoot(), "assets");
  }

  static appLogo(): string | undefined {
    for (const directory of this.assetResourceDirectoryNames()) {
      const bundled = path.join(this.resourcesRoot(), directory, "logo.svg");
      if (fs.existsSync(bundled)) {
        return bundled;
      }
    }

    const source = path.join(this.projectRoot(), "assets", "logo.svg");
    return fs.existsSync(source) ? source : undefined;
  }

  private static pythonResourceDirectoryNames(): string[] {
    return process.platform === "darwin" ? ["Python", "python"] : ["python", "Python"];
  }

  private static assetResourceDirectoryNames(): string[] {
    return process.platform === "darwin" ? ["Assets", "assets"] : ["assets", "Assets"];
  }

  static downloadCacheDirectory(): string {
    return this.ensureDirectory(path.join(app.getPath("userData"), "cache"));
  }

  static pythonDownloadCacheDirectory(): string {
    return this.ensureDirectory(path.join(this.downloadCacheDirectory(), "python"));
  }

  static electronDownloadCacheDirectory(): string {
    return this.ensureDirectory(path.join(this.downloadCacheDirectory(), "electron"));
  }

  static electronUpdateApplyLogFile(): string {
    return path.join(this.electronDownloadCacheDirectory(), "electron-update-apply.log");
  }

  static electronUpdatePendingMarker(): string {
    return path.join(this.electronDownloadCacheDirectory(), "electron-update-pending");
  }

  static electronUpdateApplyingMarker(): string {
    return path.join(this.electronDownloadCacheDirectory(), "electron-update-applying");
  }

  static packageDownloadCacheDirectory(): string {
    return this.ensureDirectory(path.join(this.downloadCacheDirectory(), "package"));
  }

  static packageWheelhouseCacheDirectory(): string {
    return this.ensureDirectory(path.join(this.packageDownloadCacheDirectory(), "wheelhouse"));
  }

  static packagePlanCacheDirectory(): string {
    return this.ensureDirectory(path.join(this.packageDownloadCacheDirectory(), "plans"));
  }

  static shouldReclaimRuntimeCache(): boolean {
    return app.isPackaged;
  }

  static pipCacheDirectory(): string {
    // Keep pip's own HTTP/cache data inside the package download cache.
    return this.ensureDirectory(path.join(this.packageDownloadCacheDirectory(), "pip"));
  }

  static applicationSupportDirectory(): string {
    const directory = path.join(app.getPath("appData"), this.appSupportDirectoryName());
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  static dataDirectory(): string {
    return this.ensureDirectory(path.join(this.applicationSupportDirectory(), "data"));
  }

  static pythonHomeForRuntime(runtimeRoot: string): string {
    return path.join(
      runtimeRoot,
      "Library",
      "Frameworks",
      "Python.framework",
      "Versions",
      "Current",
    );
  }

  static dyldFrameworkPathForRuntime(runtimeRoot: string): string {
    return path.join(runtimeRoot, "Library", "Frameworks");
  }

  static dyldLibraryPathForRuntime(runtimeRoot: string): string {
    return path.join(this.pythonHomeForRuntime(runtimeRoot), "lib");
  }

  static makePythonEnvironment(): NodeJS.ProcessEnv {
    return this.makePythonEnvironmentForRuntime(this.runtimeRoot());
  }

  static makePythonEnvironmentForRuntime(runtimeRoot: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };

    environment.PYTHONUNBUFFERED = "1";
    delete environment.PYTHONHOME;
    delete environment.PYTHONPATH;
    delete environment.DYLD_FRAMEWORK_PATH;
    delete environment.DYLD_LIBRARY_PATH;

    if (process.platform === "darwin") {
      environment.PYTHONHOME = this.pythonHomeForRuntime(runtimeRoot);
      environment.DYLD_FRAMEWORK_PATH = this.dyldFrameworkPathForRuntime(runtimeRoot);
      environment.DYLD_LIBRARY_PATH = this.dyldLibraryPathForRuntime(runtimeRoot);
      delete environment.VIRTUAL_ENV;
    } else if (fs.existsSync(path.join(runtimeRoot, "pyvenv.cfg"))) {
      environment.VIRTUAL_ENV = runtimeRoot;
    }

    environment.LABEL_STUDIO_PROJECT_ROOT = this.projectRoot();
    environment.LABEL_STUDIO_RUNTIME_ROOT = runtimeRoot;
    environment.LABEL_STUDIO_RUNTIME_PYTHON = this.runtimePythonForRoot(runtimeRoot);
    environment.LABEL_STUDIO_RUNTIME_CACHE = this.packageWheelhouseCacheDirectory();
    environment.PIP_CACHE_DIR = this.pipCacheDirectory();

    const certificateBundle = this.pythonCertificateBundleForRuntime(runtimeRoot);
    if (certificateBundle) {
      environment.SSL_CERT_FILE = certificateBundle;
      environment.REQUESTS_CA_BUNDLE = certificateBundle;
    }

    const pathEntries = [this.runtimeBinDirectoryForRoot(runtimeRoot)];
    if (process.platform === "win32") {
      pathEntries.push(runtimeRoot, path.join(runtimeRoot, "Scripts"));
    } else if (process.platform === "linux") {
      const runtimeLib = path.join(runtimeRoot, "lib");
      environment.LD_LIBRARY_PATH = environment.LD_LIBRARY_PATH
        ? `${runtimeLib}${path.delimiter}${environment.LD_LIBRARY_PATH}`
        : runtimeLib;
    }

    const runtimePath = [...new Set(pathEntries)].join(path.delimiter);
    environment.PATH = environment.PATH
      ? `${runtimePath}${path.delimiter}${environment.PATH}`
      : runtimePath;

    return environment;
  }

  private static pythonCertificateBundleForRuntime(runtimeRoot: string): string | undefined {
    for (const sitePackages of this.sitePackagesDirectories(runtimeRoot)) {
      for (const candidate of [
        path.join(sitePackages, "certifi", "cacert.pem"),
        path.join(sitePackages, "pip", "_vendor", "certifi", "cacert.pem"),
        path.join(sitePackages, "botocore", "cacert.pem"),
      ]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }

    return undefined;
  }

  private static sitePackagesDirectories(runtimeRoot: string): string[] {
    const directories = new Set<string>();
    directories.add(path.join(runtimeRoot, "Lib", "site-packages"));

    const libRoot = path.join(runtimeRoot, "lib");
    for (const pythonDirectory of this.childDirectoriesMatching(libRoot, /^python\d+(?:\.\d+)?$/)) {
      directories.add(path.join(pythonDirectory, "site-packages"));
    }

    const frameworkVersions = path.join(runtimeRoot, "Library", "Frameworks", "Python.framework", "Versions");
    for (const versionDirectory of this.childDirectoriesMatching(frameworkVersions, /^(?:Current|\d+(?:\.\d+)*)$/)) {
      const frameworkLib = path.join(versionDirectory, "lib");
      for (const pythonDirectory of this.childDirectoriesMatching(frameworkLib, /^python\d+(?:\.\d+)?$/)) {
        directories.add(path.join(pythonDirectory, "site-packages"));
      }
    }

    return [...directories];
  }

  private static childDirectoriesMatching(parent: string, pattern: RegExp): string[] {
    try {
      return fs.readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .filter((entry) => pattern.test(entry.name))
        .map((entry) => path.join(parent, entry.name));
    } catch {
      return [];
    }
  }

  static makeRuntimeManagerEnvironment(): NodeJS.ProcessEnv {
    const runtimeRoot = this.runtimeRoot();
    const runtimePython = this.runtimePythonForRoot(runtimeRoot);

    let environment: NodeJS.ProcessEnv;

    if (this.isExecutable(runtimePython)) {
      // When running ManageRuntime.py with the embedded runtime Python, it needs the
      // Python.framework environment, otherwise stdlib modules like encodings
      // may fail to load.
      environment = this.makePythonEnvironmentForRuntime(runtimeRoot);
    } else {
      // When no embedded runtime exists yet, ManageRuntime.py must run with the
      // host/bootstrap Python. In that case PYTHONHOME/DYLD_* pointing at a
      // missing embedded framework would break the host interpreter.
      environment = this.cleanHostPythonEnvironment();
      environment.PYTHONUNBUFFERED = "1";
      environment.LABEL_STUDIO_PROJECT_ROOT = this.projectRoot();
      environment.LABEL_STUDIO_RUNTIME_ROOT = this.bundledRuntimeRoot();
      environment.LABEL_STUDIO_RUNTIME_PYTHON = this.bundledRuntimePython();
      environment.LABEL_STUDIO_RUNTIME_CACHE = this.packageWheelhouseCacheDirectory();
      environment.PIP_CACHE_DIR = this.pipCacheDirectory();
    }

    return environment;
  }

  static cleanHostPythonEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };

    delete environment.PYTHONHOME;
    delete environment.PYTHONPATH;
    delete environment.DYLD_FRAMEWORK_PATH;
    delete environment.DYLD_LIBRARY_PATH;
    delete environment.VIRTUAL_ENV;

    return environment;
  }

  static bootstrapPython(): string {
    const platformCandidates = process.platform === "win32"
      ? ["py", "python"]
      : process.platform === "darwin"
        ? ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3", "python3", "python"]
        : ["/usr/bin/python3", "python3", "python"];

    const candidates = [
      process.env.PYTHON,
      process.env.PYTHON3,
      ...platformCandidates,
    ].filter((value): value is string => Boolean(value && value.trim().length > 0));

    return candidates[0] ?? (process.platform === "win32" ? "python" : "python3");
  }

  static isExecutable(filePath: string): boolean {
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  static ensureDirectory(directory: string): string {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  static ensureParentDirectory(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  static pathExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  static removeIfExists(filePath: string): void {
    fs.rmSync(filePath, { recursive: true, force: true });
  }

  static currentPlatformRuntimeLabel(): string {
    return `${process.platform}-${process.arch}`;
  }

  static userHome(): string {
    return os.homedir();
  }
}
