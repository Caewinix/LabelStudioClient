import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { performance } from 'node:perf_hooks';

export interface DownloadProgress {
    readonly fraction: number;
    readonly receivedBytes: number;
    readonly expectedBytes?: number;
    readonly bytesPerSecond?: number;
}

export type DownloadResult = 'completed' | 'skipped';

export class DownloadMirrorFallbackError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DownloadMirrorFallbackError";
    }
}

export interface DownloadTaskSnapshot {
    readonly label: string;
    readonly destination: string;
    readonly temporaryPath: string;
    readonly paused: boolean;
    readonly completed: boolean;
    readonly receivedBytes: number;
    readonly expectedBytes?: number;
    readonly temporaryBytes: number;
    readonly destinationBytes: number;
    readonly requestOpened: boolean;
    readonly generation: number;
    readonly pauseCount: number;
    readonly resumeCount: number;
}

type HeaderValue = string | string[] | number | undefined;

const ConnectivityErrorCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
]);

export class ManagedDownloadTask {
    private request?: http.ClientRequest;
    private response?: http.IncomingMessage;
    private file?: fs.WriteStream;
    private paused = false;
    private completed = false;
    private cancelledForSkip = false;
    private receivedBytes = 0;
    private expectedBytes?: number;
    private lastSpeedSampleTime = performance.now();
    private lastSpeedSampleBytes = 0;
    private currentBytesPerSecond?: number;
    private readonly tempPath: string;
    private requestOpened = false;
    private pauseAbortActive = false;
    private reopenAfterPausedDisconnect = false;
    private transferGeneration = 0;
    private pauseCount = 0;
    private resumeCount = 0;
    private preservedTransferRetryCount = 0;
    private pendingResponseResume?: NodeJS.Immediate;
    private pauseClosePromise: Promise<void> = Promise.resolve();
    private resolve?: (value: DownloadResult) => void;
    private reject?: (reason?: unknown) => void;

    constructor(
        private sourceURL: string,
        private readonly destination: string,
        private readonly expectedByteCount: number | undefined,
        private readonly onProgress: (progress: DownloadProgress) => void,
        private readonly debugLabel = path.basename(destination),
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
            this.reopenAfterPausedDisconnect = false;
            this.requestOpened = false;
            this.pauseClosePromise = Promise.resolve();
            this.pauseCount = 0;
            this.resumeCount = 0;
            this.preservedTransferRetryCount = 0;
            this.refreshPartialState();
            this.trace("start", { startPaused, receivedBytes: this.receivedBytes, expectedBytes: this.expectedBytes });
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
        const generation = this.nextTransferGeneration();

        this.refreshPartialState();
        if (this.paused) {
            this.requestOpened = false;
            this.reportCurrentProgress();
            return;
        }

        if (!this.paused && this.isCurrentTransfer(generation)) await this.openRequest(generation);
        else this.requestOpened = false;
    }

    togglePause(): boolean {
        if (this.completed) return false;
        if (this.paused) {
            this.paused = false;
            this.resumeCount += 1;
            this.trace("toggle-resume", this.snapshot());
            this.resumeAfterPause();
            return false;
        }
        this.paused = true;
        this.pauseCount += 1;
        this.trace("toggle-pause", this.snapshot());
        this.abortNetworkForPause();
        return true;
    }

    pause(): boolean {
        if (this.completed) return false;
        if (this.paused) {
            this.trace("pause-already-paused", this.snapshot());
            this.reportCurrentProgress();
            return true;
        }
        if (!this.paused) this.pauseCount += 1;
        this.paused = true;
        this.trace("pause", this.snapshot());
        this.abortNetworkForPause();
        return true;
    }

    resumeIfPaused(): void {
        if (this.completed || !this.paused) return;
        this.paused = false;
        this.resumeCount += 1;
        this.trace("resume", this.snapshot());
        this.resumeAfterPause();
    }

    private resumeAfterPause(): void {
        this.pauseAbortActive = false;
        if (this.completed || this.paused) return;

        this.requestOpened = false;
        this.request = undefined;
        this.response = undefined;
        this.file = undefined;
        this.reopenAfterPausedDisconnect = false;
        const waitForPausedFile = this.pauseClosePromise;
        setImmediate(async () => {
            if (this.completed || this.paused) return;
            await waitForPausedFile.catch(() => undefined);
            if (this.completed || this.paused) return;
            this.refreshPartialState();
            this.resetSpeedSampler(this.receivedBytes);
            this.reportCurrentProgress();
            this.trace("resume-open", { receivedBytes: this.receivedBytes, expectedBytes: this.expectedBytes });
            void this.prepareAndOpenRequest();
        });
    }

