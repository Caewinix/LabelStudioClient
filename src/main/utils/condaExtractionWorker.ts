import fs from "node:fs";
import { Worker } from "node:worker_threads";

interface ExtractionProgressMessage {
    type: "progress";
    readBytes: number;
    totalBytes: number;
    entries: number;
}

interface ExtractionCompleteMessage {
    type: "complete";
}

interface ExtractionFailureMessage {
    type: "error";
    error: string;
}

type ExtractionWorkerMessage = ExtractionProgressMessage | ExtractionCompleteMessage | ExtractionFailureMessage;

const ExtractionWorkerSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { parentPort, workerData } = require("node:worker_threads");
const createBzip2Decompressor = require(workerData.bzip2Module);
const tarStream = require(workerData.tarModule);

function safeArchiveEntryPath(destinationRoot, entryName) {
    const root = path.resolve(destinationRoot);
    const normalizedName = String(entryName).replace(/\\/g, "/");
    const destination = path.resolve(root, normalizedName);
    const relative = path.relative(root, destination);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Archive entry escapes the runtime directory: " + entryName);
    }
    return destination;
}

function assertSafeArchiveLinkTarget(destinationRoot, linkPath, linkTarget) {
    if (path.isAbsolute(linkTarget)) {
        throw new Error("Archive link uses an absolute target: " + linkTarget);
    }
    const root = path.resolve(destinationRoot);
    const resolvedTarget = path.resolve(path.dirname(linkPath), String(linkTarget).replace(/\\/g, "/"));
    const relative = path.relative(root, resolvedTarget);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Archive link escapes the runtime directory: " + linkTarget);
    }
}

async function extractEntry(destinationRoot, header, entry) {
    const normalizedEntryName = String(header.name || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (!normalizedEntryName || normalizedEntryName === ".") {
        entry.resume();
        return;
    }
    const destination = safeArchiveEntryPath(destinationRoot, header.name);
    const mode = header.mode == null ? undefined : header.mode & 0o777;

    if (header.type === "directory") {
        await fs.promises.mkdir(destination, { recursive: true });
        entry.resume();
        return;
    }
    if (header.type === "symlink") {
        entry.resume();
        if (!header.linkname) throw new Error("Archive symlink is missing its target: " + header.name);
        assertSafeArchiveLinkTarget(destinationRoot, destination, header.linkname);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.rm(destination, { force: true, recursive: true });
        await fs.promises.symlink(header.linkname, destination);
        return;
    }
    if (header.type === "link") {
        entry.resume();
        if (!header.linkname) throw new Error("Archive hard link is missing its target: " + header.name);
        const target = safeArchiveEntryPath(destinationRoot, header.linkname);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.rm(destination, { force: true, recursive: true });
        await fs.promises.link(target, destination);
        return;
    }
    if (header.type !== "file" && header.type !== "contiguous-file" && header.type != null) {
        entry.resume();
        return;
    }

    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await pipeline(entry, fs.createWriteStream(destination, mode == null ? undefined : { mode }));
}

async function main() {
    const totalBytes = (await fs.promises.stat(workerData.archivePath)).size;
    let readBytes = 0;
    let entries = 0;
    let lastProgressAt = 0;
    const publishProgress = (force = false) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < 100) return;
        lastProgressAt = now;
        parentPort.postMessage({ type: "progress", readBytes, totalBytes, entries });
    };

    const input = fs.createReadStream(workerData.archivePath);
    input.on("data", chunk => {
        readBytes += chunk.length;
        publishProgress();
    });

    const extractor = tarStream.extract();
    extractor.on("entry", (header, entry, next) => {
        extractEntry(workerData.destinationRoot, header, entry)
            .then(() => {
                entries += 1;
                publishProgress();
                next();
            })
            .catch(error => extractor.destroy(error instanceof Error ? error : new Error(String(error))));
    });

    await pipeline(input, createBzip2Decompressor(), extractor);
    readBytes = totalBytes;
    publishProgress(true);
}

main()
    .then(() => parentPort.postMessage({ type: "complete" }))
    .catch(error => parentPort.postMessage({
        type: "error",
        error: error && error.stack ? error.stack : String(error),
    }));
`;

export async function extractCondaTarBz2InBackground(
    archivePath: string,
    destinationRoot: string,
    signal?: AbortSignal,
    onProgress?: (fraction: number, entries: number) => void,
): Promise<void> {
    if (signal?.aborted) throw abortError();
    await fs.promises.mkdir(destinationRoot, { recursive: true });

    await new Promise<void>((resolve, reject) => {
        const worker = new Worker(ExtractionWorkerSource, {
            eval: true,
            workerData: {
                archivePath,
                destinationRoot,
                bzip2Module: require.resolve("unbzip2-stream"),
                tarModule: require.resolve("tar-stream"),
            },
        });
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

        worker.on("message", (message: ExtractionWorkerMessage) => {
            if (message.type === "progress") {
                const fraction = message.totalBytes > 0 ? message.readBytes / message.totalBytes : 0;
                onProgress?.(Math.max(0, Math.min(1, fraction)), message.entries);
            } else if (message.type === "complete") {
                finish(resolve);
            } else {
                finish(() => reject(new Error(message.error)));
            }
        });
        worker.once("error", error => finish(() => reject(error)));
        worker.once("exit", code => {
            if (!settled) finish(() => reject(new Error(`The Conda extraction worker exited with status ${code}.`)));
        });
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function abortError(): Error {
    const error = new Error("The background Conda extraction was cancelled.");
    error.name = "AbortError";
    return error;
}
