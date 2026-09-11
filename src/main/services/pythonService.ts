import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { AppPaths } from './appPaths';
import { LaunchStep, LaunchStage, launchStage } from './launchModels';
import { LineAccumulator } from './lineAccumulator';

interface LauncherEvent {
    event: string;
    url?: string;
    pid?: number;
}

export type PythonServiceErrorKind = 'missingRuntime' | 'missingLauncher' | 'invalidListeningURL' | 'startupTimedOut' | 'stopTimedOut' | 'exitedEarly';

export class PythonServiceError extends Error {
    constructor(
        readonly kind: PythonServiceErrorKind,
        message: string,
        readonly payload?: { url?: string; status?: number; excerpt?: string }
    ) {
        super(message);
        this.name = 'PythonServiceError';
    }

    static missingRuntime(url: string): PythonServiceError {
        return new PythonServiceError('missingRuntime', `Embedded Python runtime is missing at ${url}.`, { url });
    }

    static missingLauncher(url: string): PythonServiceError {
        return new PythonServiceError('missingLauncher', `Label Studio launcher is missing at ${url}.`, { url });
    }

    static invalidListeningURL(url: string): PythonServiceError {
        return new PythonServiceError('invalidListeningURL', `Invalid listening URL: ${url}`, { url });
    }

    static startupTimedOut(): PythonServiceError {
        return new PythonServiceError('startupTimedOut', 'Python service startup timed out.');
    }

    static stopTimedOut(): PythonServiceError {
        return new PythonServiceError('stopTimedOut', 'Python service did not stop.');
    }

    static exitedEarly(status: number, excerpt: string): PythonServiceError {
        return new PythonServiceError('exitedEarly', `Python service exited early with status ${status}.
${excerpt}`, { status, excerpt });
    }
}

export class PythonService extends EventEmitter {
    private process?: ChildProcessWithoutNullStreams;
    private serviceProcessId?: number;
    private runtimeReplacementPending = false;
    private stdoutAccumulator = new LineAccumulator();
    private stderrAccumulator = new LineAccumulator();
    private recentOutput: string[] = [];
    private timeout?: NodeJS.Timeout;
    private readinessAbort?: AbortController;

    async start(): Promise<string> {
        if (this.runtimeReplacementPending) {
            throw new Error('The Python service cannot start while managed runtime files are being replaced.');
        }
        const pythonURL = AppPaths.runtimePython();
        const launcherURL = AppPaths.launcherScript();

        if (!AppPaths.isExecutable(pythonURL)) throw PythonServiceError.missingRuntime(pythonURL);
        if (!fs.existsSync(launcherURL)) throw PythonServiceError.missingLauncher(launcherURL);

        const dataDirectory = AppPaths.dataDirectory();
        await fs.promises.mkdir(dataDirectory, { recursive: true });

        this.emitStage(launchStage({
            title: LaunchStep.localService.title,
            detail: 'Launching the local Label Studio web service.',
            progress: 0
        }));

        this.serviceProcessId = undefined;

        return new Promise<string>((resolve, reject) => {
            let settled = false;
            const fail = (error: Error): void => {
                if (settled) return;
                settled = true;
                this.clearStartupTimers();
                reject(error);
            };
            const succeed = (url: string): void => {
                if (settled) return;
                settled = true;
                this.clearStartupTimers();
                resolve(url);
            };

            this.process = spawn(pythonURL, [
                launcherURL,
                '--host', '127.0.0.1',
                '--data-dir', dataDirectory,
                '--log-level', 'INFO'
            ], {
                cwd: AppPaths.pythonWorkingDirectory(),
                env: AppPaths.makePythonEnvironment()
            });

            this.process.stdout.on('data', data => this.handleOutput(Buffer.from(data), this.stdoutAccumulator, succeed, fail));
            this.process.stderr.on('data', data => this.handleOutput(Buffer.from(data), this.stderrAccumulator, succeed, fail));
            this.process.on('error', error => {
                void this.terminateOrphanedWindowsServiceProcess();
                this.detachProcessHandlers();
                fail(error);
            });
            this.process.on('exit', code => {
                void this.terminateOrphanedWindowsServiceProcess();
                this.detachProcessHandlers();
                if (!settled) {
                    const excerpt = this.recentOutput.slice(-12).join('\n');
                    fail(PythonServiceError.exitedEarly(code ?? -1, excerpt));
                }
            });

            this.timeout = setTimeout(() => {
                this.stop();
                fail(PythonServiceError.startupTimedOut());
            }, 90_000);
        });
    }

    suspendStartsForRuntimeReplacement(): void {
        this.runtimeReplacementPending = true;
    }

    resumeStartsAfterRuntimeReplacement(): void {
        this.runtimeReplacementPending = false;
    }

