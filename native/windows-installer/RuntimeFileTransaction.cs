using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace LabelStudio.Installer;

internal sealed class RuntimeFileTransaction
{
    private readonly string source;
    private readonly string target;
    private readonly string prepared;
    private readonly string backup;
    private readonly string? logPath;
    private readonly Action<string, int, int>? progress;
    private readonly bool forceDirectoryContentSwap;
    private bool backupContainsDirectoryContents;
    private bool directoryContentsBackupComplete;
    private bool failedRuntimeContentsRemoved;
    public bool HasBackup { get; private set; }

    public RuntimeFileTransaction(
        string source,
        string target,
        string? logPath,
        Action<string, int, int>? progress = null,
        bool forceDirectoryContentSwap = false)
    {
        this.source = Path.GetFullPath(source).TrimEnd(Path.DirectorySeparatorChar);
        this.target = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
        this.logPath = logPath;
        this.progress = progress;
        this.forceDirectoryContentSwap = forceDirectoryContentSwap;
        prepared = this.target + $".installing-{Guid.NewGuid()}";
        backup = this.target + $".backup-{Guid.NewGuid()}";
    }

    public void Apply()
    {
        using var filePrivileges = WindowsFilePrivilegeScope.Enable(logPath);

        if (Within(source, target) || Within(target, source) || SamePath(target, Path.GetPathRoot(target)!))
            throw new InvalidOperationException("Runtime source and target must be separate directories.");
        RejectLinkedAncestors(source);
        RejectLinkedAncestors(target);
        if (!Directory.Exists(source) || !Directory.EnumerateFileSystemEntries(source).Any())
            throw new DirectoryNotFoundException($"The prepared runtime is empty or missing: {source}");

        Diagnostics.Append(logPath, $"[installer] Copying prepared runtime files. source={source} target={target}");
        // Copy to the target volume before touching the working installation.
        int totalFiles = CountFiles(source);
        int copiedFiles = 0;
        progress?.Invoke("copy", copiedFiles, totalFiles);
        CopyDirectory(source, prepared, ref copiedFiles, totalFiles);
        bool hadRuntime = Directory.Exists(target) && Directory.EnumerateFileSystemEntries(target).Any();
        progress?.Invoke("activate", copiedFiles, totalFiles);
        if (hadRuntime)
        {
            bool movedRuntimeRoot = !forceDirectoryContentSwap
                && MoveDirectoryWithLockRecovery(
                    target,
                    backup,
                    target,
                    "back up the installed runtime",
                    allowDirectoryContentSwap: true);
            if (!movedRuntimeRoot)
            {
                Diagnostics.Append(logPath,
                    "[installer] The runtime root directory could not be renamed after file locks were released; backing up its contents in place.");
                backupContainsDirectoryContents = true;
                HasBackup = true;
                MoveDirectoryContents(target, backup, target, "back up the installed runtime contents");
                directoryContentsBackupComplete = true;
            }
            else
            {
                HasBackup = true;
            }
        }
        else if (Directory.Exists(target))
            RunWithLockRecovery(
                () => DeletePath(target, recursive: false),
                target,
                "remove the empty runtime directory");
        if (backupContainsDirectoryContents)
        {
            MoveDirectoryContents(prepared, target, target, "activate the prepared runtime contents");
            Retry(() => DeletePath(prepared, recursive: false));
        }
        else
        {
            MoveDirectoryWithLockRecovery(prepared, target, prepared, "activate the prepared runtime");
        }
        progress?.Invoke("complete", totalFiles, totalFiles);
        Diagnostics.Append(logPath, "[installer] Runtime files replaced; waiting for application validation.");
    }

    public void Commit()
    {
        using var filePrivileges = WindowsFilePrivilegeScope.Enable(logPath);

        // Once startup is verified, backup cleanup is housekeeping. A partial
        // cleanup failure must never cause rollback from an incomplete backup.
        HasBackup = false;
        try { Retry(() => { if (Directory.Exists(backup)) DeletePath(backup, recursive: true); }); }
        catch (Exception error) { Diagnostics.Append(logPath, $"[installer] Validated runtime backup cleanup failed: {error}"); }
    }

