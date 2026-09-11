namespace LabelStudio.Installer;

internal sealed class InstallerOptions
{
    public required string CacheRoot { get; init; }
    public required string SourceRoot { get; init; }
    public required string StagingRoot { get; init; }
    public required string TargetRoot { get; init; }
    public required string SourceExecutableName { get; init; }
    public required string TargetExecutable { get; init; }
    public required string ExpectedVersion { get; init; }
    public required int ParentProcessId { get; init; }
    public required string ReadyPipeName { get; init; }
    public required string ActivePipeName { get; init; }
    public required string DiagnosticLogPath { get; init; }
    public required bool NeedsElevation { get; init; }
    public required bool Elevated { get; init; }

    public static InstallerOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < args.Length; index += 1)
        {
            string argument = args[index];
            if (argument is "--needs-elevation" or "--elevated")
            {
                flags.Add(argument);
                continue;
            }
            if (index + 1 >= args.Length || !argument.StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException($"Invalid installer argument: {argument}");
            }
            values[argument] = args[index + 1];
            index += 1;
        }

        string Required(string name) => values.TryGetValue(name, out string? value) && value.Length > 0
            ? value
            : throw new ArgumentException($"Missing installer argument: {name}");

        if (!int.TryParse(Required("--parent-pid"), out int parentProcessId) || parentProcessId <= 0)
        {
            throw new ArgumentException("The installer parent process id is invalid.");
        }

        return new InstallerOptions
        {
            CacheRoot = Path.GetFullPath(Required("--cache-root")),
            SourceRoot = Path.GetFullPath(Required("--source-root")),
            StagingRoot = Path.GetFullPath(Required("--staging-root")),
            TargetRoot = Path.GetFullPath(Required("--target-root")),
            SourceExecutableName = Required("--source-executable-name"),
            TargetExecutable = Path.GetFullPath(Required("--target-executable")),
            ExpectedVersion = Required("--expected-version").TrimStart('v', 'V'),
            ParentProcessId = parentProcessId,
            ReadyPipeName = Required("--ready-pipe"),
            ActivePipeName = Required("--active-pipe"),
            DiagnosticLogPath = Path.GetFullPath(Required("--diagnostic-log")),
            NeedsElevation = flags.Contains("--needs-elevation"),
            Elevated = flags.Contains("--elevated"),
        };
    }

    public IReadOnlyList<string> ToArguments(bool includeElevatedFlag)
    {
        var arguments = new List<string>
        {
            "--cache-root", CacheRoot,
            "--source-root", SourceRoot,
            "--staging-root", StagingRoot,
            "--target-root", TargetRoot,
            "--source-executable-name", SourceExecutableName,
            "--target-executable", TargetExecutable,
            "--expected-version", ExpectedVersion,
            "--parent-pid", ParentProcessId.ToString(),
            "--ready-pipe", ReadyPipeName,
            "--active-pipe", ActivePipeName,
            "--diagnostic-log", DiagnosticLogPath,
        };
        if (NeedsElevation) arguments.Add("--needs-elevation");
        if (includeElevatedFlag || Elevated) arguments.Add("--elevated");
        return arguments;
    }
}
