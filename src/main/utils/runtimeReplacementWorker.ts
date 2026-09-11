import net from "node:net";
import { RuntimeBootstrapService } from "../services/runtimeBootstrapService";
import type { PreparedPackageReplacement, PreparedRuntimeReplacement } from "./runtimeElevation";

export async function runLinuxRuntimeReplacementWorker(pipePath?: string, token?: string): Promise<void> {
    if (process.platform !== "linux" || !pipePath || !token) {
        throw new Error("The Linux file replacement helper requires an IPC connection and token.");
    }
    const socket = net.createConnection(pipePath);
    socket.setEncoding("utf8");
    socket.on("error", () => { /* Writes and the async reader propagate IPC failures. */ });
    const service = new RuntimeBootstrapService();
    const messages = readMessages(socket);
    const send = (message: unknown): Promise<void> => new Promise((resolve, reject) => {
        socket.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve());
    });
    try {
        await send({ type: "ready", token });
        const request = await messages.next();
        if (request.done || (request.value.type !== "replace-runtime" && request.value.type !== "replace-packages")) {
            throw new Error("No local file replacement plan was received.");
        }
        await send({ type: "progress", phase: "replace", completedEntries: 0, totalEntries: 1 });
        if (request.value.type === "replace-runtime") {
            await service.applyPreparedRuntimeReplacement(request.value.plan as PreparedRuntimeReplacement);
        } else {
            await service.applyPreparedPackageReplacement(request.value.plan as PreparedPackageReplacement);
        }
        await send({ type: "progress", phase: "replace", completedEntries: 1, totalEntries: 1 });
        const pending = service.hasPendingRuntimeReplacement();
        await send({ type: "complete", pendingRuntimeReplacement: pending });
        if (pending) {
            const response = await messages.next();
            if (response.done) throw new Error("The parent disconnected before validating the file replacement.");
            const { type, action } = response.value;
            if (type !== "runtime-replacement-decision" || (action !== "commit" && action !== "rollback")) {
                throw new Error("Invalid file replacement decision.");
            }
            if (action === "commit") await service.commitPendingRuntimeReplacement();
            else await service.rollbackPendingRuntimeReplacement();
            await send({ type: "runtime-replacement-finalized", action, success: true });
        }
    } catch (error) {
        let failure = error;
        if (service.hasPendingRuntimeReplacement()) {
            try { await service.rollbackPendingRuntimeReplacement(); } catch (rollbackError) {
                failure = new Error(`Replacement failed: ${String(error)}\nRollback failed: ${String(rollbackError)}`);
            }
        }
        try { await send({ type: "error", message: String(failure) }); } catch { /* Parent may have exited. */ }
        throw failure;
    } finally {
        socket.end();
        await messages.return(undefined);
        socket.destroy();
    }
}

async function* readMessages(socket: net.Socket): AsyncGenerator<Record<string, unknown>, void> {
    let buffer = "";
    for await (const chunk of socket) {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            yield JSON.parse(line) as Record<string, unknown>;
        }
    }
}
