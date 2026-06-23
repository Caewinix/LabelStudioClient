import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, session, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron';
import { PythonService } from './services/pythonService';
import { RuntimeBootstrapService, BootstrapMode } from './services/runtimeBootstrapService';
import { AppPaths } from './services/appPaths';
import { LaunchStage, LaunchStep, launchStage, launchStageWithTitleProgress, UpdatePreferenceDefaults, UpdatePreferenceKey } from './services/launchModels';
import { createSplashWindow, updateSplash, updateSplashDownloadPaused, waitForSplashRendererReady } from './windows/splashWindow';
import { UpdateWindowController } from './windows/updateWindow';
import { resolveAppIconPath } from './utils/appIcon';
import { initialWindowFrame, rememberWindowFrame } from './utils/windowFrameStore';

const AppDisplayName = 'Label Studio';

class JsonStore {
    private data: Record<string, unknown> = {};

    constructor(private readonly file: string) {
        this.load();
        for (const [key, value] of Object.entries(UpdatePreferenceDefaults)) {
            if (!(key in this.data)) this.data[key] = value;
        }
        this.save();
    }

    load(): void {
        try {
            this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
        } catch {
            this.data = {};
        }
    }

    save(): void {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }

    get(key: string): unknown {
        return this.data[key];
    }

    set(key: string, value: unknown): void {
        this.data[key] = value;
        this.save();
    }
}

type RuntimeVersionSnapshot = Awaited<ReturnType<RuntimeBootstrapService['fetchVersions']>>;

type RuntimeReadinessCache = {
    usable: boolean;
    versions?: RuntimeVersionSnapshot;
    updatedAt: number;
    reason: string;
    errorText?: string;
};

class AppDelegate {
    private mainWindow?: BrowserWindow;
    private splashWindow?: BrowserWindow;
    private readonly pythonService = new PythonService();
    private readonly runtimeBootstrapService = new RuntimeBootstrapService();
    private readonly updateWindowController = new UpdateWindowController(this.runtimeBootstrapService);
    private isShuttingDown = false;

    private runtimeBootstrapInProgress = false;
    private runtimeBootstrapCompleted = false;
    private versionReadinessCache?: RuntimeReadinessCache;
    private versionReadinessRefreshPromise?: Promise<void>;

    async applicationDidFinishLaunching(): Promise<void> {
        this.buildMainMenu();
        this.buildSplashWindow();

        this.runtimeBootstrapService.on('stage', stage => this.publishLaunchStage(stage));
        this.pythonService.on('stage', stage => this.publishLaunchStage(stage, stage.progress));

        this.runtimeBootstrapService.primeVersionCache();
        this.refreshVersionReadinessCacheInBackground('applicationDidFinishLaunching');

        try {
            await this.ensureRequiredRuntime();
            await this.checkProjectDataForLaunch();

            const autoElectron = Boolean(globalThis.sharedStore?.get(UpdatePreferenceKey.autoCheckElectron));
            const autoPackage = Boolean(globalThis.sharedStore?.get(UpdatePreferenceKey.autoCheckPackage));
            const autoPython = Boolean(globalThis.sharedStore?.get(UpdatePreferenceKey.autoCheckPython));
            if (autoElectron || autoPackage || autoPython) {
                this.publishLaunchStage(launchStage({
                    title: 'Checking Updates',
                    detail: 'Checking selected Electron, package, and runtime update preferences.',
                    progress: 0
                }), 0);
            }

            await this.updateWindowController.performAutomaticChecksIfNeeded();
            if (autoElectron || autoPackage || autoPython) {
                this.publishLaunchStage(launchStage({
                    title: 'Checking Updates',
                    detail: 'Selected update preferences are checked.',
                    progress: 1
                }), 1);
            }
            this.markVersionReadinessCacheDirty('after automatic checks');

            let baseURL: string;
            try {
                this.publishLaunchStage(launchStage({
                    title: LaunchStep.localService.title,
                    detail: 'Launching the local Label Studio web service.',
                    progress: 0
                }), 0);
                baseURL = await this.pythonService.start();
            } catch (error) {
                if (!this.isRuntimeMissingError(error)) throw error;
                await this.ensureRequiredRuntime(true);
                this.markVersionReadinessCacheDirty('after forced runtime provisioning');
                await this.checkProjectDataForLaunch();
                this.publishLaunchStage(launchStage({
                    title: LaunchStep.localService.title,
                    detail: 'Launching the local Label Studio web service.',
                    progress: 0
                }), 0);
                baseURL = await this.pythonService.start();
            }

            this.publishLaunchStage(launchStage({
                title: LaunchStep.localService.title,
                detail: 'Local service is ready. Opening the workspace.',
                progress: 1
            }), 1);
            this.publishLaunchStage(LaunchStep.interfaceReady);
            await this.buildMainWindow(baseURL);
            if (this.splashWindow && !this.splashWindow.isDestroyed()) this.splashWindow.close();
        } catch (error) {
            if (this.isShuttingDown) return;
            await this.presentFailure(error);
        }
    }

