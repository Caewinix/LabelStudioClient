using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;
using System.Text;

namespace LabelStudio.Installer;

internal static class Program
{
    private const int UacCancelledError = 1223;

    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        InstallerOptions? options = null;
        string? diagnosticLogPath = null;
        bool installationCacheValidated = false;
        try
        {
            if (args.Contains("--terminate-managed-runtime-processes", StringComparer.OrdinalIgnoreCase))
            {
                return ManagedRuntimeProcessTerminator.Run(args);
            }

            if (args.Contains("--replace-managed-runtime", StringComparer.OrdinalIgnoreCase))
            {
                RuntimeReplacementOptions replacementOptions = RuntimeReplacementOptions.Parse(args);
                diagnosticLogPath = replacementOptions.DiagnosticLogPath;
                Diagnostics.Append(diagnosticLogPath,
                    $"[installer] Runtime file replacement started. pid={Environment.ProcessId} elevated={IsAdministrator()} needsElevation={replacementOptions.NeedsElevation}");
                if (replacementOptions.NeedsElevation && !IsAdministrator())
                {
                    return await RelaunchElevated(
                        replacementOptions.ToArguments(includeElevatedFlag: true),
                        diagnosticLogPath);
                }
                return await new ManagedRuntimeReplacement(replacementOptions).Run();
            }

            if (args.Contains("--replace-managed-packages", StringComparer.OrdinalIgnoreCase))
            {
                RuntimeReplacementOptions replacementOptions = RuntimeReplacementOptions.Parse(args);
                diagnosticLogPath = replacementOptions.DiagnosticLogPath;
                Diagnostics.Append(diagnosticLogPath,
                    $"[installer] Package file replacement started. pid={Environment.ProcessId} elevated={IsAdministrator()} needsElevation={replacementOptions.NeedsElevation}");
                if (replacementOptions.NeedsElevation && !IsAdministrator())
                {
                    return await RelaunchElevated(
                        replacementOptions.ToArguments(includeElevatedFlag: true),
                        diagnosticLogPath);
                }
                return await new ManagedPackageReplacement(replacementOptions).Run();
            }

            options = InstallerOptions.Parse(args);
            diagnosticLogPath = options.DiagnosticLogPath;
            ValidateInstallationCacheRoot(options);
            installationCacheValidated = true;
            Diagnostics.Append(options.DiagnosticLogPath,
                $"[installer] Started. pid={Environment.ProcessId} elevated={IsAdministrator()} needsElevation={options.NeedsElevation}");

            if (options.NeedsElevation && !IsAdministrator())
            {
                return await RelaunchElevated(
                    options.ToArguments(includeElevatedFlag: true),
                    options.DiagnosticLogPath);
            }

            return await new ElectronRuntimeInstaller(options, IsAdministrator()).Run();
        }
        catch (Win32Exception error) when (error.NativeErrorCode == UacCancelledError)
        {
            Diagnostics.Append(diagnosticLogPath, "[installer] Administrator permission was cancelled by the user.");
            if (installationCacheValidated && options is not null)
                CleanupInstallationCache(options);
            return UacCancelledError;
        }
        catch (Exception error)
        {
            Diagnostics.Append(diagnosticLogPath, $"[installer] Failed: {error}");
            if (installationCacheValidated && options is not null)
                CleanupInstallationCache(options);
            return 1;
        }
    }

    private static async Task<int> RelaunchElevated(
        IReadOnlyList<string> arguments,
        string diagnosticLogPath)
    {
        string executablePath = Environment.ProcessPath
            ?? throw new InvalidOperationException("The installer executable path is unavailable.");
        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            Arguments = string.Join(" ", arguments.Select(QuoteWindowsArgument)),
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = Path.GetDirectoryName(executablePath) ?? Environment.CurrentDirectory,
        };

        Diagnostics.Append(diagnosticLogPath, "[installer] Requesting administrator permission for Label Studio Installer.exe.");
        using Process elevatedProcess = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Windows did not start the elevated installer process.");
        await elevatedProcess.WaitForExitAsync();
        if (elevatedProcess.ExitCode != 0
            && Directory.Exists(Path.GetDirectoryName(diagnosticLogPath)))
        {
            Diagnostics.Append(diagnosticLogPath,
                $"[installer] Elevated installer exited. status={elevatedProcess.ExitCode}");
        }
        return elevatedProcess.ExitCode;
    }

    private static void CleanupInstallationCache(InstallerOptions options)
    {
        Exception? lastError = null;
        for (int attempt = 0; attempt < 5; attempt += 1)
        {
            try
            {
                if (Directory.Exists(options.CacheRoot))
                    Directory.Delete(options.CacheRoot, recursive: true);
                return;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                lastError = error;
                Thread.Sleep(200 * (attempt + 1));
            }
        }

        Diagnostics.Append(
            options.DiagnosticLogPath,
            $"[installer] Electron installation cache cleanup failed: {lastError}");
    }

    private static bool IsAdministrator()
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private static void ValidateInstallationCacheRoot(InstallerOptions options)
    {
        if (!IsPathWithin(options.StagingRoot, options.CacheRoot)
            || !IsPathWithin(options.DiagnosticLogPath, options.CacheRoot)
            || !PathsEqual(Path.GetDirectoryName(options.StagingRoot), options.CacheRoot)
            || !PathsEqual(Path.GetDirectoryName(options.DiagnosticLogPath), options.CacheRoot))
        {
            throw new InvalidOperationException(
                "The Electron staging directory and diagnostic log must be direct children of the Electron installation cache directory.");
        }

        if (IsPathWithin(options.CacheRoot, options.TargetRoot)
            || IsPathWithin(options.TargetRoot, options.CacheRoot))
        {
            throw new InvalidOperationException(
                "The Electron installation cache and application directories must not contain one another.");
        }
    }

    private static bool PathsEqual(string? left, string right)
    {
        if (string.IsNullOrWhiteSpace(left)) return false;
        return string.Equals(
            Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsPathWithin(string childPath, string parentPath)
    {
        string relative = Path.GetRelativePath(
            Path.GetFullPath(parentPath),
            Path.GetFullPath(childPath));
        return relative.Length > 0
            && relative != "."
            && !Path.IsPathRooted(relative)
            && relative != ".."
            && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            && !relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal);
    }

    private static string QuoteWindowsArgument(string value)
    {
        if (value.Length == 0) return "\"\"";
        if (!value.Any(character => char.IsWhiteSpace(character) || character == '"')) return value;

        var result = new StringBuilder(value.Length + 2);
        result.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }
}