    private abortNetworkForPause(): void {
        if (this.completed) return;
        this.pauseAbortActive = true;
        this.reopenAfterPausedDisconnect = true;
        this.requestOpened = false;
        this.invalidateCurrentTransfer();
        this.clearPendingResponseResume();
        try { this.response?.pause(); } catch { /* best effort */ }
        try { this.request?.destroy(); } catch { /* best effort */ }
        try { this.response?.destroy(); } catch { /* best effort */ }
        this.closeFileForPause();
        this.request = undefined;
        this.response = undefined;
        this.file = undefined;
        this.refreshPartialState();
        this.resetSpeedSampler(this.receivedBytes);
        this.trace("paused-network-aborted", this.snapshot());
        this.reportCurrentProgress();
    }

    cancelForSkip(): void {
        if (this.completed) return;
        this.cancelledForSkip = true;
        this.pauseAbortActive = false;
        this.paused = false;
        this.invalidateCurrentTransfer();
        try { this.response?.resume(); } catch { /* best effort */ }
        this.clearPendingResponseResume();
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
        this.invalidateCurrentTransfer();
        try { this.response?.resume(); } catch { /* best effort */ }
        this.clearPendingResponseResume();
        try { this.request?.destroy(); } catch { /* best effort */ }
        try { this.file?.destroy(); } catch { /* best effort */ }
        this.finishSuccess('skipped');
    }

    failForMirrorFallback(message: string): void {
        if (this.completed) return;
        this.completed = true;
        this.paused = false;
        this.pauseAbortActive = false;
        this.cancelledForSkip = false;
        this.requestOpened = false;
        this.invalidateCurrentTransfer();
        this.clearPendingResponseResume();
        try { this.response?.pause(); } catch { /* best effort */ }
        try { this.request?.destroy(); } catch { /* best effort */ }
        try { this.response?.destroy(); } catch { /* best effort */ }
        this.closeFileForPause();
        this.request = undefined;
        this.response = undefined;
        this.file = undefined;
        this.refreshPartialState();
        this.resetSpeedSampler(this.receivedBytes);
        const error = new DownloadMirrorFallbackError(message);
        this.trace("mirror-fallback", { error: this.errorMessage(error), snapshot: this.snapshot() });
        const waitForFile = this.pauseClosePromise;
        setImmediate(async () => {
            await waitForFile.catch(() => undefined);
            this.reject?.(error);
        });
    }

    private nextTransferGeneration(): number {
        this.transferGeneration += 1;
        return this.transferGeneration;
    }

    private invalidateCurrentTransfer(): void {
        this.transferGeneration += 1;
    }

    private isCurrentTransfer(generation: number): boolean {
        return generation === this.transferGeneration && !this.completed;
    }

