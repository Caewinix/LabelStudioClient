using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using LabelStudio.Installer;

foreach (string scenario in new[] { "commit", "rollback", "disconnect", "first-install", "empty-source", "wrong-target" })
{
    await RunScenario(scenario).WaitAsync(TimeSpan.FromSeconds(30));
    Console.WriteLine($"PASS {scenario}");
}

foreach (string scenario in new[] { "package-commit", "package-rollback" })
{
    RunPackageScenario(scenario);
    Console.WriteLine($"PASS {scenario}");
}

foreach (string scenario in new[] { "content-commit", "content-rollback" })
{
    RunContentSwapScenario(scenario);
    Console.WriteLine($"PASS {scenario}");
}

static async Task RunScenario(string scenario)
{
    string root = Path.Combine(AppContext.BaseDirectory, "fixtures", Guid.NewGuid().ToString());
    string source = Path.Combine(root, "cache", "prepared");
    string target = Path.Combine(root, "app", "resources", "runtime");
    string executable = Path.Combine(root, "app", "Label Studio.exe");
    Directory.CreateDirectory(source);
    Directory.CreateDirectory(target);
    File.WriteAllText(executable, "test executable, never launched");
    if (scenario != "first-install") File.WriteAllText(Path.Combine(target, "old.dist-info"), "old");
    if (scenario != "empty-source") File.WriteAllText(Path.Combine(source, "new.dist-info"), "new");
    string pipeName = "ls-" + Guid.NewGuid().ToString("N")[..12];
    await using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
    var options = new RuntimeReplacementOptions
    {
        ApplicationExecutable = executable,
        PipePath = pipeName,
        IpcToken = Guid.NewGuid().ToString(),
        // Logging must fail without changing any of the protocol or filesystem results.
        DiagnosticLogPath = Path.Combine(executable, "unwritable.log"),
        NeedsElevation = false,
        Elevated = false,
    };
    Task<int> worker = new ManagedRuntimeReplacement(options).Run();
    try
    {
        await server.WaitForConnectionAsync();
        var reader = new StreamReader(server, Encoding.UTF8, false, 4096, leaveOpen: true);
        var writer = new StreamWriter(server, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true };
        using var ready = JsonDocument.Parse((await reader.ReadLineAsync())!);
        Check(ready.RootElement.GetProperty("token").GetString() == options.IpcToken, "IPC authentication");
        await writer.WriteLineAsync(JsonSerializer.Serialize(new
        {
            type = "replace-runtime",
            plan = new { stagedRuntime = source, runtimeRoot = scenario == "wrong-target" ? root : target },
        }));
        var (result, sawProgress) = await ReadReplacementResult(reader);
        using (result)
        {
            if (scenario is "empty-source" or "wrong-target")
            {
                Check(result.RootElement.GetProperty("type").GetString() == "error", "failure reported through IPC");
                Check(await worker == 1, "failed helper exits");
                Check(File.Exists(Path.Combine(target, "old.dist-info")), "old installation preserved");
                return;
            }
            Check(sawProgress, "replacement progress reported through IPC");
            Check(result.RootElement.GetProperty("type").GetString() == "complete", "replacement complete");
            Check(File.Exists(Path.Combine(target, "new.dist-info")), "new files installed");
            Check(!File.Exists(Path.Combine(target, "old.dist-info")), "old files not merged into new runtime");
            bool pending = result.RootElement.GetProperty("pendingRuntimeReplacement").GetBoolean();
            Check(pending == (scenario != "first-install"), "backup based on existing files");
            if (pending)
            {
                Check(Directory.EnumerateDirectories(Path.GetDirectoryName(target)!, "runtime.backup-*").Any(), "backup retained before validation");
                if (scenario == "disconnect")
                {
                    await server.DisposeAsync();
                }
                else
                {
                    await writer.WriteLineAsync(JsonSerializer.Serialize(new { type = "runtime-replacement-decision", action = scenario }));
                    using var finalized = JsonDocument.Parse((await reader.ReadLineAsync())!);
                    Check(finalized.RootElement.GetProperty("success").GetBoolean(), "decision acknowledged");
                }
            }
            Check(await worker == (scenario == "disconnect" ? 1 : 0), "helper exits after completion");
            bool restored = scenario is "rollback" or "disconnect";
            Check(File.Exists(Path.Combine(target, "old.dist-info")) == restored, "rollback state");
            Check(File.Exists(Path.Combine(target, "new.dist-info")) != restored, "installed state");
            Check(!Directory.EnumerateDirectories(Path.GetDirectoryName(target)!, "runtime.backup-*").Any(), "final backup cleanup");
        }
    }
    finally
    {
        Directory.Delete(root, true);
    }
}

static async Task<(JsonDocument Result, bool SawProgress)> ReadReplacementResult(StreamReader reader)
{
    bool sawProgress = false;
    while (true)
    {
        var message = JsonDocument.Parse(await reader.ReadLineAsync()
            ?? throw new IOException("Installer IPC closed before reporting a result."));
        if (message.RootElement.GetProperty("type").GetString() != "progress") return (message, sawProgress);

        int completed = message.RootElement.GetProperty("completedEntries").GetInt32();
        int total = message.RootElement.GetProperty("totalEntries").GetInt32();
        Check(completed >= 0 && total >= 0 && completed <= total, "valid replacement progress");
        sawProgress = true;
        message.Dispose();
    }
}

