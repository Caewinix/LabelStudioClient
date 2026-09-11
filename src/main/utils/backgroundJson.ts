import { Worker } from "node:worker_threads";

export interface IndexedCondaPackageRecord {
    filename: string;
    name: string;
    version: string;
    build?: string;
    build_number?: number;
    depends?: string[];
    size?: number;
    subdir?: string;
}

export interface CondaRepodataCatalog {
    packageRecords(normalizedName: string): Promise<IndexedCondaPackageRecord[]>;
    dispose(): Promise<void>;
}

interface WorkerSuccess<T> {
    ok: true;
    value: T;
}

interface WorkerFailure {
    ok: false;
    error: string;
}

type WorkerResult<T> = WorkerSuccess<T> | WorkerFailure;

const JsonWorkerSource = String.raw`
const { parentPort } = require("node:worker_threads");
parentPort.once("message", body => {
    try {
        const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
        parentPort.postMessage({ ok: true, value: parsed });
    } catch (error) {
        parentPort.postMessage({
            ok: false,
            error: error && error.stack ? error.stack : String(error),
        });
    }
});
`;

const CondaCatalogWorkerSource = String.raw`
const { parentPort } = require("node:worker_threads");

function normalizePackageName(name) {
    return String(name || "").trim().toLowerCase().replace(/[-_.]+/g, "-");
}

parentPort.once("message", body => {
    try {
        const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
        const packagesByName = Object.create(null);
        const packages = parsed && typeof parsed.packages === "object" && parsed.packages
            ? parsed.packages
            : {};
        for (const [filename, record] of Object.entries(packages)) {
            if (!filename.endsWith(".tar.bz2") || !record || typeof record !== "object") continue;
            const name = typeof record.name === "string" ? record.name : "";
            const version = typeof record.version === "string" ? record.version : "";
            if (!name || !version) continue;
            const key = normalizePackageName(name);
            const entry = {
                filename,
                name,
                version,
                ...(typeof record.build === "string" ? { build: record.build } : {}),
                ...(Number.isFinite(record.build_number) ? { build_number: record.build_number } : {}),
                ...(Array.isArray(record.depends) ? { depends: record.depends.filter(value => typeof value === "string") } : {}),
                ...(Number.isFinite(record.size) ? { size: record.size } : {}),
                ...(typeof record.subdir === "string" ? { subdir: record.subdir } : {}),
            };
            (packagesByName[key] ||= []).push(entry);
        }
        parentPort.on("message", message => {
            if (!message || message.type !== "query") return;
            parentPort.postMessage({
                type: "result",
                id: message.id,
                records: packagesByName[normalizePackageName(message.name)] || [],
            });
        });
        parentPort.postMessage({ type: "ready" });
    } catch (error) {
        parentPort.postMessage({
            type: "error",
            error: error && error.stack ? error.stack : String(error),
        });
    }
});
`;

export async function parseJsonInBackground<T>(body: ArrayBuffer, signal?: AbortSignal): Promise<T> {
    return await runJsonWorker<T>(body, signal);
}

export async function loadCondaRepodataInBackground(
    body: ArrayBuffer,
    signal?: AbortSignal,
): Promise<CondaRepodataCatalog> {
    const catalog = new WorkerCondaRepodataCatalog(body, signal);
    await catalog.waitUntilReady();
    return catalog;
}

async function runJsonWorker<T>(body: ArrayBuffer, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError();

    return await new Promise<T>((resolve, reject) => {
        const worker = new Worker(JsonWorkerSource, { eval: true });
        let settled = false;

        const cleanup = (): void => {
            signal?.removeEventListener("abort", onAbort);
            worker.removeAllListeners();
        };
        const finish = (operation: () => void): void => {
            if (settled) return;
            settled = true;
            cleanup();
            void worker.terminate();
            operation();
        };
        const onAbort = (): void => finish(() => reject(abortError()));

        worker.once("message", (message: WorkerResult<T>) => {
            if (message?.ok) finish(() => resolve(message.value));
            else finish(() => reject(new Error(message?.error || "The background JSON worker returned an invalid response.")));
        });
        worker.once("error", error => finish(() => reject(error)));
        worker.once("exit", code => {
            if (!settled) finish(() => reject(new Error(`The background JSON worker exited with status ${code}.`)));
        });
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            worker.postMessage(body, [body]);
        } catch (error) {
            finish(() => reject(error));
        }
    });
}

interface CondaReadyMessage {
    type: "ready";
}

interface CondaResultMessage {
    type: "result";
    id: number;
    records: IndexedCondaPackageRecord[];
}

interface CondaErrorMessage {
    type: "error";
    error: string;
}

type CondaWorkerMessage = CondaReadyMessage | CondaResultMessage | CondaErrorMessage;

class WorkerCondaRepodataCatalog implements CondaRepodataCatalog {
    private readonly worker = new Worker(CondaCatalogWorkerSource, { eval: true });
    private readonly ready: Promise<void>;
    private resolveReady: () => void = () => undefined;
    private rejectReady: (error: Error) => void = () => undefined;
    private readonly pending = new Map<number, {
        resolve: (records: IndexedCondaPackageRecord[]) => void;
        reject: (error: Error) => void;
    }>();
    private nextRequestId = 1;
    private failure?: Error;
    private disposed = false;

    constructor(body: ArrayBuffer, signal?: AbortSignal) {
        this.ready = new Promise<void>((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        const onAbort = (): void => this.fail(abortError());
        signal?.addEventListener("abort", onAbort, { once: true });
        void this.ready.then(
            () => signal?.removeEventListener("abort", onAbort),
            () => signal?.removeEventListener("abort", onAbort),
        );

        this.worker.on("message", (message: CondaWorkerMessage) => this.handleMessage(message));
        this.worker.once("error", error => this.fail(error));
        this.worker.once("exit", code => {
            if (!this.disposed && !this.failure) this.fail(new Error(`The Conda catalog worker exited with status ${code}.`));
        });
        try {
            this.worker.postMessage(body, [body]);
        } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
        }
    }

    async waitUntilReady(): Promise<void> {
        await this.ready;
    }

    async packageRecords(normalizedName: string): Promise<IndexedCondaPackageRecord[]> {
        await this.ready;
        if (this.failure) throw this.failure;
        if (this.disposed) throw new Error("The Conda catalog worker has been disposed.");
        const id = this.nextRequestId++;
        return await new Promise<IndexedCondaPackageRecord[]>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.worker.ref();
                this.worker.postMessage({ type: "query", id, name: normalizedName });
            } catch (error) {
                this.pending.delete(id);
                if (this.pending.size === 0) this.worker.unref();
                reject(error);
            }
        });
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        const error = new Error("The Conda catalog worker was disposed.");
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        await this.worker.terminate();
    }

    private handleMessage(message: CondaWorkerMessage): void {
        if (message.type === "ready") {
            this.worker.unref();
            this.resolveReady();
            return;
        }
        if (message.type === "error") {
            this.fail(new Error(message.error));
            return;
        }
        if (message.type === "result") {
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            if (this.pending.size === 0) this.worker.unref();
            request.resolve(Array.isArray(message.records) ? message.records : []);
        }
    }

    private fail(error: Error): void {
        if (this.failure || this.disposed) return;
        this.failure = error;
        this.rejectReady(error);
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        void this.worker.terminate();
    }
}

function abortError(): Error {
    const error = new Error("The background JSON operation was cancelled.");
    error.name = "AbortError";
    return error;
}