    private buildSplashWindow(): void {
        this.splashWindow = createSplashWindow();

        ipcMain.on('launch-set-download-paused', (_event, paused: boolean) => {
            const actualPaused = this.runtimeBootstrapService.setCurrentDownloadPaused(Boolean(paused));
            updateSplashDownloadPaused(this.splashWindow, actualPaused);
        });

        ipcMain.handle('launch-toggle-download-pause', () => {
            const paused = this.runtimeBootstrapService.toggleCurrentDownloadPause();
            updateSplashDownloadPaused(this.splashWindow, paused);
            return paused;
        });

        ipcMain.handle('launch-cancel-download', async () => {
            return await this.cancelCurrentDownloadFromSplash();
        });
    }

    private publishLaunchStage(stage: LaunchStage, fraction?: number): void {
        updateSplash(this.splashWindow, launchStageWithTitleProgress(stage, fraction));
    }

    private async checkProjectDataForLaunch(): Promise<void> {
        this.publishLaunchStage(launchStage({
            title: LaunchStep.migrations.title,
            detail: 'Verifying local runtime metadata and project data.',
            progress: 0
        }), 0);

        await this.refreshVersionReadinessCacheNow('launch project data check');

        this.publishLaunchStage(launchStage({
            title: LaunchStep.migrations.title,
            detail: 'Local runtime metadata and project data are ready.',
            progress: 1
        }), 1);
    }

    private async cancelCurrentDownloadFromSplash(): Promise<boolean> {
        if (this.runtimeBootstrapService.pauseCurrentDownload()) {
            updateSplashDownloadPaused(this.splashWindow, true);
        }

        if (await this.hasUsableEmbeddedRuntimeAndPackage()) {
            this.runtimeBootstrapService.cancelCurrentDownloadAndSkip();
            updateSplashDownloadPaused(this.splashWindow, false);
            return true;
        }

        const result = await this.showSplashCancelDownloadDialog();

        if (!result) {
            this.runtimeBootstrapService.cancelCurrentDownloadAndSkip();
            this.beginApplicationShutdown();
            return true;
        }

        this.runtimeBootstrapService.resumeCurrentDownload();
        updateSplashDownloadPaused(this.splashWindow, false);
        return false;
    }

    private async showSplashCancelDownloadDialog(): Promise<boolean> {
        const parent = this.splashWindow && !this.splashWindow.isDestroyed() ? this.splashWindow : undefined;

        const result = await this.showMessageBox({
            type: 'question',
            message: 'Cancel Download And Quit?',
            detail: 'The embedded Python runtime, Label Studio package, and Chromium runtime are not all available inside this app. If you cancel this download now, Label Studio cannot start.',
            buttons: ['Continue Download', 'Cancel Download and Quit'],
            defaultId: 0,
            cancelId: 1
        });

        return result.response === 0;
    }

