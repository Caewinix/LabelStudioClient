import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AppPaths } from './appPaths';
import { LaunchStep, LaunchStage, launchStage } from './launchModels';
import { LineAccumulator } from './lineAccumulator';

interface LauncherEvent {
  event: string;
  url?: string;
  pid?: number;
}

export type PythonServiceErrorKind = 'missingRuntime' | 'missingLauncher' | 'invalidListeningURL' | 'startupTimedOut' | 'exitedEarly';

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

  static exitedEarly(status: number, excerpt: string): PythonServiceError {
    return new PythonServiceError('exitedEarly', `Python service exited early with status ${status}.
${excerpt}`, { status, excerpt });
  }
}

export class PythonService extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private stdoutAccumulator = new LineAccumulator();
  private stderrAccumulator = new LineAccumulator();
  private recentOutput: string[] = [];
  private timeout?: NodeJS.Timeout;
  private readinessAbort?: AbortController;

  async start(): Promise<string> {
    const pythonURL = AppPaths.runtimePython();
    const launcherURL = AppPaths.launcherScript();

    if (!AppPaths.isExecutable(pythonURL)) throw PythonServiceError.missingRuntime(pythonURL);
    if (!fs.existsSync(launcherURL)) throw PythonServiceError.missingLauncher(launcherURL);

    const dataDirectory = AppPaths.dataDirectory();
    fs.mkdirSync(dataDirectory, { recursive: true });

    this.emitStage(launchStage({
      title: LaunchStep.localService.title,
      detail: 'Launching the local Label Studio web service.',
      progress: 0
    }));

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
        cwd: path.dirname(pythonURL),
        env: AppPaths.makePythonEnvironment()
      });

      this.process.stdout.on('data', data => this.handleOutput(Buffer.from(data), this.stdoutAccumulator, succeed, fail));
      this.process.stderr.on('data', data => this.handleOutput(Buffer.from(data), this.stderrAccumulator, succeed, fail));
      this.process.on('error', error => {
        this.detachProcessHandlers();
        fail(error);
      });
      this.process.on('exit', code => {
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

  stop(): void {
    this.clearStartupTimers();
    if (!this.process) return;
    const proc = this.process;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGINT');
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    }, 5_000);
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
