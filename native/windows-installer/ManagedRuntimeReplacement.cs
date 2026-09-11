using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace LabelStudio.Installer;

// This worker accepts only local files and commit/rollback decisions. Package
// resolution, downloads, pip and runtime validation belong to the main app.
internal sealed class ManagedRuntimeReplacement(RuntimeReplacementOptions options)
{
    public async Task<int> Run()
    {
        const string prefix = @"\\.\pipe\";
        string pipeName = options.PipePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? options.PipePath[prefix.Length..] : options.PipePath;
        await using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(30_000);
        using var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, leaveOpen: true);
        var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true };
        RuntimeFileTransaction? transaction = null;
        try
        {
            await Send(writer, ("type", "ready"), ("token", options.IpcToken));
            using var request = JsonDocument.Parse(await reader.ReadLineAsync()
                ?? throw new IOException("The parent disconnected before providing prepared files."));
            if (request.RootElement.GetProperty("type").GetString() != "replace-runtime")
                throw new InvalidOperationException("The installer only accepts a local runtime replacement plan.");
            var plan = request.RootElement.GetProperty("plan");
            string source = plan.GetProperty("stagedRuntime").GetString() ?? throw new ArgumentException("Missing source directory.");
            string target = plan.GetProperty("runtimeRoot").GetString() ?? throw new ArgumentException("Missing target directory.");
            string expectedTarget = Path.Combine(Path.GetDirectoryName(options.ApplicationExecutable)!, "resources", "runtime");
            if (!File.Exists(options.ApplicationExecutable) || !RuntimeFileTransaction.SamePath(target, expectedTarget))
                throw new InvalidOperationException("The runtime replacement target does not belong to this application.");

            transaction = new RuntimeFileTransaction(
                source,
                target,
                options.DiagnosticLogPath,
                (phase, completedEntries, totalEntries) => SendProgress(
                    writer,
                    phase,
                    completedEntries,
                    totalEntries));
            transaction.Apply();
            await Send(writer, ("type", "complete"), ("pendingRuntimeReplacement", transaction.HasBackup));
            if (transaction.HasBackup)
            {
                using var decision = JsonDocument.Parse(await reader.ReadLineAsync()
                    ?? throw new IOException("The parent disconnected before validating the installed runtime."));
                string? action = decision.RootElement.GetProperty("action").GetString();
                if (decision.RootElement.GetProperty("type").GetString() != "runtime-replacement-decision"
                    || action is not ("commit" or "rollback"))
                    throw new InvalidOperationException("Invalid runtime replacement decision.");
                if (action == "commit") transaction.Commit();
                else transaction.Rollback();
                await Send(writer, ("type", "runtime-replacement-finalized"), ("action", action), ("success", true));
            }
            return 0;
        }
        catch (Exception error)
        {
            string detail = error.ToString();
            try { transaction?.Rollback(); } catch (Exception rollbackError) { detail += $"\nRollback failed: {rollbackError}"; }
            Diagnostics.Append(options.DiagnosticLogPath, $"[installer] Runtime replacement failed: {detail}");
            try { await Send(writer, ("type", "error"), ("message", detail)); } catch { /* Parent may have exited. */ }
            return 1;
        }
        finally
        {
            transaction?.CleanPreparedFiles();
            try { await writer.DisposeAsync(); } catch { /* The parent may have disconnected. */ }
        }
    }

    private static async Task Send(StreamWriter writer, params (string Name, object? Value)[] fields)
    {
        await writer.WriteLineAsync(Serialize(fields));
    }

    private static void SendProgress(StreamWriter writer, string phase, int completedEntries, int totalEntries)
    {
        writer.WriteLine(Serialize([
            ("type", "progress"),
            ("phase", phase),
            ("completedEntries", completedEntries),
            ("totalEntries", totalEntries),
        ]));
    }

    private static string Serialize(params (string Name, object? Value)[] fields)
    {
        // Explicit JSON writing remains usable in the trimmed, self-contained build.
        using var stream = new MemoryStream();
        using (var json = new Utf8JsonWriter(stream))
        {
            json.WriteStartObject();
            foreach (var (name, value) in fields)
            {
                if (value is bool flag) json.WriteBoolean(name, flag);
                else if (value is int integer) json.WriteNumber(name, integer);
                else json.WriteString(name, value?.ToString());
            }
            json.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }
}
