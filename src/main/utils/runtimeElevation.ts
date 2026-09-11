import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { AppPaths } from "../services/appPaths";
import type { ManagedRuntimeReplacementFinalizer } from "../services/runtimeBootstrapService";

export interface PreparedRuntimeReplacement {
    stagedRuntime: string;
    runtimeRoot: string;
}

export interface PreparedPackageReplacement {
    stagedRuntime: string;
    runtimeRoot: string;
    packageNames: string[];
}

export interface PreparedRuntimeReplacementProgress {
    phase: string;
    completedEntries: number;
    totalEntries: number;
}

export const ElevatedBootstrapArgumentPrefix = "--label-studio-elevated-bootstrap=";
export const ElevatedBootstrapUserDataArgumentPrefix = "--label-studio-elevated-user-data=";
export const ElevatedBootstrapPipeArgumentPrefix = "--label-studio-elevated-pipe=";
export const ElevatedBootstrapTokenArgumentPrefix = "--label-studio-elevated-token=";

export class WindowsAdministratorPermissionCancelledError extends Error {
    constructor() {
        super("Administrator permission was not granted. The update was cancelled before any installed files were changed.");
        this.name = "WindowsAdministratorPermissionCancelledError";
    }
}

function argumentValue(argv: readonly string[], prefix: string): string | undefined {
    return argv.find(value => value.startsWith(prefix))?.slice(prefix.length).trim() || undefined;
}

export type ElevatedBootstrapMode = "replace-runtime" | "replace-packages";

export function elevatedBootstrapModeFromArgv(argv: readonly string[]): ElevatedBootstrapMode | undefined {
    const mode = argumentValue(argv, ElevatedBootstrapArgumentPrefix);
    if (mode && mode !== "replace-runtime" && mode !== "replace-packages") {
        throw new Error("Privileged runtime bootstrap only supports prepared local file replacement.");
    }
    return mode as ElevatedBootstrapMode | undefined;
}

export function elevatedBootstrapUserDataPathFromArgv(argv: readonly string[]): string | undefined {
    return argumentValue(argv, ElevatedBootstrapUserDataArgumentPrefix);
}

export function elevatedBootstrapPipePathFromArgv(argv: readonly string[]): string | undefined {
    return argumentValue(argv, ElevatedBootstrapPipeArgumentPrefix);
}

export function elevatedBootstrapTokenFromArgv(argv: readonly string[]): string | undefined {
    return argumentValue(argv, ElevatedBootstrapTokenArgumentPrefix);
}

type RuntimeReplacementAction = "commit" | "rollback";

interface ReplacementPipe<TPlan = unknown> {
    path: string;
    token: string;
    completion: Promise<boolean>;
    finalize: (action: RuntimeReplacementAction) => Promise<void>;
    close: () => Promise<void>;
}

export async function runPlatformRuntimeReplacement(
    plan: PreparedRuntimeReplacement,
    onProgress?: (progress: PreparedRuntimeReplacementProgress) => void,
): Promise<ManagedRuntimeReplacementFinalizer | undefined> {
    return await runPlatformManagedReplacement(
        plan,
        "replace-runtime",
        "runtime replacement",
        (pipe, logPath) => replacementCommand(pipe, logPath, "--replace-managed-runtime"),
        onProgress,
    );
}

export async function runPlatformPackageReplacement(
    plan: PreparedPackageReplacement,
    onProgress?: (progress: PreparedRuntimeReplacementProgress) => void,
): Promise<ManagedRuntimeReplacementFinalizer | undefined> {
    if (!["win32", "linux"].includes(process.platform)) {
        throw new Error(`Privileged package replacement is not supported in this ${process.platform} build.`);
    }
    return await runPlatformManagedReplacement(
        plan,
        "replace-packages",
        "package replacement",
        (pipe, logPath) => replacementCommand(pipe, logPath, "--replace-managed-packages"),
        onProgress,
    );
}