    stop(): void {
        this.clearStartupTimers();
        const proc = this.process;
        if (process.platform === 'win32') {
            void this.terminateWindowsProcessTrees(proc);
            return;
        }
        if (!proc) return;
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        proc.kill('SIGINT');
        setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
        }, 5_000);
    }

    async stopAndWait(): Promise<void> {
        this.clearStartupTimers();
        const proc = this.process;
        if (!proc) {
            if (process.platform === 'win32') await this.terminateWindowsProcessTrees();
            return;
        }

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(forceTimer);
                clearTimeout(giveUpTimer);
                proc.off('close', finish);
                if (this.process === proc) this.process = undefined;
                resolve();
            };
            const fail = (error: Error): void => {
                if (settled) return;
                settled = true;
                clearTimeout(forceTimer);
                clearTimeout(giveUpTimer);
                proc.off('close', finish);
                reject(error);
            };
            const forceTimer = setTimeout(() => {
                if (proc.exitCode === null && proc.signalCode === null) {
                    if (process.platform === 'win32') {
                        void this.terminateWindowsProcessTrees(proc).catch(fail);
                    }
                    else {
                        try { proc.kill('SIGTERM'); } catch { /* best effort */ }
                    }
                }
            }, 5_000);
            const giveUpTimer = setTimeout(() => fail(PythonServiceError.stopTimedOut()), 15_000);

            forceTimer.unref?.();
            giveUpTimer.unref?.();
            proc.once('close', finish);

            if (process.platform === 'win32') {
                void this.terminateWindowsProcessTrees(proc).then(() => {
                    if (proc.stdout.destroyed && proc.stderr.destroyed) finish();
                }, fail);
            } else {
                if (proc.stdout.destroyed && proc.stderr.destroyed) {
                    finish();
                    return;
                }
                try {
                    proc.kill('SIGINT');
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            }
        });
    }

    private async terminateOrphanedWindowsServiceProcess(): Promise<void> {
        if (process.platform !== 'win32' || !this.serviceProcessId) return;
        await this.terminateWindowsProcessTree(this.serviceProcessId);
        this.serviceProcessId = undefined;
    }

    private async terminateWindowsProcessTrees(proc = this.process): Promise<void> {
        if (process.platform !== 'win32') return;

        const processIds = new Set<number>();
        if (proc?.pid) processIds.add(proc.pid);
        if (this.serviceProcessId) processIds.add(this.serviceProcessId);

        await Promise.all([...processIds].map(async (processId) => await this.terminateWindowsProcessTree(processId)));
        this.serviceProcessId = undefined;
    }

    private async terminateWindowsProcessTree(processId: number): Promise<void> {
        const terminated = await new Promise<boolean>((resolve) => {
            const child = spawn('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore'
            });
            child.once('error', () => resolve(false));
            child.once('close', status => resolve(status === 0));
        });
        if (terminated) return;

        if (this.process?.pid === processId && this.process.exitCode === null && this.process.signalCode === null) {
            try { this.process.kill('SIGTERM'); } catch { /* best effort */ }
        }
    }

    private clearStartupTimers(): void {
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = undefined;
        this.readinessAbort?.abort();
        this.readinessAbort = undefined;
    }

    private detachProcessHandlers(): void {
        if (!this.process) return;
        this.process.stdout.removeAllListeners('data');
        this.process.stderr.removeAllListeners('data');
    }

    private handleOutput(
        data: Buffer,
        accumulator: LineAccumulator,
        succeed: (url: string) => void,
        fail: (error: Error) => void
    ): void {
        for (const line of accumulator.append(data)) {
            this.appendRecentOutput(line);
            this.updateStageIfPossible(line);
            void this.parseEventIfPossible(line, succeed, fail);
        }
    }

    private appendRecentOutput(line: string): void {
        this.recentOutput.push(line);
        if (this.recentOutput.length > 40) this.recentOutput.splice(0, this.recentOutput.length - 40);
    }

    private updateStageIfPossible(line: string): void {
        let stage: LaunchStage | undefined;
        if (line.includes('"event": "listening"') || line.includes('"event":"listening"')) {
            stage = LaunchStep.localService;
        }
        if (stage) this.emitStage(stage);
    }

    private async parseEventIfPossible(
        line: string,
        succeed: (url: string) => void,
        fail: (error: Error) => void
    ): Promise<void> {
        if (!line.startsWith('{')) return;
        let event: LauncherEvent;
        try { event = JSON.parse(line) as LauncherEvent; } catch { return; }
        if (event.event !== 'listening' || !event.url) return;
        if (Number.isSafeInteger(event.pid) && Number(event.pid) > 0) {
            this.serviceProcessId = Number(event.pid);
        }

        try { new URL(event.url); } catch { fail(PythonServiceError.invalidListeningURL(event.url)); return; }

        this.emitStage(launchStage({
            title: LaunchStep.localService.title,
            detail: 'Waiting for the local web service to accept browser requests.',
            progress: 0.6
        }));

        const isReady = await this.waitForHTTPReadiness(event.url);
        if (isReady) {
            this.emitStage(launchStage({
                title: LaunchStep.localService.title,
                detail: 'Local service is ready. Opening the workspace.',
                progress: 1
            }));
            succeed(event.url);
        } else {
            this.stop();
            fail(PythonServiceError.startupTimedOut());
        }
    }

    private async waitForHTTPReadiness(baseURL: string): Promise<boolean> {
        const abort = new AbortController();
        this.readinessAbort = abort;
        const deadline = Date.now() + 20_000;
        const endpoints = [this.loginURL(baseURL), baseURL];

        while (!abort.signal.aborted && Date.now() < deadline) {
            for (const endpoint of endpoints) {
                if (await this.canReachHTTP(endpoint, abort.signal)) return true;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return false;
    }

    private async canReachHTTP(url: string, signal: AbortSignal): Promise<boolean> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2_000);
        const onAbort = (): void => controller.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            await fetch(url, { method: 'GET', cache: 'no-store', signal: controller.signal });
            return true;
        } catch {
            return false;
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', onAbort);
        }
    }

    private loginURL(baseURL: string): string {
        const url = new URL(baseURL);
        url.pathname = '/user/login/';
        url.search = '';
        url.hash = '';
        return url.toString();
    }

    private emitStage(stage: LaunchStage): void {
        this.emit('stage', stage);
    }
}
