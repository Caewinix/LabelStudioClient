using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace LabelStudio.Installer;

internal sealed class ManagedPackageReplacement(RuntimeReplacementOptions options)
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
        PackageFileTransaction? transaction = null;
        try
        {
            await Send(writer, ("type", "ready"), ("token", options.IpcToken));
            using var request = JsonDocument.Parse(await reader.ReadLineAsync()
                ?? throw new IOException("The parent disconnected before providing prepared package files."));
            if (request.RootElement.GetProperty("type").GetString() != "replace-packages")
                throw new InvalidOperationException("The installer only accepts a local package replacement plan.");
            var plan = request.RootElement.GetProperty("plan");
            string source = plan.GetProperty("stagedRuntime").GetString() ?? throw new ArgumentException("Missing source directory.");
            string target = plan.GetProperty("runtimeRoot").GetString() ?? throw new ArgumentException("Missing target directory.");
            string expectedTarget = Path.Combine(Path.GetDirectoryName(options.ApplicationExecutable)!, "resources", "runtime");
            if (!File.Exists(options.ApplicationExecutable) || !PackageFileTransaction.SamePath(target, expectedTarget))
                throw new InvalidOperationException("The package replacement target does not belong to this application.");

            string[] packageNames = plan.GetProperty("packageNames")
                .EnumerateArray()
                .Select(value => value.GetString() ?? "")
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .ToArray();

            transaction = new PackageFileTransaction(
                source,
                target,
                packageNames,
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
                    ?? throw new IOException("The parent disconnected before validating the installed packages."));
                string? action = decision.RootElement.GetProperty("action").GetString();
                if (decision.RootElement.GetProperty("type").GetString() != "runtime-replacement-decision"
                    || action is not ("commit" or "rollback"))
                    throw new InvalidOperationException("Invalid package replacement decision.");
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
            Diagnostics.Append(options.DiagnosticLogPath, $"[installer] Package replacement failed: {detail}");
            try { await Send(writer, ("type", "error"), ("message", detail)); } catch { /* Parent may have exited. */ }
            return 1;
        }
        finally
        {
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