    private async openRequest(generation: number, redirectCount = 0): Promise<void> {
        try {
            if (this.paused || !this.isCurrentTransfer(generation)) {
                this.requestOpened = false;
                return;
            }

            fs.mkdirSync(path.dirname(this.destination), { recursive: true });
            this.refreshPartialState();
            const resumeOffset = this.receivedBytes;
            this.trace("open-request", { generation, resumeOffset, expectedBytes: this.expectedBytes, url: this.sourceURL });
            const parsed = new URL(this.sourceURL);
            const client = parsed.protocol === 'https:' ? https : http;
            const headers: Record<string, string> = {
                'User-Agent': 'Label-Studio-Electron-ManagedDownloader',
                'Cache-Control': 'no-cache',
                'Accept-Encoding': 'identity'
            };
            if (resumeOffset > 0) headers.Range = `bytes=${resumeOffset}-`;

            let completingFromExpectedBytes = false;
            const request = client.get(parsed, { headers });
            this.request = request;
            request.on('response', response => {
                if (!this.isCurrentTransfer(generation)) {
                    response.resume();
                    return;
                }
                this.response = response;
                const status = response.statusCode ?? 0;
                const location = response.headers.location;
                this.trace("response", { generation, status, range: request.getHeader("Range") ?? null, contentLength: response.headers["content-length"] ?? null, contentRange: response.headers["content-range"] ?? null });
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
                    void this.openRequest(generation, redirectCount + 1);
                    return;
                }

                if (status === 416) {
                    // The partial file is probably complete or invalid for the current
                    // remote object. If it is complete according to expectedBytes, promote
                    // it; otherwise clear it and retry from zero.
                    response.resume();
                    if (this.expectedBytes != null && resumeOffset === this.expectedBytes && fs.existsSync(this.tempPath)) {
                        this.trace("range-complete-promote", { resumeOffset, expectedBytes: this.expectedBytes });
                        this.promoteTemporaryFile(generation);
                        return;
                    }
                    this.trace("range-invalid-restart", { resumeOffset, expectedBytes: this.expectedBytes });
                    this.removeTemporaryFile();
                    this.receivedBytes = 0;
                    this.resetSpeedSampler(0);
                    this.request = undefined;
                    this.response = undefined;
                    void this.openRequest(generation, redirectCount);
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
                        this.trace("range-ignored-restart", { resumeOffset, status });
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
                let responseEnded = false;

                response.on('data', (chunk: Buffer) => {
                    if (!this.isCurrentTransfer(generation)) return;
                    if (this.paused && this.pauseAbortActive) return;
                    response.pause();
                    this.receivedBytes += chunk.length;
                    this.preservedTransferRetryCount = 0;
                    const didFlush = file.write(chunk);
                    const bytesPerSecond = this.speedSample(this.receivedBytes);
                    this.reportProgress(
                        this.expectedBytes && this.expectedBytes > 0
                            ? Math.max(0, Math.min(1, this.receivedBytes / this.expectedBytes))
                            : this.estimatedProgress(this.receivedBytes),
                        this.receivedBytes,
                        this.expectedBytes,
                        bytesPerSecond
                    );

                    const hasCompleteExpectedPayload = this.expectedBytes != null
                        && this.expectedBytes > 0
                        && this.receivedBytes >= this.expectedBytes;

                    const continueAfterWrite = (): void => {
                        if (!this.isCurrentTransfer(generation)) return;
                        if (this.paused || this.pauseAbortActive) return;
                        if (hasCompleteExpectedPayload) {
                            completingFromExpectedBytes = true;
                            responseEnded = true;
                            this.requestOpened = false;
                            try { response.destroy(); } catch { /* best effort */ }
                            try { this.request?.destroy(); } catch { /* best effort */ }
                            this.request = undefined;
                            this.response = undefined;
                            file.end(() => {
                                if (!this.isCurrentTransfer(generation)) return;
                                if (this.cancelledForSkip || this.completed) return;
                                this.trace("complete-by-expected-bytes", { receivedBytes: this.receivedBytes, expectedBytes: this.expectedBytes });
                                this.promoteTemporaryFile(generation);
                            });
                            return;
                        }
                        if (response.destroyed) return;
                        response.resume();
                    };

                    if (didFlush) this.scheduleResponseResume(continueAfterWrite);
                    else file.once('drain', () => this.scheduleResponseResume(continueAfterWrite));
                });

                response.on('end', () => {
                    if (!this.isCurrentTransfer(generation)) return;
                    responseEnded = true;
                    if (this.paused && this.pauseAbortActive) return;
                    file.end(() => {
                        if (!this.isCurrentTransfer(generation)) return;
                        if (this.cancelledForSkip || this.completed) return;
                        this.promoteTemporaryFile(generation);
                    });
                });

                response.on('error', error => {
                    if (!this.isCurrentTransfer(generation)) return;
                    if (completingFromExpectedBytes) return;
                    if (this.paused && this.handlePausedNetworkDisconnect()) return;
                    if (this.retryTransferPreservingTemporaryFile(generation, error)) return;
                    this.finishFailure(error);
                });
                response.on('aborted', () => {
                    if (!this.isCurrentTransfer(generation)) return;
                    if (completingFromExpectedBytes) return;
                    if (this.paused && this.handlePausedNetworkDisconnect()) return;
                    const error = new Error(`Connection aborted while downloading ${this.sourceURL}`);
                    if (this.retryTransferPreservingTemporaryFile(generation, error)) return;
                    this.finishFailure(error);
                });
                response.on('close', () => {
                    if (!this.isCurrentTransfer(generation)) return;
                    if (responseEnded || this.cancelledForSkip || this.completed) return;
                    if (this.paused && this.handlePausedNetworkDisconnect()) return;
                    const error = new Error(`Connection closed while downloading ${this.sourceURL}`);
                    if (this.retryTransferPreservingTemporaryFile(generation, error)) return;
                    this.finishFailure(error);
                });
                file.on('error', error => {
                    if (!this.isCurrentTransfer(generation)) return;
                    if (this.paused && this.handlePausedNetworkDisconnect()) return;
                    this.finishFailure(error);
                });
                if (this.paused) this.abortNetworkForPause();
            });

            request.on('error', error => {
                if (!this.isCurrentTransfer(generation)) return;
                if (completingFromExpectedBytes) return;
                if (this.cancelledForSkip) return;
                if (this.paused && this.handlePausedNetworkDisconnect()) return;
                if (this.retryTransferPreservingTemporaryFile(generation, error)) return;
                this.finishFailure(error);
            });
        } catch (error) {
            this.finishFailure(error);
        }
    }