static void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

static void RunContentSwapScenario(string scenario)
{
    string root = Path.Combine(AppContext.BaseDirectory, "fixtures", Guid.NewGuid().ToString());
    string source = Path.Combine(root, "cache", "prepared");
    string target = Path.Combine(root, "app", "resources", "runtime");
    try
    {
        Directory.CreateDirectory(Path.Combine(source, "new-directory"));
        Directory.CreateDirectory(Path.Combine(target, "old-directory"));
        File.WriteAllText(Path.Combine(source, "new-directory", "new.txt"), "new");
        File.WriteAllText(Path.Combine(target, "old-directory", "old.txt"), "old");

        var transaction = new RuntimeFileTransaction(
            source,
            target,
            null,
            forceDirectoryContentSwap: true);
        transaction.Apply();

        Check(transaction.HasBackup, "content-swap backup retained before validation");
        Check(File.Exists(Path.Combine(target, "new-directory", "new.txt")), "content-swap installed new runtime");
        Check(!Directory.Exists(Path.Combine(target, "old-directory")), "content-swap removed old runtime files");

        if (scenario == "content-rollback")
        {
            transaction.Rollback();
            Check(File.Exists(Path.Combine(target, "old-directory", "old.txt")), "content-swap rollback restored old runtime");
            Check(!Directory.Exists(Path.Combine(target, "new-directory")), "content-swap rollback removed new runtime");
        }
        else
        {
            transaction.Commit();
            Check(File.Exists(Path.Combine(target, "new-directory", "new.txt")), "content-swap commit retained new runtime");
        }

        Check(!Directory.EnumerateDirectories(Path.GetDirectoryName(target)!, "runtime.backup-*").Any(),
            "content-swap finalized backup cleanup");
    }
    finally
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }
}

static void RunPackageScenario(string scenario)
{
    string root = Path.Combine(AppContext.BaseDirectory, "fixtures", Guid.NewGuid().ToString());
    string source = Path.Combine(root, "cache", "prepared");
    string target = Path.Combine(root, "app", "resources", "runtime");
    try
    {
        CreateDistribution(target, "label-studio", "1.22.0", "old");
        CreateDistribution(target, "unrelated-package", "9.0.0", "keep");
        CreateDistribution(source, "label-studio", "1.23.0", "new");

        var transaction = new PackageFileTransaction(
            source,
            target,
            ["label-studio"],
            null);
        transaction.Apply();
        Check(transaction.HasBackup, "package backup retained before validation");
        Check(!File.Exists(Path.Combine(target, "Lib", "site-packages", "label_studio", "old.py")), "old package file removed");
        Check(File.Exists(Path.Combine(target, "Lib", "site-packages", "label_studio", "new.py")), "new package file installed");
        Check(!Directory.Exists(Path.Combine(target, "Lib", "site-packages", "label_studio-1.22.0.dist-info")), "old package metadata removed");
        Check(Directory.Exists(Path.Combine(target, "Lib", "site-packages", "label_studio-1.23.0.dist-info")), "new package metadata installed");
        Check(File.Exists(Path.Combine(target, "Lib", "site-packages", "unrelated_package", "keep.py")), "unrelated package preserved");

        if (scenario == "package-rollback")
        {
            transaction.Rollback();
            Check(File.Exists(Path.Combine(target, "Lib", "site-packages", "label_studio", "old.py")), "old package restored");
            Check(!File.Exists(Path.Combine(target, "Lib", "site-packages", "label_studio", "new.py")), "new package removed during rollback");
            Check(Directory.Exists(Path.Combine(target, "Lib", "site-packages", "label_studio-1.22.0.dist-info")), "old package metadata restored");
            Check(!Directory.Exists(Path.Combine(target, "Lib", "site-packages", "label_studio-1.23.0.dist-info")), "new package metadata removed");
            Check(File.Exists(Path.Combine(target, "Lib", "site-packages", "unrelated_package", "keep.py")), "unrelated package preserved after rollback");
        }
        else
        {
            transaction.Commit();
            Check(!Directory.EnumerateDirectories(Path.Combine(root, "cache"), "package.backup-*").Any(), "package backup cleaned after commit");
        }
    }
    finally
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }
}

static void CreateDistribution(string runtimeRoot, string rawName, string version, string marker)
{
    string sitePackages = Path.Combine(runtimeRoot, "Lib", "site-packages");
    string moduleName = rawName.Replace("-", "_");
    string moduleDirectory = Path.Combine(sitePackages, moduleName);
    string metadataDirectory = Path.Combine(sitePackages, $"{moduleName}-{version}.dist-info");
    Directory.CreateDirectory(moduleDirectory);
    Directory.CreateDirectory(metadataDirectory);
    File.WriteAllText(Path.Combine(moduleDirectory, $"{marker}.py"), marker);
    File.WriteAllText(Path.Combine(metadataDirectory, "METADATA"), $"Name: {rawName}\nVersion: {version}\n");
    File.WriteAllText(Path.Combine(metadataDirectory, "RECORD"),
        $"{moduleName}/{marker}.py,,\n{Path.GetFileName(metadataDirectory)}/METADATA,,\n{Path.GetFileName(metadataDirectory)}/RECORD,,\n");
}
