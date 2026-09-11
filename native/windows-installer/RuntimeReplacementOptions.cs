namespace LabelStudio.Installer;

internal sealed class RuntimeReplacementOptions
{
    public string CommandFlag { get; init; } = "--replace-managed-runtime";
    public required string ApplicationExecutable { get; init; }
    public required string PipePath { get; init; }
    public required string IpcToken { get; init; }
    public required string DiagnosticLogPath { get; init; }
    public required bool NeedsElevation { get; init; }
    public required bool Elevated { get; init; }

    public static RuntimeReplacementOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string? commandFlag = null;
        for (int index = 0; index < args.Length; index += 1)
        {
            string argument = args[index];
            if (argument is "--replace-managed-runtime" or "--replace-managed-packages")
            {
                commandFlag = argument;
                flags.Add(argument);
                continue;
            }
            if (argument is "--needs-elevation" or "--elevated")
            {
                flags.Add(argument);
                continue;
            }
            if (index + 1 >= args.Length || !argument.StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException($"Invalid runtime replacement argument: {argument}");
            values.Add(argument, args[++index]);
        }
        string Required(string name) => values.TryGetValue(name, out string? value) && value.Length > 0
            ? value : throw new ArgumentException($"Missing runtime replacement argument: {name}");
        return new RuntimeReplacementOptions
        {
            CommandFlag = commandFlag ?? "--replace-managed-runtime",
            ApplicationExecutable = Path.GetFullPath(Required("--application-executable")),
            PipePath = Required("--pipe-path"),
            IpcToken = Required("--ipc-token"),
            DiagnosticLogPath = Path.GetFullPath(Required("--diagnostic-log")),
            NeedsElevation = flags.Contains("--needs-elevation"),
            Elevated = flags.Contains("--elevated"),
        };
    }

    public IReadOnlyList<string> ToArguments(bool includeElevatedFlag)
    {
        var arguments = new List<string>
        {
            CommandFlag,
            "--application-executable", ApplicationExecutable,
            "--pipe-path", PipePath,
            "--ipc-token", IpcToken,
            "--diagnostic-log", DiagnosticLogPath,
        };
        if (NeedsElevation) arguments.Add("--needs-elevation");
        if (includeElevatedFlag || Elevated) arguments.Add("--elevated");
        return arguments;
    }
}
