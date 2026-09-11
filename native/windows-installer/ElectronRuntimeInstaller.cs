using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;

namespace LabelStudio.Installer;

internal sealed class ElectronRuntimeInstaller
{
    private readonly InstallerOptions options;
    private readonly bool elevated;
    private readonly List<ReplacementEntry> replacementPlan = [];
    private readonly HashSet<string> backedUpNames = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> committedNames = new(StringComparer.OrdinalIgnoreCase);
    private readonly string transactionRoot;
    private readonly string preparedRoot;
    private readonly string backupRoot;
    private bool parentReadinessSent;

    public ElectronRuntimeInstaller(InstallerOptions options, bool elevated)
    {
        this.options = options;
        this.elevated = elevated;
        transactionRoot = Path.Combine(options.TargetRoot, $".electron-update-transaction-{Guid.NewGuid()}");
        preparedRoot = Path.Combine(transactionRoot, "prepared");
        backupRoot = Path.Combine(transactionRoot, "backup");
    }

    public async Task<int> Run()
    {
        Process? initiatingProcess = null;
        InstallerIpcServer? activePipe = null;
        WindowsFilePrivilegeScope? filePrivileges = null;
        bool replacementApplied = false;

        try
        {
            ValidateOptions();

            initiatingProcess = GetInitiatingProcess();

            activePipe = new InstallerIpcServer(
                options.ActivePipeName,
                options.DiagnosticLogPath);

            await activePipe.Start();

            Diagnostics.Append(
                options.DiagnosticLogPath,
                $"[installer] Windows Electron installer IPC is ready. pipe={options.ActivePipeName}");

            await NotifyParentReady("ACTIVE");
            await WaitForLabelStudioToExit(initiatingProcess);
            initiatingProcess = null;

            /*
             * The installer is already UAC-elevated.
             *
             * Enable SeRestorePrivilege + SeBackupPrivilege only for the
             * filesystem replacement/rollback window.
             *
             * This does NOT change the target ACL or owner.
             * Dispose() restores both privileges to their previous token state.
             */
            filePrivileges = WindowsFilePrivilegeScope.Enable(
                options.DiagnosticLogPath);

            CreateReplacementPlan();
            PrepareReplacement();
            ApplyReplacement();
            ValidateInstalledRuntime();

            replacementApplied = true;

            TryRemovePath(
                transactionRoot,
                "transaction cleanup");

            TryRemovePath(
                options.StagingRoot,
                "staging cleanup");

            Diagnostics.Append(
                options.DiagnosticLogPath,
                $"[installer] Windows Electron runtime {options.ExpectedVersion} was installed successfully.");
        }
        catch (Exception error)
        {
            Diagnostics.Append(
                options.DiagnosticLogPath,
                $"[installer] Electron runtime replacement failed: {error}");

            if (!parentReadinessSent)
            {
                try
                {
                    await NotifyParentReady(
                        $"ERROR: {error.Message}");
                }
                catch
                {
                }
            }

            /*
             * filePrivileges deliberately remains enabled here if it was
             * successfully acquired, so rollback has the same filesystem
             * privileges as the forward replacement.
             */
            RollbackReplacement();

            TryRemovePath(
                transactionRoot,
                "failed transaction cleanup");
        }
        finally
        {
            /*
             * Restore SeRestorePrivilege / SeBackupPrivilege to exactly the
             * state they had before this transaction.
             *
             * No ACL or owner was changed, so there is no filesystem
             * permission state to restore.
             */
            filePrivileges?.Dispose();

            initiatingProcess?.Dispose();

            if (activePipe is not null)
                await activePipe.DisposeAsync();
        }

        ReopenLabelStudio();
        CleanupInstallationCache();
        return replacementApplied ? 0 : 1;
    }