    private buildMainWindow(initialURL: string): Promise<void> {
        const display = this.splashWindow && !this.splashWindow.isDestroyed()
            ? screen.getDisplayMatching(this.splashWindow.getBounds())
            : screen.getPrimaryDisplay();
        const initialFrame = initialWindowFrame({
            id: 'main',
            display,
            defaultWidth: 1280,
            defaultHeight: 820,
            minWidth: 800,
            minHeight: 560
        });

        this.mainWindow = new BrowserWindow({
            ...initialFrame,
            minWidth: 800,
            minHeight: 560,
            title: 'Label Studio',
            show: false,
            backgroundColor: '#ffffff',
            icon: resolveAppIconPath(),
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
        });

        rememberWindowFrame(this.mainWindow, 'main');
        this.mainWindow.on('closed', () => { this.mainWindow = undefined; });

        return new Promise<void>((resolve) => {
            let resolved = false;
            const finish = (): void => {
                if (resolved) return;
                resolved = true;
                this.mainWindow?.show();
                this.mainWindow?.focus();
                resolve();
            };
            this.mainWindow?.once('ready-to-show', finish);
            this.mainWindow?.webContents.once('did-finish-load', finish);
            this.mainWindow?.webContents.once('did-fail-load', finish);
            setTimeout(finish, 2500);
            void this.mainWindow?.loadURL(initialURL);
        });
    }