    public void Rollback()
    {
        using var filePrivileges = WindowsFilePrivilegeScope.Enable(logPath);

        if (!HasBackup) return;
        if (backupContainsDirectoryContents)
        {
            if (directoryContentsBackupComplete && !failedRuntimeContentsRemoved)
            {
                DeleteDirectoryContents(target, target, "remove the failed runtime contents");
                failedRuntimeContentsRemoved = true;
            }
            MoveDirectoryContents(backup, target, target, "restore the previous runtime contents");
            Retry(() => DeletePath(backup, recursive: false));
            HasBackup = false;
            Diagnostics.Append(logPath, "[installer] Restored the previous runtime files.");
            return;
        }
        if (Directory.Exists(target))
            RunWithLockRecovery(
                () => DeletePath(target, recursive: true),
                target,
                "remove the failed runtime");
        MoveDirectoryWithLockRecovery(backup, target, backup, "restore the previous runtime");
        HasBackup = false;
        Diagnostics.Append(logPath, "[installer] Restored the previous runtime files.");
    }

    public void CleanPreparedFiles()
    {
        using var filePrivileges = WindowsFilePrivilegeScope.Enable(logPath);

        try { if (Directory.Exists(prepared)) DeletePath(prepared, recursive: true); }
        catch (Exception error) { Diagnostics.Append(logPath, $"[installer] Prepared file cleanup failed: {error}"); }
    }

    private void StopRuntimeProcesses()
    {
        if (OperatingSystem.IsWindows() && ManagedRuntimeProcessTerminator.Run(["--runtime-root", target]) != 0)
            throw new IOException("A process using the installed runtime could not be stopped.");
    }

    private bool MoveDirectoryWithLockRecovery(
        string sourceDirectory,
        string destinationDirectory,
        string runtimeToInspect,
        string operation,
        bool allowDirectoryContentSwap = false)
    {
        return RunWithLockRecovery(
            () => MoveEntry(sourceDirectory, destinationDirectory),
            runtimeToInspect,
            operation,
            allowDirectoryContentSwap);
    }

    private bool RunWithLockRecovery(
        Action fileSystemOperation,
        string runtimeToInspect,
        string operation,
        bool allowDirectoryContentSwap = false)
    {
        try
        {
            fileSystemOperation();
            return true;
        }
        catch (Exception error) when (IsWindowsLockOrAccessError(error))
        {
            DiagnoseAndReleaseRuntimeLocks(runtimeToInspect, operation, error);
        }

        try
        {
            Retry(fileSystemOperation);
            return true;
        }
        catch (Exception error) when (IsWindowsLockOrAccessError(error))
        {
            WindowsRuntimeLockInspection inspection = WindowsRuntimeLockInspector.Inspect(runtimeToInspect, logPath);
            if (allowDirectoryContentSwap && inspection.QuerySucceeded && inspection.ProcessCount == 0)
                return false;
            throw new IOException(
                $"Could not {operation} after releasing managed runtime processes and retrying.\nLock owners: {inspection.Description}",
                error);
        }
    }

    private void MoveDirectoryContents(
        string sourceDirectory,
        string destinationDirectory,
        string runtimeToInspect,
        string operation)
    {
        Directory.CreateDirectory(destinationDirectory);
        foreach (string entry in Directory.EnumerateFileSystemEntries(sourceDirectory).ToArray())
        {
            string destination = Path.Combine(destinationDirectory, Path.GetFileName(entry));
            if (Directory.Exists(destination) || File.Exists(destination))
                throw new IOException($"Runtime transaction destination already exists: {destination}");
            RunWithLockRecovery(
                () => MoveEntry(entry, destination),
                runtimeToInspect,
                operation);
        }
    }

    private void DeleteDirectoryContents(string directory, string runtimeToInspect, string operation)
    {
        if (!Directory.Exists(directory)) Directory.CreateDirectory(directory);
        foreach (string entry in Directory.EnumerateFileSystemEntries(directory).ToArray())
        {
            RunWithLockRecovery(
                () => DeleteEntry(entry),
                runtimeToInspect,
                operation);
        }
    }

    private static void MoveEntry(string sourceEntry, string destinationEntry)
    {
        try
        {
            if (Directory.Exists(sourceEntry)) Directory.Move(sourceEntry, destinationEntry);
            else File.Move(sourceEntry, destinationEntry);
        }
        catch (Exception error) when (IsWindowsAccessDenied(error))
        {
            MovePathWithBackupSemantics(sourceEntry, destinationEntry);
        }
    }