    private void ValidateOptions()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "Label Studio Installer.exe can only run on Windows.");
        }

        if (!Directory.Exists(options.SourceRoot))
        {
            throw new DirectoryNotFoundException(
                $"The expanded Electron runtime does not exist: {options.SourceRoot}");
        }

        if (!Directory.Exists(options.StagingRoot))
        {
            throw new DirectoryNotFoundException(
                $"The Electron staging directory does not exist: {options.StagingRoot}");
        }

        if (!Directory.Exists(options.TargetRoot))
        {
            throw new DirectoryNotFoundException(
                $"The Label Studio installation directory does not exist: {options.TargetRoot}");
        }

        if (Path.GetPathRoot(options.TargetRoot)?
                .TrimEnd(Path.DirectorySeparatorChar)
            == options.TargetRoot.TrimEnd(
                Path.DirectorySeparatorChar))
        {
            throw new InvalidOperationException(
                "The Windows drive root cannot be used as the installer target.");
        }

        if (!IsPathWithin(
                options.SourceRoot,
                options.StagingRoot))
        {
            throw new InvalidOperationException(
                "The expanded Electron runtime must be inside its staging directory.");
        }

        if (IsPathWithin(
                options.StagingRoot,
                options.TargetRoot)
            || IsPathWithin(
                options.TargetRoot,
                options.StagingRoot))
        {
            throw new InvalidOperationException(
                "The Electron staging and installation directories must not contain one another.");
        }

        if (!IsPathWithin(
                options.TargetExecutable,
                options.TargetRoot))
        {
            throw new InvalidOperationException(
                "The Label Studio executable must be inside the installation directory.");
        }

        if (!File.Exists(options.TargetExecutable))
        {
            throw new FileNotFoundException(
                "The installed Label Studio executable does not exist.",
                options.TargetExecutable);
        }

        if (Path.GetFileName(options.SourceExecutableName)
            != options.SourceExecutableName)
        {
            throw new InvalidOperationException(
                "The source Electron executable name is invalid.");
        }

        string sourceExecutable =
            Path.Combine(
                options.SourceRoot,
                options.SourceExecutableName);

        if (!File.Exists(sourceExecutable))
        {
            throw new FileNotFoundException(
                "The expanded Electron runtime executable does not exist.",
                sourceExecutable);
        }
    }

    private Process? GetInitiatingProcess()
    {
        try
        {
            return Process.GetProcessById(
                options.ParentProcessId);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private async Task NotifyParentReady(string status)
    {
        if (parentReadinessSent
            || string.IsNullOrWhiteSpace(
                options.ReadyPipeName))
        {
            return;
        }

        await using var client =
            new NamedPipeClientStream(
                ".",
                options.ReadyPipeName,
                PipeDirection.Out,
                PipeOptions.Asynchronous);

        Diagnostics.Append(
            options.DiagnosticLogPath,
            $"[installer] Connecting to parent readiness IPC. pipe={options.ReadyPipeName}");

        await client.ConnectAsync();

        await using var writer =
            new StreamWriter(
                client,
                new UTF8Encoding(false),
                1024,
                leaveOpen: true)
            {
                AutoFlush = true,
            };

        await writer.WriteLineAsync(status);

        parentReadinessSent = true;

        Diagnostics.Append(
            options.DiagnosticLogPath,
            $"[installer] Sent parent readiness status: {status}");
    }

    private async Task WaitForLabelStudioToExit(
        Process? initiatingProcess)
    {
        Diagnostics.Append(
            options.DiagnosticLogPath,
            $"[installer] Waiting for the initiating Label Studio process to exit. pid={options.ParentProcessId}");

        if (initiatingProcess is not null)
        {
            await initiatingProcess.WaitForExitAsync();
            initiatingProcess.Dispose();
        }

        Diagnostics.Append(
            options.DiagnosticLogPath,
            "[installer] The initiating Label Studio process exited.");
    }

    private void CreateReplacementPlan()
    {
        replacementPlan.Clear();

        foreach (string sourcePath in
                 Directory.EnumerateFileSystemEntries(
                         options.SourceRoot)
                     .OrderBy(
                         value => Path.GetFileName(value),
                         StringComparer.OrdinalIgnoreCase))
        {
            string name =
                Path.GetFileName(sourcePath);

            if (string.Equals(
                    name,
                    options.SourceExecutableName,
                    StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (string.Equals(
                    name,
                    "resources",
                    StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            replacementPlan.Add(
                new ReplacementEntry(
                    sourcePath,
                    name));
        }

        replacementPlan.Add(
            new ReplacementEntry(
                Path.Combine(
                    options.SourceRoot,
                    options.SourceExecutableName),
                Path.GetFileName(
                    options.TargetExecutable)));

        if (replacementPlan.Count == 0)
        {
            throw new InvalidOperationException(
                "The prepared Electron runtime did not contain any replaceable files.");
        }

        if (replacementPlan
                .Select(entry => entry.Name)
                .Distinct(
                    StringComparer.OrdinalIgnoreCase)
                .Count()
            != replacementPlan.Count)
        {
            throw new InvalidOperationException(
                "The prepared Electron runtime contains conflicting replacement entry names.");
        }
    }

    private void PrepareReplacement()
    {
        Diagnostics.Append(
            options.DiagnosticLogPath,
            $"[installer] Preparing {replacementPlan.Count} Electron runtime entries before modifying the installation.");

        RemovePathIfExists(transactionRoot);

        Directory.CreateDirectory(preparedRoot);
        Directory.CreateDirectory(backupRoot);

        foreach (ReplacementEntry entry in
                 replacementPlan)
        {
            CopyPath(
                entry.SourcePath,
                Path.Combine(
                    preparedRoot,
                    entry.Name));
        }

        Diagnostics.Append(
            options.DiagnosticLogPath,
            "[installer] Electron runtime entries are fully prepared.");
    }

    private void ApplyReplacement()
    {
        foreach (ReplacementEntry entry in
                 replacementPlan)
        {
            string preparedPath =
                Path.Combine(
                    preparedRoot,
                    entry.Name);

            string targetPath =
                Path.Combine(
                    options.TargetRoot,
                    entry.Name);

            string backupPath =
                Path.Combine(
                    backupRoot,
                    entry.Name);

            Diagnostics.Append(
                options.DiagnosticLogPath,
                $"[installer] Committing Electron runtime entry: {entry.Name}");

            if (Path.Exists(targetPath))
            {
                MovePath(
                    targetPath,
                    backupPath);

                backedUpNames.Add(
                    entry.Name);
            }

            MovePath(
                preparedPath,
                targetPath);

            committedNames.Add(
                entry.Name);
        }
    }

    private void ValidateInstalledRuntime()
    {
        var executable =
            new FileInfo(
                options.TargetExecutable);

        if (!executable.Exists
            || executable.Length == 0)
        {
            throw new InvalidOperationException(
                "The updated Label Studio executable is missing or empty.");
        }

        FileVersionInfo versionInfo =
            FileVersionInfo.GetVersionInfo(
                options.TargetExecutable);

        string[] candidates =
        [
            versionInfo.ProductVersion ?? "",
            versionInfo.FileVersion ?? ""
        ];

        if (!candidates.Any(
                candidate => VersionMatches(
                    candidate,
                    options.ExpectedVersion)))
        {
            throw new InvalidOperationException(
                $"The updated executable version could not be validated. Expected {options.ExpectedVersion}; " +
                $"product={versionInfo.ProductVersion ?? "unknown"}; " +
                $"file={versionInfo.FileVersion ?? "unknown"}.");
        }

        Diagnostics.Append(
            options.DiagnosticLogPath,
            $"[installer] Validated updated Electron executable version {options.ExpectedVersion}.");
    }

    private void RollbackReplacement()
    {
        if (replacementPlan.Count == 0)
            return;

        Diagnostics.Append(
            options.DiagnosticLogPath,
            "[installer] Rolling back the incomplete Electron runtime replacement.");

        for (int index =
                 replacementPlan.Count - 1;
             index >= 0;
             index -= 1)
        {
            ReplacementEntry entry =
                replacementPlan[index];

            string targetPath =
                Path.Combine(
                    options.TargetRoot,
                    entry.Name);

            string backupPath =
                Path.Combine(
                    backupRoot,
                    entry.Name);

            if (committedNames.Contains(
                    entry.Name))
            {
                TryRemovePath(
                    targetPath,
                    $"remove incomplete {entry.Name}");
            }

            if (backedUpNames.Contains(
                    entry.Name)
                && Path.Exists(
                    backupPath))
            {
                try
                {
                    RemovePathIfExists(
                        targetPath);

                    MovePath(
                        backupPath,
                        targetPath);
                }
                catch (Exception error)
                {
                    Diagnostics.Append(
                        options.DiagnosticLogPath,
                        $"[installer] Could not restore Electron runtime entry {entry.Name}: {error}");
                }
            }
        }

        Diagnostics.Append(
            options.DiagnosticLogPath,
            "[installer] Electron runtime rollback finished.");
    }

    private void ReopenLabelStudio()
    {
        try
        {
            ProcessStartInfo startInfo;

            if (elevated)
            {
                string windowsDirectory =
                    Environment.GetFolderPath(
                        Environment.SpecialFolder.Windows);

                startInfo =
                    new ProcessStartInfo
                    {
                        FileName =
                            Path.Combine(
                                windowsDirectory,
                                "explorer.exe"),
                        Arguments =
                            $"\"{options.TargetExecutable}\"",
                        UseShellExecute = true,
                    };
            }
            else
            {
                startInfo =
                    new ProcessStartInfo
                    {
                        FileName =
                            options.TargetExecutable,
                        UseShellExecute = true,
                        WorkingDirectory =
                            options.TargetRoot,
                    };
            }

            Process.Start(startInfo);
        }
        catch (Exception error)
        {
            Diagnostics.Append(
                options.DiagnosticLogPath,
                $"[installer] Failed to reopen Label Studio after the Electron update: {error}");
        }
    }

    private void CleanupInstallationCache()
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

    private static bool IsPathWithin(
        string candidate,
        string directory)
    {
        string normalizedCandidate =
            Path.GetFullPath(candidate)
                .TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar);

        string normalizedDirectory =
            Path.GetFullPath(directory)
                .TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar);

        return string.Equals(
                   normalizedCandidate,
                   normalizedDirectory,
                   StringComparison.OrdinalIgnoreCase)
               || normalizedCandidate.StartsWith(
                   normalizedDirectory
                   + Path.DirectorySeparatorChar,
                   StringComparison.OrdinalIgnoreCase);
    }

    private static bool VersionMatches(
        string candidate,
        string expected)
    {
        string normalized =
            candidate
                .Trim()
                .TrimStart('v', 'V');

        return string.Equals(
                   normalized,
                   expected,
                   StringComparison.OrdinalIgnoreCase)
               || normalized.StartsWith(
                   expected + ".",
                   StringComparison.OrdinalIgnoreCase)
               || normalized.StartsWith(
                   expected + "-",
                   StringComparison.OrdinalIgnoreCase)
               || normalized.StartsWith(
                   expected + "+",
                   StringComparison.OrdinalIgnoreCase);
    }

    private static void CopyPath(
        string source,
        string destination)
    {
        FileAttributes attributes =
            File.GetAttributes(source);

        if (attributes.HasFlag(
                FileAttributes.ReparsePoint))
        {
            throw new InvalidOperationException(
                $"The Electron update contains an unsupported reparse point: {source}");
        }

        if (!attributes.HasFlag(
                FileAttributes.Directory))
        {
            Directory.CreateDirectory(
                Path.GetDirectoryName(
                    destination)!);

            File.Copy(
                source,
                destination,
                overwrite: false);

            return;
        }

        Directory.CreateDirectory(
            destination);

        foreach (string child in
                 Directory.EnumerateFileSystemEntries(
                     source))
        {
            CopyPath(
                child,
                Path.Combine(
                    destination,
                    Path.GetFileName(child)));
        }
    }

    private static void MovePath(
        string source,
        string destination)
    {
        Directory.CreateDirectory(
            Path.GetDirectoryName(
                destination)!);

        try
        {
            FileAttributes attributes =
                File.GetAttributes(source);

            if (attributes.HasFlag(
                    FileAttributes.Directory))
            {
                Directory.Move(
                    source,
                    destination);
            }
            else
            {
                File.Move(
                    source,
                    destination);
            }
        }
        catch (Exception error) when (IsWindowsAccessDenied(error))
        {
            MovePathWithBackupSemantics(
                source,
                destination);
        }
    }

    private static void RemovePathIfExists(
        string path)
    {
        try
        {
            FileAttributes attributes =
                File.GetAttributes(path);

            if (attributes.HasFlag(
                    FileAttributes.Directory)
                && !attributes.HasFlag(
                    FileAttributes.ReparsePoint))
            {
                foreach (string child in
                         Directory.EnumerateFileSystemEntries(
                             path))
                {
                    RemovePathIfExists(child);
                }

                File.SetAttributes(
                    path,
                    attributes
                    & ~FileAttributes.ReadOnly);

                Directory.Delete(path);
                return;
            }

            File.SetAttributes(
                path,
                attributes
                & ~FileAttributes.ReadOnly);

            if (attributes.HasFlag(
                    FileAttributes.Directory))
            {
                Directory.Delete(path);
            }
            else
            {
                File.Delete(path);
            }
        }
        catch (FileNotFoundException)
        {
        }
        catch (DirectoryNotFoundException)
        {
        }
        catch (Exception error) when (IsWindowsAccessDenied(error))
        {
            DeletePathWithBackupSemantics(path, recursive: true);
        }
    }

    private const uint DeleteAccess = 0x00010000;
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileWriteAttributes = 0x00000100;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const int FileRenameInfo = 3;
    private const int FileDispositionInfo = 4;
    private const int FileDispositionInfoEx = 21;
    private const uint FileDispositionDelete = 0x00000001;
    private const uint FileDispositionIgnoreReadonlyAttribute = 0x00000010;
    private const int ErrorInvalidParameter = 87;
    private const int ErrorNotSupported = 50;

    private static void MovePathWithBackupSemantics(
        string sourcePath,
        string destinationPath)
    {
        string fullDestination = Path.GetFullPath(destinationPath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullDestination)!);

        using SafeFileHandle handle = OpenBackupHandle(
            sourcePath,
            DeleteAccess | FileReadAttributes);

        byte[] fileNameBytes = System.Text.Encoding.Unicode.GetBytes(fullDestination);
        int rootDirectoryOffset = IntPtr.Size == 8 ? 8 : 4;
        int fileNameLengthOffset = rootDirectoryOffset + IntPtr.Size;
        int fileNameOffset = fileNameLengthOffset + sizeof(uint);
        int bufferSize = fileNameOffset + fileNameBytes.Length + sizeof(char);
        IntPtr buffer = Marshal.AllocHGlobal(bufferSize);

        try
        {
            Marshal.Copy(new byte[bufferSize], 0, buffer, bufferSize);
            Marshal.WriteInt32(buffer, 0, 0); // ReplaceIfExists = FALSE.
            Marshal.WriteIntPtr(buffer, rootDirectoryOffset, IntPtr.Zero);
            Marshal.WriteInt32(buffer, fileNameLengthOffset, fileNameBytes.Length);
            Marshal.Copy(fileNameBytes, 0, IntPtr.Add(buffer, fileNameOffset), fileNameBytes.Length);

            if (!SetFileInformationByHandle(
                    handle,
                    FileRenameInfo,
                    buffer,
                    (uint)bufferSize))
            {
                ThrowWindowsFileError(
                    Marshal.GetLastWin32Error(),
                    $"Could not rename {sourcePath} to {fullDestination} with Windows backup/restore semantics");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void DeletePathWithBackupSemantics(string path, bool recursive)
    {
        FileAttributes attributes = GetAttributesWithBackupSemantics(path);
        bool isDirectory = (attributes & FileAttributes.Directory) != 0;
        bool isReparsePoint = (attributes & FileAttributes.ReparsePoint) != 0;

        if (isDirectory && recursive && !isReparsePoint)
        {
            foreach (string child in Directory.EnumerateFileSystemEntries(path).ToArray())
                RemovePathIfExists(child);
        }

        using SafeFileHandle handle = OpenBackupHandle(
            path,
            DeleteAccess | FileReadAttributes | FileWriteAttributes);

        var dispositionEx = new FileDispositionInfoExData
        {
            Flags = FileDispositionDelete | FileDispositionIgnoreReadonlyAttribute,
        };

        if (SetFileInformationByHandle(
                handle,
                FileDispositionInfoEx,
                ref dispositionEx,
                (uint)Marshal.SizeOf<FileDispositionInfoExData>()))
        {
            return;
        }

        int extendedError = Marshal.GetLastWin32Error();
        if (extendedError != ErrorInvalidParameter
            && extendedError != ErrorNotSupported)
        {
            ThrowWindowsFileError(
                extendedError,
                $"Could not delete {path} with Windows backup/restore semantics");
        }

        var disposition = new FileDispositionInfoData
        {
            DeleteFile = 1,
        };

        if (!SetFileInformationByHandle(
                handle,
                FileDispositionInfo,
                ref disposition,
                (uint)Marshal.SizeOf<FileDispositionInfoData>()))
        {
            ThrowWindowsFileError(
                Marshal.GetLastWin32Error(),
                $"Could not delete {path} with Windows backup/restore semantics");
        }
    }

    private static FileAttributes GetAttributesWithBackupSemantics(string path)
    {
        using SafeFileHandle handle = OpenBackupHandle(
            path,
            FileReadAttributes);

        if (!GetFileInformationByHandle(handle, out ByHandleFileInformation information))
        {
            ThrowWindowsFileError(
                Marshal.GetLastWin32Error(),
                $"Could not read attributes for {path} with Windows backup semantics");
        }

        return (FileAttributes)information.FileAttributes;
    }

    private static SafeFileHandle OpenBackupHandle(string path, uint desiredAccess)
    {
        SafeFileHandle handle = CreateFileW(
            Path.GetFullPath(path),
            desiredAccess,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero);

        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            ThrowWindowsFileError(
                error,
                $"Could not open {path} with Windows backup/restore semantics");
        }

        return handle;
    }

    private static bool IsWindowsAccessDenied(Exception error)
    {
        if (!OperatingSystem.IsWindows())
            return false;

        if (error is Win32Exception win32)
            return win32.NativeErrorCode == 5;

        if (error.InnerException is Win32Exception innerWin32)
            return innerWin32.NativeErrorCode == 5;

        return (error.HResult & 0xFFFF) == 5;
    }

    private static void ThrowWindowsFileError(int error, string message) =>
        throw new IOException(
            $"{message}. Windows error={error}.",
            new Win32Exception(error));

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfoData
    {
        public byte DeleteFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfoExData
    {
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint LowDateTime;
        public uint HighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public FileTime CreationTime;
        public FileTime LastAccessTime;
        public FileTime LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        IntPtr fileInformation,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        ref FileDispositionInfoData fileInformation,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        ref FileDispositionInfoExData fileInformation,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation fileInformation);

    private void TryRemovePath(
        string path,
        string operation)
    {
        try
        {
            RemovePathIfExists(path);
        }
        catch (Exception error)
        {
            Diagnostics.Append(
                options.DiagnosticLogPath,
                $"[installer] Failed during {operation}: {error}");
        }
    }

    /*
     * Temporarily enables the privileges used by Windows backup/restore
     * operations without changing any file or directory ACL/owner.
     *
     * The caller must already be running with an elevated token that contains
     * SeRestorePrivilege and SeBackupPrivilege.
     */

    private sealed record ReplacementEntry(
        string SourcePath,
        string Name);
}