    private async showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
        const parent = this.splashWindow && !this.splashWindow.isDestroyed() ? this.splashWindow : undefined;
        await waitForSplashRendererReady(parent);
        const dialogOptions: MessageBoxOptions = { noLink: true, ...options };
        const response = parent ? await dialog.showMessageBox(parent, dialogOptions) : await dialog.showMessageBox(dialogOptions);
        return response;
    }

    private async presentFailure(error: unknown): Promise<void> {
        const fullDetail = this.failureInformativeText(error);
        const cleanDetail = this.failureCleanDetailsFromText(fullDetail);
        const shortDetail = this.failureSummaryFromText(cleanDetail);

        let copiedNotice = '';

        const result = await this.showMessageBox({
            type: 'error',
            message: 'Failed to Start Label Studio',
            detail: [
                copiedNotice,
                shortDetail,
                'Click Copy Details to copy the cleaned error details.'
            ].filter(Boolean).join('\n\n'),
            buttons: ['Copy Details', 'Quit'],
            defaultId: 1,
            cancelId: 0,
            noLink: true
        });

        if (result.response === 0) {
            clipboard.writeText(cleanDetail);
            copiedNotice = 'Cleaned error details copied to clipboard.';
        }

        this.beginApplicationShutdown();
    }

    private failureCleanDetailsFromText(detail: string): string {
        const normalized = detail
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n');

        const cleanedLines: string[] = [];
        const seen = new Set<string>();

        for (const rawLine of normalized.split('\n')) {
            const cleanedLine = this.cleanFailureDetailLine(rawLine);

            if (cleanedLine == null) continue;

            const trimmed = cleanedLine.trim();

            if (trimmed.length === 0) {
                cleanedLines.push('');
                continue;
            }

            const key = this.failureCleanDedupeKey(trimmed);

            if (seen.has(key)) continue;
            seen.add(key);

            cleanedLines.push(cleanedLine);
        }

        const result = this.collapseBlankLines(cleanedLines).join('\n').trim();

        return result.length > 0 ? result : this.failureSummaryFromText(normalized);
    }

    private cleanFailureDetailLine(rawLine: string): string | undefined {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();

        if (trimmed.length === 0) return '';

        // 把：
        // [2026-06-17 16:56:52,317] [urllib3.connectionpool::urlopen::869] [WARNING] Retrying ...
        // 变成：
        // [urllib3.connectionpool::urlopen::869] [WARNING] Retrying ...
        const timestampMatch = trimmed.match(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*(.+)$/);
        if (timestampMatch?.[1]) {
            return timestampMatch[1].trim();
        }

        return line;
    }

    private failureCleanDedupeKey(line: string): string {
        return line
            .replace(/\s+/g, ' ')
            // Retry(total=2/1/0) 本质上是同一类重复 warning，只保留第一次。
            .replace(/Retry\(total=\d+/g, 'Retry(total=*')
            .trim();
    }

    private collapseBlankLines(lines: string[]): string[] {
        const result: string[] = [];

        for (const line of lines) {
            const isBlank = line.trim().length === 0;
            const previousIsBlank = result.length > 0 && result[result.length - 1].trim().length === 0;

            if (isBlank && previousIsBlank) continue;
            result.push(line);
        }

        while (result.length > 0 && result[0].trim().length === 0) result.shift();
        while (result.length > 0 && result[result.length - 1].trim().length === 0) result.pop();

        return result;
    }

    private failureSummaryFromText(detail: string): string {
        const normalized = detail
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n');

        const tracebackError = this.extractLastTracebackFinalError(normalized);
        if (tracebackError) return tracebackError;

        const lines = normalized
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .filter(line => !this.isFailureNoiseLine(line));

        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const line = lines[i];

            if (this.looksLikeFailureExceptionLine(line)) {
                return this.compactFailureLine(line);
            }
        }

        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const line = lines[i];

            if (this.looksLikeFailureKeywordLine(line)) {
                return this.compactFailureLine(line);
            }
        }

        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const line = lines[i];
            const lower = line.toLowerCase();

            if (!lower.startsWith('file ')
                && !lower.startsWith('traceback ')
                && !lower.startsWith('during handling of the above exception')) {
                return this.compactFailureLine(line);
            }
        }

        return 'Unknown error.';
    }

    private extractLastTracebackFinalError(text: string): string | undefined {
        const lines = text.split('\n');

        let lastTracebackStart = -1;

        for (let i = 0; i < lines.length; i += 1) {
            if (lines[i].trim() === 'Traceback (most recent call last):') {
                lastTracebackStart = i;
            }
        }

        if (lastTracebackStart < 0) return undefined;

        const tracebackBlock: string[] = [];

        for (let i = lastTracebackStart; i < lines.length; i += 1) {
            const line = lines[i].trimEnd();

            if (i > lastTracebackStart && this.isFailureNoiseLine(line.trim())) {
                break;
            }

            tracebackBlock.push(line);
        }

        for (let i = tracebackBlock.length - 1; i >= 0; i -= 1) {
            const line = tracebackBlock[i].trim();
            const lower = line.toLowerCase();

            if (!line) continue;
            if (lower.startsWith('file ')) continue;
            if (lower.startsWith('traceback ')) continue;
            if (lower.startsWith('during handling of the above exception')) continue;
            if (this.isFailureNoiseLine(line)) continue;

            if (this.looksLikeFailureExceptionLine(line) || this.looksLikeFailureKeywordLine(line)) {
                return this.compactFailureLine(line);
            }
        }

        return undefined;
    }

    private looksLikeFailureExceptionLine(line: string): boolean {
        return /^((?:[A-Za-z_][\w]*\.)*[A-Za-z_][\w]*(?:Error|Exception|Timeout|Warning|error):\s*.+)$/i.test(line)
            || /^ERROR:\s*.+$/i.test(line);
    }

    private looksLikeFailureKeywordLine(line: string): boolean {
        return /\b(ENOENT|EACCES|ECONNREFUSED|ECONNRESET|ENOTFOUND|gaierror|ReadTimeoutError|NameResolutionError|ModuleNotFoundError|ImportError|TypeError|ReferenceError|SyntaxError|timed out|timeout|failed|not found|permission denied|nodename nor servname provided)\b/i.test(line);
    }

    private isFailureNoiseLine(line: string): boolean {
        const lower = line.toLowerCase();

        if (/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*\[[^\]]+\]\s*\[(warning|info|debug)\]/i.test(line)) {
            return true;
        }

        if (/^\[\d{4}-\d{2}-\d{2}[^\]]*\]/i.test(line)
            && (lower.includes('[warning]') || lower.includes('[info]') || lower.includes('[debug]'))) {
            return true;
        }

        return lower.includes('urllib3.connectionpool')
            || lower.includes('[warning] retrying')
            || lower.includes('retrying (retry(')
            || lower.includes('sentry.io')
            || lower.includes('/api/5820521/envelope');
    }

    private compactFailureLine(line: string): string {
        const cleaned = line
            .replace(/^pip\._vendor\.urllib3\.exceptions\./, '')
            .replace(/^urllib3\.exceptions\./, '')
            .replace(/\s+/g, ' ')
            .trim();

        return cleaned.length > 900 ? `${cleaned.slice(0, 900).trimEnd()}…` : cleaned;
    }

    private failureInformativeText(error: unknown): string {
        const text = error instanceof Error ? (error.message || error.stack || String(error)) : String(error);
        const runtimeMatch = text.match(/Runtime bootstrap exited early with status (\d+)(?:[.:]\s*\n?\n?([\s\S]*))?/i)
            ?? text.match(/The embedded runtime command exited with status (\d+)(?:[.:]\s*\n?\n?([\s\S]*))?/i);
        if (runtimeMatch) {
            const status = runtimeMatch[1];
            const excerpt = (runtimeMatch[2] ?? '').trim();
            return excerpt.length > 0
                ? `Runtime bootstrap exited early with status ${status}.\n\n${excerpt}`
                : `Runtime bootstrap exited early with status ${status}.`;
        }

        const pythonMatch = text.match(/Python service exited early with status (\d+)(?:[.:]\s*\n?\n?([\s\S]*))?/i);
        if (pythonMatch) {
            const status = pythonMatch[1];
            const excerpt = (pythonMatch[2] ?? '').trim();
            return excerpt.length > 0
                ? `Python service exited early with status ${status}.\n\n${excerpt}`
                : `Python service exited early with status ${status}.`;
        }

        return error instanceof Error ? String(error) : text;
    }

    private async confirmBootstrapDownload(): Promise<boolean> {
        this.refreshVersionReadinessCacheInBackground('before confirmBootstrapDownload');

        const result = await this.showMessageBox({
            type: 'question',
            message: 'Download Required Components?',
            detail: 'This app needs to download or update its embedded Python runtime, Label Studio package, and Electron runtime before it can open.\n\nDo you want to continue now?',
            buttons: ['Continue', 'Cancel'],
            defaultId: 0,
            cancelId: 1
        });
        return result.response === 0;
    }

    private async ensureRequiredRuntime(force = false): Promise<void> {
        this.refreshVersionReadinessCacheInBackground('before ensureRequiredRuntime');

        if (!force && !(await this.needsBundledRuntimeProvisioning())) {
            this.refreshVersionReadinessCacheInBackground('runtime already provisioned');
            return;
        }

        if (!force) {
            const ok = await this.confirmBootstrapDownload();
            if (!ok) {
                this.beginApplicationShutdown();
                throw new Error('Runtime download was cancelled.');
            }
        }

        this.publishLaunchStage(launchStage({
            title: 'Preparing Download',
            detail: 'Starting the runtime and package download workflow.',
            progress: 0
        }), 0);

        this.runtimeBootstrapInProgress = true;
        this.runtimeBootstrapCompleted = false;
        this.versionReadinessCache = {
            usable: false,
            updatedAt: Date.now(),
            reason: 'bootstrap in progress'
        };

        try {
            await this.runtimeBootstrapService.ensureRuntime(BootstrapMode.ensurePackage);
            this.runtimeBootstrapCompleted = true;
            await this.refreshVersionReadinessCacheNow('bootstrap completed');
        } finally {
            this.runtimeBootstrapInProgress = false;
            this.refreshVersionReadinessCacheInBackground('bootstrap finished');
        }
    }

    private isRuntimeMissingError(error: unknown): boolean {
        const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
        return text.includes('Missing runtime') || text.includes('ENOENT') || text.includes('PythonCore') || text.includes('/bin/Python');
    }

    private async needsBundledRuntimeProvisioning(): Promise<boolean> {
        if (!AppPaths.isExecutable(AppPaths.bundledRuntimePython())) {
            return true;
        }

        if (!this.runtimeBootstrapService.hasUsableElectronRuntime()) {
            return true;
        }

        if (!(await this.runtimeBootstrapService.hasValidRuntime())) {
            return true;
        }

        if (!this.bundledRuntimeHasPackageMetadata()) {
            return true;
        }

        if (this.versionReadinessCache?.usable === true) {
            return false;
        }

        if (this.versionReadinessCache?.usable === false && this.versionReadinessCache.reason.includes('missing')) {
            return true;
        }

        this.refreshVersionReadinessCacheInBackground('needsBundledRuntimeProvisioning cache miss');
        return false;
    }

    private async hasUsableEmbeddedRuntimeAndPackage(): Promise<boolean> {
        const bundledRuntimePython = AppPaths.bundledRuntimePython();

        if (!AppPaths.isExecutable(bundledRuntimePython)) {
            this.versionReadinessCache = {
                usable: false,
                updatedAt: Date.now(),
                reason: 'bundled Python missing'
            };
            return false;
        }

        if (this.runtimeBootstrapInProgress && !this.runtimeBootstrapCompleted) {
            return false;
        }

        this.refreshVersionReadinessCacheInBackground('hasUsableEmbeddedRuntimeAndPackage');

        return this.versionReadinessCache?.usable === true || this.bundledRuntimeHasPackageMetadata();
    }

    private bundledRuntimeHasPackageMetadata(): boolean {
        for (const sitePackages of this.sitePackagesDirectories(AppPaths.bundledRuntimeRoot())) {
            if (!fs.existsSync(sitePackages)) continue;

            let entries: string[];
            try {
                entries = fs.readdirSync(sitePackages);
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (!/^label[-_.]studio-[^-]+\.dist-info$/i.test(entry)) continue;
                if (this.packageMetadataIsLabelStudio(path.join(sitePackages, entry, 'METADATA'))) return true;
            }
        }

        return false;
    }

    private packageMetadataIsLabelStudio(metadataPath: string): boolean {
        try {
            const text = fs.readFileSync(metadataPath, 'utf8');
            const name = text.match(/^Name:\s*(.+)$/mi)?.[1]?.trim().toLowerCase();
            const version = text.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
            return name === 'label-studio' && Boolean(version);
        } catch {
            return false;
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

    private markVersionReadinessCacheDirty(reason: string): void {
        this.versionReadinessCache = undefined;
        this.refreshVersionReadinessCacheInBackground(reason);
    }

    private refreshVersionReadinessCacheInBackground(reason: string): void {
        if (this.versionReadinessRefreshPromise) return;

        this.versionReadinessRefreshPromise = this.refreshVersionReadinessCacheNow(reason)
            .catch(error => {
                this.versionReadinessCache = {
                    usable: false,
                    updatedAt: Date.now(),
                    reason,
                    errorText: this.errorText(error)
                };
            })
            .finally(() => {
                this.versionReadinessRefreshPromise = undefined;
            });
    }

    private async refreshVersionReadinessCacheNow(reason: string): Promise<void> {
        if (this.runtimeBootstrapInProgress && !this.runtimeBootstrapCompleted) {
            this.versionReadinessCache = {
                usable: false,
                updatedAt: Date.now(),
                reason: `${reason}: bootstrap in progress`
            };
            return;
        }

        const bundledRuntimePython = AppPaths.bundledRuntimePython();
        if (!AppPaths.isExecutable(bundledRuntimePython)) {
            this.versionReadinessCache = {
                usable: false,
                updatedAt: Date.now(),
                reason: `${reason}: bundled Python missing`
            };
            return;
        }

        const versions = await this.runtimeBootstrapService.fetchVersions();
        this.updateVersionReadinessCacheFromVersions(versions, reason);
    }

    private updateVersionReadinessCacheFromVersions(versions: RuntimeVersionSnapshot, reason: string): void {
        const hasPackage = Boolean(versions.packageVersion)
            && versions.packageVersion !== 'Not installed'
            && versions.packageVersion !== 'Unknown';

        const hasPython = Boolean(versions.pythonVersion)
            && versions.pythonVersion !== 'Not installed'
            && versions.pythonVersion !== 'Unknown';

        this.versionReadinessCache = {
            usable: hasPackage && hasPython && this.runtimeBootstrapService.hasUsableElectronRuntime(),
            versions,
            updatedAt: Date.now(),
            reason
        };
    }

    private errorText(error: unknown): string {
        return error instanceof Error ? (error.message || error.stack || String(error)) : String(error);
    }

    private buildMainMenu(): void {
        const appName = AppDisplayName;
        const web = (): Electron.WebContents | undefined => {
            if (!this.mainWindow || this.mainWindow.isDestroyed()) return undefined;
            return this.mainWindow.webContents;
        };
        const edit = (name: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll'): void => {
            const contents = web() as (Electron.WebContents & Record<string, () => void>) | undefined;
            contents?.[name]?.();
        };
        const adjustZoom = (delta: number): void => {
            const contents = web();
            if (!contents) return;
            contents.setZoomLevel(contents.getZoomLevel() + delta);
        };

        const template: Electron.MenuItemConstructorOptions[] = [
            {
                label: appName,
                submenu: [
                    { label: 'Check for Updates', accelerator: 'CommandOrControl+U', click: () => this.updateWindowController.presentWindow() },
                    { type: 'separator' },
                    { label: 'Clear HTTP Cache', click: () => { void this.clearHTTPCache(); } },
                    { label: 'Clear Cookies', click: () => { void this.clearCookies(); } },
                    { type: 'separator' },
                    { label: `Hide ${appName}`, accelerator: 'Command+H', role: 'hide' },
                    { label: 'Hide Others', accelerator: 'Command+Alt+H', role: 'hideOthers' },
                    { label: 'Show All', role: 'unhide' },
                    { type: 'separator' },
                    { label: `Quit ${appName}`, accelerator: 'Command+Q', role: 'quit' },
                ],
            },
            {
                label: 'Edit',
                submenu: [
                    { label: 'Undo', accelerator: 'CommandOrControl+Z', click: () => edit('undo') },
                    { label: 'Redo', accelerator: 'CommandOrControl+Shift+Z', click: () => edit('redo') },
                    { type: 'separator' },
                    { label: 'Cut', accelerator: 'CommandOrControl+X', click: () => edit('cut') },
                    { label: 'Copy', accelerator: 'CommandOrControl+C', click: () => edit('copy') },
                    { label: 'Paste', accelerator: 'CommandOrControl+V', click: () => edit('paste') },
                    { label: 'Delete', accelerator: process.platform === 'darwin' ? 'Command+Backspace' : 'Control+Backspace', click: () => edit('delete') },
                    { type: 'separator' },
                    { label: 'Select All', accelerator: 'CommandOrControl+A', click: () => edit('selectAll') },
                ],
            },
            {
                label: 'Navigation',
                submenu: [
                    { label: 'Back', accelerator: 'CommandOrControl+[', click: () => { const c = web(); if (c?.canGoBack()) c.goBack(); } },
                    { label: 'Forward', accelerator: 'CommandOrControl+]', click: () => { const c = web(); if (c?.canGoForward()) c.goForward(); } },
                    { type: 'separator' },
                    { label: 'Reload', accelerator: 'CommandOrControl+R', click: () => web()?.reload() },
                    { label: 'Reload Ignoring Cache', accelerator: 'CommandOrControl+Shift+R', click: () => web()?.reloadIgnoringCache() },
                    { label: 'Stop', accelerator: 'CommandOrControl+.', click: () => web()?.stop() },
                ],
            },
            {
                label: 'View',
                submenu: [
                    { label: 'Zoom In', accelerator: process.platform === 'darwin' ? 'Command+Plus' : 'Control+Plus', click: () => adjustZoom(1) },
                    { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: () => adjustZoom(-1) },
                    { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: () => web()?.setZoomLevel(0) },
                    { type: 'separator' },
                    { label: 'Enter Full Screen', accelerator: process.platform === 'darwin' ? 'Ctrl+Command+F' : 'F11', click: () => this.mainWindow?.setFullScreen(!this.mainWindow.isFullScreen()) },
                    { type: 'separator' },
                    { label: 'Toggle Developer Tools', accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I', click: () => web()?.toggleDevTools() },
                ],
            },
        ];
        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }

    private async clearHTTPCache(): Promise<void> {
        const targetSession = this.mainWindow && !this.mainWindow.isDestroyed()
            ? this.mainWindow.webContents.session
            : session.defaultSession;
        await targetSession.clearCache();
    }

    private async clearCookies(): Promise<void> {
        const targetSession = this.mainWindow && !this.mainWindow.isDestroyed()
            ? this.mainWindow.webContents.session
            : session.defaultSession;
        await targetSession.clearStorageData({ storages: ['cookies'] });
    }

    beginApplicationShutdown(): void {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        this.stop();
        app.quit();
    }

    prepareApplicationQuit(): void {
        this.isShuttingDown = true;
        this.stop();
    }

    focusMainWindow(): void {
        if (!this.mainWindow) return;
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.focus();
    }

    stop(): void {
        this.pythonService.stop();
        this.runtimeBootstrapService.stop();
        if (this.splashWindow && !this.splashWindow.isDestroyed()) {
            this.splashWindow.close();
            this.splashWindow = undefined;
        }
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.close();
            this.mainWindow = undefined;
        }
    }
}

const ElectronUpdateGuardFreshMs = 10 * 60 * 1000;

function appendElectronUpdateLog(message: string): void {
    try {
        fs.appendFileSync(AppPaths.electronUpdateApplyLogFile(), `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch {
        // Startup protection must never fail because logging is unavailable.
    }
}

function existingElectronUpdateMarkers(): string[] {
    return [AppPaths.electronUpdateApplyingMarker(), AppPaths.electronUpdatePendingMarker()]
        .filter(marker => fs.existsSync(marker));
}

function removeElectronUpdateMarkers(markers: string[]): void {
    for (const marker of markers) {
        try {
            fs.rmSync(marker, { force: true });
        } catch {
            // Ignore stale marker cleanup failures.
        }
    }
}

function quitIfElectronRuntimeUpdateInProgress(): boolean {
    const markers = existingElectronUpdateMarkers();
    if (markers.length === 0) return false;

    const newestMarkerTime = Math.max(...markers.map(marker => {
        try {
            return fs.statSync(marker).mtimeMs;
        } catch {
            return 0;
        }
    }));
    const markerAge = Date.now() - newestMarkerTime;
    if (!Number.isFinite(markerAge) || markerAge > ElectronUpdateGuardFreshMs) {
        appendElectronUpdateLog(`Ignoring stale Electron update markers during startup. ageMs=${markerAge}`);
        removeElectronUpdateMarkers(markers);
        return false;
    }

    appendElectronUpdateLog(`Startup blocked while Electron runtime update is pending. markers=${markers.join(', ')}`);
    const exitFallback = setTimeout(() => app.exit(0), 1200);
    exitFallback.unref?.();
    void dialog.showMessageBox({
        type: 'info',
        message: 'Electron Update Installing',
        detail: 'Label Studio is finishing an Electron runtime update and will quit now. Open it again in a few seconds.',
        buttons: ['Quit'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
    }).finally(() => {
        clearTimeout(exitFallback);
        app.exit(0);
    });
    return true;
}

process.title = AppDisplayName;
app.setName(AppDisplayName);
if (process.platform === 'win32') {
    app.setAppUserModelId(AppDisplayName);
} else if (process.platform === 'darwin') {
    const dockIconPath = resolveAppIconPath();
    try {
        if (dockIconPath && app.dock) app.dock.setIcon(dockIconPath);
    } catch (error) {
        console.warn('[app] failed to set dock icon:', error);
    }
}
app.setPath('userData', path.join(app.getPath('appData'), AppPaths.appSupportDirectoryName()));

const gotLock = app.requestSingleInstanceLock();
let delegate: AppDelegate | undefined;

if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => delegate?.focusMainWindow());
    app.on('activate', () => delegate?.focusMainWindow());
    app.whenReady().then(async () => {
        app.setAccessibilitySupportEnabled(true);
        if (quitIfElectronRuntimeUpdateInProgress()) return;
        globalThis.sharedStore = new JsonStore(path.join(app.getPath('userData'), 'preferences.json'));
        delegate = new AppDelegate();
        await delegate.applicationDidFinishLaunching();
    }).catch(error => {
        console.error(error);
        app.quit();
    });
    app.on('window-all-closed', () => { app.quit(); });
    app.on('before-quit', () => delegate?.prepareApplicationQuit());
}