async function runPlatformManagedReplacement<TPlan>(
    plan: TPlan,
    requestType: "replace-runtime" | "replace-packages",
    operationName: string,
    commandFactory: (pipe: ReplacementPipe<TPlan>, logPath: string) => { executable: string; args: string[] },
    onProgress?: (progress: PreparedRuntimeReplacementProgress) => void,
): Promise<ManagedRuntimeReplacementFinalizer | undefined> {
    if (!app.isPackaged || !["win32", "linux"].includes(process.platform)) {
        throw new Error(`Privileged ${operationName} is not supported in this ${process.platform} build.`);
    }
    const logPath = AppPaths.runtimeBootstrapLogFile();
    const pipe = await createReplacementPipe(plan, requestType, operationName, onProgress);
    let transferred = false;
    let childExit: Promise<number | null> | undefined;
    const assertExit = (code: number | null): void => {
        if (code === 0) return;
        if (process.platform === "win32" && code === 1223) throw new WindowsAdministratorPermissionCancelledError();
        throw new Error(`The ${operationName} helper exited with status ${code ?? "unknown"}.`);
    };
    try {
        const command = commandFactory(pipe, logPath);
        appendRuntimeBootstrapLog(logPath, `Starting local ${operationName}.`);
        const child = spawn(command.executable, command.args, { windowsHide: true, stdio: "ignore" });
        childExit = new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        void childExit.catch(() => undefined);
        const outcome = await Promise.race([
            pipe.completion.then(pending => ({ type: "complete" as const, pending })),
            childExit.then(code => ({ type: "exit" as const, code })),
        ]);
        if (outcome.type === "exit") {
            assertExit(outcome.code);
            throw new Error(`The ${operationName} helper exited without reporting completion over IPC.`);
        }
        if (!outcome.pending) {
            assertExit(await childExit);
            return undefined;
        }
        const exit = childExit;
        let finalized = false;
        const finalize = async (action: RuntimeReplacementAction): Promise<void> => {
            if (finalized) return;
            try {
                await pipe.finalize(action);
                assertExit(await exit);
            } finally {
                finalized = true;
                await pipe.close();
                await exit.catch(() => undefined);
            }
        };
        transferred = true;
        return { commit: () => finalize("commit"), rollback: () => finalize("rollback") };
    } finally {
        if (!transferred) {
            // Disconnect requests rollback; wait before restarting the service
            // or allowing the caller to dispose of staged files.
            await pipe.close();
            await childExit?.catch(() => undefined);
        }
    }
}

function replacementCommand<TPlan>(
    pipe: ReplacementPipe<TPlan>,
    logPath: string,
    commandFlag: "--replace-managed-runtime" | "--replace-managed-packages",
): { executable: string; args: string[] } {
    if (process.platform === "win32") {
        const executable = AppPaths.windowsInstallerExecutable();
        if (!fs.existsSync(executable)) throw new Error(`The packaged installer executable does not exist: ${executable}`);
        return {
            executable,
            args: [
                commandFlag,
                "--application-executable", app.getPath("exe"),
                "--pipe-path", pipe.path,
                "--ipc-token", pipe.token,
                "--diagnostic-log", logPath,
                "--needs-elevation",
            ],
        };
    }
    const pkexec = findExecutable(["/usr/bin/pkexec", "/bin/pkexec", "/usr/local/bin/pkexec"]);
    if (!pkexec) {
        throw new Error("Linux administrator elevation requires pkexec. Install PolicyKit, move Label Studio to a writable directory, or start it with permission to write the install directory.");
    }
    const helper = findExecutable([
        process.env.LABEL_STUDIO_ELEVATED_HELPER,
        path.join(process.resourcesPath, "bin", "label-studio-elevated-bootstrap"),
        "/usr/lib/label-studio/label-studio-elevated-bootstrap",
        "/usr/local/lib/label-studio/label-studio-elevated-bootstrap",
        "/opt/label-studio/label-studio-elevated-bootstrap",
    ]);
    return {
        executable: pkexec,
        args: [
            helper ?? app.getPath("exe"),
            ...(!helper ? ["--no-sandbox"] : []),
            `${ElevatedBootstrapArgumentPrefix}${commandFlag === "--replace-managed-packages" ? "replace-packages" : "replace-runtime"}`,
            `${ElevatedBootstrapUserDataArgumentPrefix}${app.getPath("userData")}`,
            `${ElevatedBootstrapPipeArgumentPrefix}${pipe.path}`,
            `${ElevatedBootstrapTokenArgumentPrefix}${pipe.token}`,
        ],
    };
}