    private promoteTemporaryFile(generation: number): void {
        if (!this.isCurrentTransfer(generation)) return;
        if (this.paused || this.pauseAbortActive) return;

        try {
            const actualBytes = fs.existsSync(this.tempPath) ? fs.statSync(this.tempPath).size : 0;
            if (this.expectedBytes != null && actualBytes !== this.expectedBytes) {
                this.trace("promote-rejected-incomplete", { actualBytes, expectedBytes: this.expectedBytes });
                this.finishFailure(new Error(`Incomplete download for ${this.sourceURL}: received ${actualBytes} of ${this.expectedBytes} bytes.`));
                return;
            }

            if (fs.existsSync(this.destination)) fs.rmSync(this.destination, { force: true });
            fs.renameSync(this.tempPath, this.destination);
            const expected = this.expectedBytes ?? actualBytes;
            this.receivedBytes = actualBytes;
            this.reportProgress(1, actualBytes, expected, this.currentBytesPerSecond);
            this.trace("complete", { actualBytes, expectedBytes: expected });
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
        this.lastSpeedSampleTime = performance.now();
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

    private handlePausedNetworkDisconnect(): boolean {
        if (!this.paused || this.completed) return false;
        if (this.reopenAfterPausedDisconnect) return true;
        this.reopenAfterPausedDisconnect = true;
        this.pauseAbortActive = true;
        this.requestOpened = false;
        this.invalidateCurrentTransfer();
        this.clearPendingResponseResume();
        try { this.response?.pause(); } catch { /* best effort */ }
        try { this.request?.destroy(); } catch { /* best effort */ }
        try { this.response?.destroy(); } catch { /* best effort */ }
        this.closeFileForPause();
        this.request = undefined;
        this.response = undefined;
        this.file = undefined;
        this.refreshPartialState();
        this.resetSpeedSampler(this.receivedBytes);
        this.trace("paused-disconnect", this.snapshot());
        this.reportCurrentProgress();
        return true;
    }

    private retryTransferPreservingTemporaryFile(generation: number, error: unknown): boolean {
        if (!this.isCurrentTransfer(generation) || this.completed || this.cancelledForSkip) return true;
        if (this.paused) return this.handlePausedNetworkDisconnect();

        this.refreshPartialState();
        if (this.receivedBytes <= 0) return false;
        if (this.expectedBytes != null && this.expectedBytes > 0 && this.receivedBytes >= this.expectedBytes) {
            this.trace("retry-complete-promote", {
                error: this.errorMessage(error),
                receivedBytes: this.receivedBytes,
                expectedBytes: this.expectedBytes,
            });
            this.promoteTemporaryFile(generation);
            return true;
        }

        this.preservedTransferRetryCount += 1;
        if (this.preservedTransferRetryCount > 8) return false;

        this.invalidateCurrentTransfer();
        this.clearPendingResponseResume();
        this.requestOpened = false;
        this.reopenAfterPausedDisconnect = false;
        try { this.response?.pause(); } catch { /* best effort */ }
        try { this.request?.destroy(); } catch { /* best effort */ }
        try { this.response?.destroy(); } catch { /* best effort */ }
        this.closeFileForPause();
        this.request = undefined;
        this.response = undefined;
        this.file = undefined;
        this.resetSpeedSampler(this.receivedBytes);
        this.trace("transfer-retry-preserve-temp", {
            error: this.errorMessage(error),
            retry: this.preservedTransferRetryCount,
            snapshot: this.snapshot(),
        });
        this.reportCurrentProgress();

        const waitForFile = this.pauseClosePromise;
        setImmediate(async () => {
            await waitForFile.catch(() => undefined);
            if (this.completed || this.cancelledForSkip || this.paused) return;
            this.refreshPartialState();
            this.resetSpeedSampler(this.receivedBytes);
            this.trace("transfer-retry-open", { receivedBytes: this.receivedBytes, expectedBytes: this.expectedBytes });
            void this.prepareAndOpenRequest();
        });
        return true;
    }

    snapshot(): DownloadTaskSnapshot {
        return {
            label: this.debugLabel,
            destination: this.destination,
            temporaryPath: this.tempPath,
            paused: this.paused,
            completed: this.completed,
            receivedBytes: this.receivedBytes,
            expectedBytes: this.expectedBytes,
            temporaryBytes: this.fileBytes(this.tempPath),
            destinationBytes: this.fileBytes(this.destination),
            requestOpened: this.requestOpened,
            generation: this.transferGeneration,
            pauseCount: this.pauseCount,
            resumeCount: this.resumeCount,
        };
    }

    private trace(event: string, data?: unknown): void {
        const payload = data == null ? "" : ` ${JSON.stringify(data)}`;
        console.info(`[download] ${event} ${this.debugLabel}${payload}`);
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private fileBytes(filePath: string): number {
        try {
            return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        } catch {
            return 0;
        }
    }

    private closeFileForPause(): void {
        const file = this.file;
        if (!file || file.closed || file.destroyed) return;
        this.pauseClosePromise = new Promise<void>((resolve) => {
            const done = (): void => resolve();
            file.once('close', done);
            file.once('error', done);
            try {
                file.end();
            } catch {
                try { file.destroy(); } catch { /* best effort */ }
                resolve();
            }
        });
    }

    private scheduleResponseResume(resumeResponse: () => void): void {
        this.clearPendingResponseResume();
        this.pendingResponseResume = setImmediate(() => {
            this.pendingResponseResume = undefined;
            resumeResponse();
        });
    }

    private clearPendingResponseResume(): void {
        if (!this.pendingResponseResume) return;
        clearImmediate(this.pendingResponseResume);
        this.pendingResponseResume = undefined;
    }

    private reportProgress(fraction: number, receivedBytes: number, expectedBytes: number | undefined, bytesPerSecond: number | undefined): void {
        const normalized = Math.max(0, Math.min(1, fraction));
        this.onProgress({ fraction: normalized, receivedBytes, expectedBytes, bytesPerSecond });
    }

    private estimatedProgress(bytes: number): number {
        if (bytes <= 0) return 0;
        const megabytes = bytes / 1_048_576;
        return Math.min(0.95, 1 - Math.pow(0.86, megabytes));
    }

    private speedSample(receivedBytes: number): number | undefined {
        const now = performance.now();
        const elapsed = (now - this.lastSpeedSampleTime) / 1000;
        const delta = receivedBytes - this.lastSpeedSampleBytes;
        this.lastSpeedSampleTime = now;
        this.lastSpeedSampleBytes = receivedBytes;
        if (delta <= 0) return this.currentBytesPerSecond;
        const instantSpeed = delta / Math.max(elapsed, 0.001);
        this.currentBytesPerSecond = instantSpeed;
        return this.currentBytesPerSecond;
    }

    private finishSuccess(result: DownloadResult): void {
        if (this.completed) return;
        if (result === 'completed' && (this.paused || this.pauseAbortActive)) return;
        this.completed = true;
        this.requestOpened = false;
        this.clearPendingResponseResume();
        this.request = undefined;
        this.response = undefined;
        this.file = undefined;
        this.resolve?.(result);
    }

    private finishFailure(error: unknown): void {
        if (this.completed) return;
        this.trace("failure", { error: this.errorMessage(error), snapshot: this.snapshot() });
        this.completed = true;
        this.requestOpened = false;
        this.clearPendingResponseResume();
        try { this.response?.destroy(); } catch { /* best effort */ }
        try { this.request?.destroy(); } catch { /* best effort */ }
        try { this.file?.destroy(); } catch { /* best effort */ }
        this.removeTemporaryFile();
        this.reject?.(error);
    }

    private isConnectivityError(error: unknown): boolean {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code ?? '')
            : '';
        if (ConnectivityErrorCodes.has(code)) return true;

        const message = error instanceof Error ? error.message : String(error);
        return /\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|getaddrinfo|network is unreachable)\b/i.test(message);
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