    private static void DeleteEntry(string entry) =>
        DeletePath(entry, recursive: true);

    private void DiagnoseAndReleaseRuntimeLocks(string runtimeToInspect, string operation, Exception moveError)
    {
        Diagnostics.Append(logPath,
            $"[installer] Could not {operation}; querying Windows for processes using the runtime. error={moveError.Message}");
        string lockDetail = WindowsRuntimeLockInspector.Describe(runtimeToInspect, logPath);
        Diagnostics.Append(logPath, $"[installer] Runtime lock query result: {lockDetail}");
        try
        {
            StopRuntimeProcesses();
        }
        catch (Exception error)
        {
            Diagnostics.Append(logPath, $"[installer] Managed runtime process cleanup after move failure failed: {error}");
        }
    }

    private static bool IsWindowsLockOrAccessError(Exception error)
    {
        if (!OperatingSystem.IsWindows()) return false;
        int windowsError = WindowsErrorCode(error);
        return windowsError is 5 or 32 or 33;
    }

    private static bool IsWindowsAccessDenied(Exception error) =>
        OperatingSystem.IsWindows() && WindowsErrorCode(error) == 5;

    private static int WindowsErrorCode(Exception error)
    {
        if (error is Win32Exception win32)
            return win32.NativeErrorCode;
        if (error.InnerException is Win32Exception innerWin32)
            return innerWin32.NativeErrorCode;
        return error.HResult & 0xFFFF;
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

    private static void DeletePath(string path, bool recursive)
    {
        try
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.Directory) != 0)
                Directory.Delete(path, recursive);
            else
                File.Delete(path);
            return;
        }
        catch (FileNotFoundException)
        {
            return;
        }
        catch (DirectoryNotFoundException)
        {
            return;
        }
        catch (Exception error) when (IsWindowsAccessDenied(error))
        {
            DeletePathWithBackupSemantics(path, recursive);
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
                DeletePath(child, recursive: true);
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

    internal static bool SamePath(string first, string second) =>
        string.Equals(Path.GetFullPath(first).TrimEnd(Path.DirectorySeparatorChar),
            Path.GetFullPath(second).TrimEnd(Path.DirectorySeparatorChar),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static bool Within(string candidate, string directory) => SamePath(candidate, directory)
        || candidate.StartsWith(directory + Path.DirectorySeparatorChar,
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static void RejectLinkedAncestors(string directory)
    {
        for (DirectoryInfo? current = new(directory); current is not null; current = current.Parent)
        {
            if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException($"Runtime replacement cannot traverse a linked directory: {current.FullName}");
        }
    }

    private void CopyDirectory(string source, string destination, ref int copiedFiles, int totalFiles)
    {
        Directory.CreateDirectory(destination);
        foreach (string entry in Directory.EnumerateFileSystemEntries(source))
        {
            FileAttributes attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException($"Runtime replacement cannot copy a linked file: {entry}");
            string target = Path.Combine(destination, Path.GetFileName(entry));
            if ((attributes & FileAttributes.Directory) != 0)
            {
                CopyDirectory(entry, target, ref copiedFiles, totalFiles);
            }
            else
            {
                File.Copy(entry, target);
                copiedFiles += 1;
                if (copiedFiles == totalFiles || copiedFiles % 50 == 0)
                    progress?.Invoke("copy", copiedFiles, totalFiles);
            }
        }
    }

    private static int CountFiles(string root)
    {
        int count = 0;
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0)
        {
            foreach (string entry in Directory.EnumerateFileSystemEntries(pending.Pop()))
            {
                FileAttributes attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new IOException($"Runtime replacement cannot copy a linked file: {entry}");
                if ((attributes & FileAttributes.Directory) != 0) pending.Push(entry);
                else count += 1;
            }
        }
        return count;
    }

    private static void Retry(Action operation)
    {
        int[] delays = [0, 100, 250, 500, 1000, 2000, 4000];
        for (int attempt = 0; ; attempt += 1)
        {
            if (delays[attempt] > 0) Thread.Sleep(delays[attempt]);
            try { operation(); return; }
            catch (Exception error) when (attempt < delays.Length - 1 && error is IOException or UnauthorizedAccessException) { }
        }
    }
}