async function createReplacementPipe<TPlan>(
    plan: TPlan,
    requestType: "replace-runtime" | "replace-packages",
    operationName: string,
    onProgress?: (progress: PreparedRuntimeReplacementProgress) => void,
): Promise<ReplacementPipe<TPlan>> {
    const token = randomUUID();
    const pipePath = process.platform === "win32"
        ? `\\\\.\\pipe\\label-studio-runtime-replacement-${process.pid}-${randomUUID()}`
        : path.join(os.tmpdir(), `ls-replace-${randomUUID()}.sock`);
    const sockets = new Set<net.Socket>();
    let worker: net.Socket | undefined;
    let settled = false;
    let complete: (pending: boolean) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const completion = new Promise<boolean>((resolve, reject) => {
        complete = pending => { settled = true; resolve(pending); };
        fail = error => { settled = true; reject(error); };
    });
    void completion.catch(() => undefined);
    let waiter: { action: RuntimeReplacementAction; resolve: () => void; reject: (error: Error) => void } | undefined;
    let workerError: Error | undefined;
    const failed = (error: Error): void => {
        workerError = error;
        if (!settled) fail(error);
        waiter?.reject(error);
        waiter = undefined;
    };
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", chunk => {
            buffer += chunk;
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                try {
                    const message = JSON.parse(line);
                    if (socket !== worker) {
                        if (message.type !== "ready" || message.token !== token || worker) {
                            socket.destroy();
                            return;
                        }
                        worker = socket;
                        socket.write(`${JSON.stringify({ type: requestType, plan })}\n`);
                    } else if (message.type === "complete") {
                        complete(Boolean(message.pendingRuntimeReplacement));
                    } else if (message.type === "progress") {
                        const completedEntries = Number(message.completedEntries);
                        const totalEntries = Number(message.totalEntries);
                        if (Number.isFinite(completedEntries) && Number.isFinite(totalEntries)) {
                            onProgress?.({
                                phase: typeof message.phase === "string" ? message.phase : "replace",
                                completedEntries: Math.max(0, completedEntries),
                                totalEntries: Math.max(0, totalEntries),
                            });
                        }
                    } else if (message.type === "error") {
                        failed(new Error(message.message || `The ${operationName} failed.`));
                    } else if (message.type === "runtime-replacement-finalized" && waiter && waiter.action === message.action) {
                        if (message.success) {
                            waiter.resolve();
                            waiter = undefined;
                        } else {
                            failed(new Error(message.message || `${operationName} ${message.action} failed.`));
                        }
                    }
                } catch (error) {
                    if (socket === worker) failed(error instanceof Error ? error : new Error(String(error)));
                    socket.destroy();
                }
            }
        });
        socket.on("error", error => { if (socket === worker) failed(error); });
        socket.on("close", () => {
            sockets.delete(socket);
            if (socket === worker) {
                worker = undefined;
                if (!settled || waiter) failed(new Error("The file replacement IPC connection closed before completion."));
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipePath, () => { server.off("error", reject); resolve(); });
    });
    server.on("error", failed);
    if (process.platform !== "win32") fs.chmodSync(pipePath, 0o600);
    return {
        path: pipePath,
        token,
        completion,
        finalize: action => new Promise<void>((resolve, reject) => {
            if (workerError) return reject(workerError);
            if (!worker || worker.destroyed) return reject(new Error(`The ${operationName} helper is no longer connected.`));
            if (waiter) return reject(new Error(`${operationName} finalization is already pending.`));
            waiter = { action, resolve, reject };
            worker.write(`${JSON.stringify({ type: "runtime-replacement-decision", action })}\n`);
        }),
        close: () => new Promise<void>(resolve => {
            for (const socket of sockets) socket.destroy();
            server.close(() => {
                if (process.platform !== "win32") {
                    try { fs.rmSync(pipePath, { force: true }); } catch { /* Socket cleanup only. */ }
                }
                resolve();
            });
        }),
    };
}

function findExecutable(candidates: Array<string | undefined>): string | undefined {
    return candidates.find(candidate => {
        if (!candidate) return false;
        try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
    });
}

function appendRuntimeBootstrapLog(logPath: string, message: string): void {
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
    } catch { /* Diagnostics never participate in the replacement protocol. */ }
}
