using System.Diagnostics;

namespace LabelStudio.Installer;

internal static class ManagedRuntimeProcessTerminator
{
    public static int Run(string[] args)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("Managed runtime process cleanup is only available on Windows.");
        }

        string runtimeRoot = RequiredValue(args, "--runtime-root");
        runtimeRoot = Path.GetFullPath(runtimeRoot)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        var failures = new List<string>();
        foreach (Process process in Process.GetProcesses())
        {
            using (process)
            {
                if (process.Id == Environment.ProcessId) continue;

                string? executablePath;
                try
                {
                    executablePath = process.MainModule?.FileName;
                }
                catch
                {
                    continue;
                }
                if (string.IsNullOrWhiteSpace(executablePath) || !IsSameOrInside(executablePath, runtimeRoot)) continue;

                try
                {
                    process.Kill(entireProcessTree: true);
                    if (!process.WaitForExit(10_000))
                    {
                        failures.Add($"Process {process.Id} did not exit.");
                    }
                }
                catch (Exception error)
                {
                    failures.Add($"Process {process.Id}: {error.Message}");
                }
            }
        }

        if (failures.Count == 0) return 0;
        Console.Error.WriteLine(string.Join(Environment.NewLine, failures));
        return 1;
    }

    private static string RequiredValue(string[] args, string name)
    {
        for (int index = 0; index + 1 < args.Length; index += 1)
        {
            if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
        }
        throw new ArgumentException($"Missing installer argument: {name}");
    }

    private static bool IsSameOrInside(string candidate, string directory)
    {
        string normalizedCandidate = Path.GetFullPath(candidate)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return string.Equals(normalizedCandidate, directory, StringComparison.OrdinalIgnoreCase)
            || normalizedCandidate.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }
}
