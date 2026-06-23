import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface DownloadProgress {
  readonly fraction: number;
  readonly receivedBytes: number;
  readonly expectedBytes?: number;
  readonly bytesPerSecond?: number;
}

export type DownloadResult = 'completed' | 'skipped';

type HeaderValue = string | string[] | number | undefined;

export class ManagedDownloadTask {
  private request?: http.ClientRequest;
  private response?: http.IncomingMessage;
  private file?: fs.WriteStream;
  private paused = false;
  private completed = false;
  private cancelledForSkip = false;
  private receivedBytes = 0;
  private expectedBytes?: number;
  private lastReportedProgress = -1;
  private lastSpeedSampleTime = Date.now();
  private lastSpeedSampleBytes = 0;
  private currentBytesPerSecond?: number;
  private readonly tempPath: string;
  private requestOpened = false;
  private pauseAbortActive = false;
  private resolve?: (value: DownloadResult) => void;
  private reject?: (reason?: unknown) => void;

  constructor(
    private sourceURL: string,
    private readonly destination: string,
    private readonly expectedByteCount: number | undefined,
    private readonly onProgress: (progress: DownloadProgress) => void
  ) {
    this.expectedBytes = expectedByteCount;
    this.tempPath = `${destination}.download`;
  }

  start(startPaused: boolean): Promise<DownloadResult> {
    return new Promise<DownloadResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.paused = startPaused;
      this.completed = false;
      this.cancelledForSkip = false;
      this.pauseAbortActive = false;
      this.requestOpened = false;
      this.refreshPartialState();
      this.reportCurrentProgress();

      // Swift URLSessionDownloadTask is created but not resumed when
      // startPaused is true. Do the same here: no network activity starts until
      // resumeIfPaused()/togglePause() clears the paused state.
      if (!this.paused) void this.prepareAndOpenRequest();
    });
  }

  private async prepareAndOpenRequest(): Promise<void> {
    if (this.completed || this.requestOpened) return;
    this.pauseAbortActive = false;
    this.requestOpened = true;

    try {
      this.refreshPartialState();
      if (this.expectedBytes == null || this.expectedBytes <= 0) {
        const length = await this.fetchContentLength(this.sourceURL);
        if (length != null && length > 0) this.expectedBytes = length;
      }

      if (this.paused) {
        // If the user pauses while the best-effort HEAD request is still in
        // flight, do not continue into the GET request. Wait until resume.
        this.requestOpened = false;
        this.reportCurrentProgress();
        return;
      }
    } catch {
      // Content-Length is best-effort. If HEAD fails, GET can still provide
      // Content-Length or Content-Range; otherwise progress uses an unknown-size
      // estimator. Do not fail the download solely because HEAD failed.
    }

    if (!this.paused) await this.openRequest();
    else this.requestOpened = false;
  }

  togglePause(): boolean {
    if (this.completed) return false;
    if (this.paused) {
      this.paused = false;
      this.resumeAfterPause();
      return false;
    }
    this.paused = true;
    this.abortNetworkForPause();
    return true;
  }

  pause(): boolean {
    if (this.completed) return false;
    this.paused = true;
    this.abortNetworkForPause();
    return true;
  }

  resumeIfPaused(): void {
    if (this.completed || !this.paused) return;
    this.paused = false;
    this.resumeAfterPause();
  }

  private resumeAfterPause(): void {
    this.pauseAbortActive = false;
    this.requestOpened = false;
    this.request = undefined;
    this.response = undefined;
    this.file = undefined;
    this.refreshPartialState();
    this.resetSpeedSampler(this.receivedBytes);
    this.reportCurrentProgress();
    void this.prepareAndOpenRequest();
  }

  private abortNetworkForPause(): void {
    if (this.completed) return;
    this.pauseAbortActive = true;

    try { this.response?.destroy(); } catch { /* best effort */ }
    try { this.request?.destroy(); } catch { /* best effort */ }
    try { this.file?.close(); } catch { /* best effort */ }

    this.request = undefined;
    this.response = undefined;
    this.file = undefined;
    this.requestOpened = false;

    // Important: do NOT delete this.tempPath here. Pause must stop all network
    // activity but keep the partially downloaded bytes so resume can continue
    // with HTTP Range when the server supports it.
    this.refreshPartialState();
    this.resetSpeedSampler(this.receivedBytes);
    this.reportCurrentProgress();
  }

  cancelForSkip(): void {
    if (this.completed) return;
    this.cancelledForSkip = true;
    this.pauseAbortActive = false;
    this.paused = false;
    try { this.response?.resume(); } catch { /* best effort */ }
    try { this.request?.destroy(); } catch { /* best effort */ }
    try { this.file?.destroy(); } catch { /* best effort */ }
    this.removeTemporaryFile();
    this.finishSuccess('skipped');
  }

  cancelForShutdown(): void {
    if (this.completed) return;
    this.cancelledForSkip = true;
    this.pauseAbortActive = false;
    this.paused = false;
    try { this.response?.resume(); } catch { /* best effort */ }
    try { this.request?.destroy(); } catch { /* best effort */ }
    try { this.file?.destroy(); } catch { /* best effort */ }
    this.finishSuccess('skipped');
  }

  private async fetchContentLength(sourceURL: string, redirectCount = 0): Promise<number | undefined> {
    return await new Promise<number | undefined>((resolve, reject) => {
      try {
        if (this.paused || this.completed) {
          resolve(undefined);
          return;
        }

        const parsed = new URL(sourceURL);
        const client = parsed.protocol === 'https:' ? https : http;
        const request = client.request(parsed, {
          method: 'HEAD',
          headers: {
            'User-Agent': 'Label-Studio-Electron-ManagedDownloader',
            'Cache-Control': 'no-cache',
            'Accept-Encoding': 'identity'
          }
        }, response => {
          if (this.paused && this.pauseAbortActive) {
            response.resume();
            resolve(undefined);
            return;
          }

          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          response.resume();
          if ([301, 302, 303, 307, 308].includes(status) && location) {
            if (redirectCount >= 8) {
              reject(new Error(`Too many redirects while checking size for ${sourceURL}`));
              return;
            }
            const redirected = new URL(location, sourceURL).toString();
            this.fetchContentLength(redirected, redirectCount + 1).then(resolve, reject);
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status} while checking size for ${sourceURL}`));
            return;
          }
          const contentLength = this.numberHeader(response.headers['content-length']);
          resolve(contentLength != null && contentLength > 0 ? contentLength : undefined);
        });
        this.request = request;
        request.on('error', error => {
          if (this.paused && this.pauseAbortActive) {
            resolve(undefined);
            return;
          }
          reject(error);
        });
        request.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  private async openRequest(redirectCount = 0): Promise<void> {
    try {
      if (this.completed || this.paused) {
        this.requestOpened = false;
        return;
      }

      fs.mkdirSync(path.dirname(this.destination), { recursive: true });
      this.refreshPartialState();
      const resumeOffset = this.receivedBytes;
      const parsed = new URL(this.sourceURL);
      const client = parsed.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = {
        'User-Agent': 'Label-Studio-Electron-ManagedDownloader',
        'Cache-Control': 'no-cache',
        'Accept-Encoding': 'identity'
      };
      if (resumeOffset > 0) headers.Range = `bytes=${resumeOffset}-`;

      const request = client.get(parsed, { headers });
      this.request = request;
      request.on('response', response => {
        this.response = response;
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume();
          if (redirectCount >= 8) {
            this.finishFailure(new Error(`Too many redirects while downloading ${this.sourceURL}`));
            return;
          }
          const redirected = new URL(location, this.sourceURL).toString();
          this.sourceURL = redirected;
          this.request = undefined;
          this.response = undefined;
          void this.openRequest(redirectCount + 1);
          return;
        }

        if (status === 416) {
          // The partial file is probably complete or invalid for the current
          // remote object. If it is complete according to expectedBytes, promote
          // it; otherwise clear it and retry from zero.
          response.resume();
          if (this.expectedBytes != null && resumeOffset >= this.expectedBytes && fs.existsSync(this.tempPath)) {
            this.promoteTemporaryFile();
            return;
          }
          this.removeTemporaryFile();
          this.receivedBytes = 0;
          this.resetSpeedSampler(0);
          this.request = undefined;
          this.response = undefined;
          void this.openRequest(redirectCount);
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          this.finishFailure(new Error(`HTTP ${status} while downloading ${this.sourceURL}`));
          return;
        }

        let appendMode = false;
        if (resumeOffset > 0) {
          if (status === 206) {
            appendMode = true;
            const total = this.totalBytesFromContentRange(response.headers['content-range']);
            if (total != null && total > 0) this.expectedBytes = total;
          } else {
            // Server ignored Range and returned a full response. Start over.
            this.removeTemporaryFile();
            this.receivedBytes = 0;
            this.resetSpeedSampler(0);
          }
        }

        const contentLength = this.numberHeader(response.headers['content-length']);
        if (contentLength != null && contentLength > 0) {
          this.expectedBytes = appendMode ? resumeOffset + contentLength : contentLength;
        }
        if (this.expectedByteCount && this.expectedByteCount > 0) this.expectedBytes = this.expectedByteCount;

        const file = fs.createWriteStream(this.tempPath, { flags: appendMode ? 'a' : 'w' });
        this.file = file;
        this.reportCurrentProgress();

        response.on('data', (chunk: Buffer) => {
          if (this.paused && this.pauseAbortActive) return;
          this.receivedBytes += chunk.length;
          file.write(chunk);
          this.reportProgress(
            this.expectedBytes && this.expectedBytes > 0
              ? Math.max(0, Math.min(1, this.receivedBytes / this.expectedBytes))
              : this.estimatedProgress(this.receivedBytes),
            this.receivedBytes,
            this.expectedBytes,
            this.speedSample(this.receivedBytes)
          );
        });

        response.on('end', () => {
          if (this.paused && this.pauseAbortActive) return;
          file.end(() => {
            if (this.cancelledForSkip || this.completed) return;
            this.promoteTemporaryFile();
          });
        });

        response.on('error', error => {
          if (this.paused && this.pauseAbortActive) return;
          this.finishFailure(error);
        });
        file.on('error', error => {
          if (this.paused && this.pauseAbortActive) return;
          this.finishFailure(error);
        });
        if (this.paused) this.abortNetworkForPause();
      });

      request.on('error', error => {
        if (this.cancelledForSkip) return;
        if (this.paused && this.pauseAbortActive) return;
        this.finishFailure(error);
      });
    } catch (error) {
      this.finishFailure(error);
    }
  }

  private promoteTemporaryFile(): void {
    try {
      if (fs.existsSync(this.destination)) fs.rmSync(this.destination, { force: true });
      fs.renameSync(this.tempPath, this.destination);
      const expected = this.expectedBytes ?? this.receivedBytes;
      this.reportProgress(1, this.receivedBytes, expected, this.currentBytesPerSecond);
      this.finishSuccess('completed');
    } catch (error) {
      this.finishFailure(error);
    }
  }

  private refreshPartialState(): void {
    try {
      this.receivedBytes = fs.existsSync(this.tempPath) ? fs.statSync(this.tempPath).size : 0;
    } catch {
      this.receivedBytes = 0;
    }
  }

  private resetSpeedSampler(receivedBytes: number): void {
    this.lastSpeedSampleTime = Date.now();
    this.lastSpeedSampleBytes = receivedBytes;
    this.currentBytesPerSecond = undefined;
  }

  private reportCurrentProgress(): void {
    this.reportProgress(
      this.expectedBytes && this.expectedBytes > 0
        ? Math.max(0, Math.min(1, this.receivedBytes / this.expectedBytes))
        : this.estimatedProgress(this.receivedBytes),
      this.receivedBytes,
      this.expectedBytes,
      this.currentBytesPerSecond
    );
  }

  private reportProgress(fraction: number, receivedBytes: number, expectedBytes: number | undefined, bytesPerSecond: number | undefined): void {
    const normalized = Math.max(0, Math.min(1, fraction));
    const shouldReport = normalized >= 1 || this.lastReportedProgress < 0 || Math.abs(normalized - this.lastReportedProgress) >= 0.005;
    if (!shouldReport) return;
    this.lastReportedProgress = normalized;
    this.onProgress({ fraction: normalized, receivedBytes, expectedBytes, bytesPerSecond });
  }

  private estimatedProgress(bytes: number): number {
    if (bytes <= 0) return 0;
    const megabytes = bytes / 1_048_576;
    return Math.min(0.95, 1 - Math.pow(0.86, megabytes));
  }

  private speedSample(receivedBytes: number): number | undefined {
    const now = Date.now();
    const elapsed = (now - this.lastSpeedSampleTime) / 1000;
    if (elapsed < 0.45) return this.currentBytesPerSecond;
    const delta = receivedBytes - this.lastSpeedSampleBytes;
    this.lastSpeedSampleTime = now;
    this.lastSpeedSampleBytes = receivedBytes;
    if (delta <= 0) return this.currentBytesPerSecond;
    const instantSpeed = delta / elapsed;
    this.currentBytesPerSecond = this.currentBytesPerSecond == null
      ? instantSpeed
      : (this.currentBytesPerSecond * 0.65) + (instantSpeed * 0.35);
    return this.currentBytesPerSecond;
  }

  private finishSuccess(result: DownloadResult): void {
    if (this.completed) return;
    this.completed = true;
    this.requestOpened = false;
    this.request = undefined;
    this.response = undefined;
    this.file = undefined;
    this.resolve?.(result);
  }

  private finishFailure(error: unknown): void {
    if (this.completed) return;
    this.completed = true;
    this.requestOpened = false;
    this.removeTemporaryFile();
    this.reject?.(error);
  }

  private removeTemporaryFile(): void {
    try { if (fs.existsSync(this.tempPath)) fs.rmSync(this.tempPath, { force: true }); } catch { /* best effort */ }
  }

  private numberHeader(value: HeaderValue): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    const number = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  }

  private totalBytesFromContentRange(value: HeaderValue): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return undefined;
    const match = raw.match(/\/([0-9]+)\s*$/);
    if (!match) return undefined;
    const total = Number(match[1]);
    return Number.isFinite(total) && total > 0 ? total : undefined;
  }
}

export function formatDownloadStatus(progress: DownloadProgress): string {
  const parts: string[] = [];
  const receivedBytes = progress.receivedBytes;
  const expectedBytes = progress.expectedBytes;
  const bytesPerSecond = progress.bytesPerSecond;

  if (expectedBytes != null && expectedBytes > 0) {
    parts.push(`${formatBytes(receivedBytes)}  /  ${formatBytes(expectedBytes)}`);
    if (bytesPerSecond != null && bytesPerSecond > 0) {
      parts.push(formatBytesPerSecond(bytesPerSecond));
    }
    const etaText = formatETA(receivedBytes, expectedBytes, bytesPerSecond);
    if (etaText) {
      parts.push(`${etaText} remaining`);
    }
    return parts.join('    ');
  }

  if (receivedBytes > 0) {
    parts.push(`${formatBytes(receivedBytes)}  /  Unknown`);
    if (bytesPerSecond != null && bytesPerSecond > 0) {
      parts.push(formatBytesPerSecond(bytesPerSecond));
    }
    return parts.join('    ');
  }

  return '0 MB  /  Unknown';
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 MB';
  }

  const megabytes = bytes / 1_048_576;
  if (megabytes >= 10) {
    return `${megabytes.toFixed(0)} MB`;
  }
  return `${megabytes.toFixed(1)} MB`;
}

function formatBytesPerSecond(bytesPerSecond: number): string {
  const megabytes = bytesPerSecond / 1_048_576;
  if (megabytes >= 10) {
    return `${megabytes.toFixed(0)} MB/s`;
  }
  if (megabytes >= 1) {
    return `${megabytes.toFixed(1)} MB/s`;
  }
  const kilobytes = bytesPerSecond / 1_024;
  return `${kilobytes.toFixed(0)} KB/s`;
}

function formatETA(receivedBytes: number, expectedBytes: number, bytesPerSecond?: number): string | undefined {
  if (bytesPerSecond == null || bytesPerSecond <= 0) {
    return undefined;
  }

  const remainingBytes = Math.max(0, expectedBytes - receivedBytes);
  if (remainingBytes === 0) {
    return '00:00';
  }

  const seconds = Math.ceil(remainingBytes / bytesPerSecond);
  return formatDuration(seconds);
}

function formatDuration(totalSeconds: number): string {
  const secondsInteger = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(secondsInteger / 3600);
  const minutes = Math.floor((secondsInteger % 3600) / 60);
  const seconds = secondsInteger % 60;
  const pad = (value: number) => value.toString().padStart(2, '0');

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}
