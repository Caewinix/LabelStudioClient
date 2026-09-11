using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace LabelStudio.Installer;

internal sealed class PackageFileTransaction
{
    private readonly string source;
    private readonly string target;
    private readonly string backup;
    private readonly HashSet<string> packageNames;
    private readonly string? logPath;
    private readonly Action<string, int, int>? progress;
    private bool mutated;

    public bool HasBackup { get; private set; }

    public PackageFileTransaction(
        string source,
        string target,
        IEnumerable<string> packageNames,
        string? logPath,
        Action<string, int, int>? progress = null)
    {
        this.source = Path.GetFullPath(source).TrimEnd(Path.DirectorySeparatorChar);
        this.target = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
        this.logPath = logPath;
        this.progress = progress;
        this.packageNames = packageNames
            .Select(NormalizePackageName)
            .Where(name => name.Length > 0)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        backup = Path.Combine(
            Path.GetDirectoryName(this.source) ?? Path.GetTempPath(),
            $"package.backup-{Guid.NewGuid()}");
    }

    public void Apply()
    {
        using var filePrivileges = WindowsFilePrivilegeScope.Enable(logPath);

        if (packageNames.Count == 0)
            throw new InvalidOperationException("No package names were provided.");

        if (Within(source, target)
            || Within(target, source)
            || SamePath(target, Path.GetPathRoot(target)!))
        {
            throw new InvalidOperationException(
                "Package source and target must be separate directories.");
        }

        RejectLinkedAncestors(source);
        RejectLinkedAncestors(target);

        if (!Directory.Exists(source)
            || !Directory.EnumerateFileSystemEntries(source).Any())
        {
            throw new DirectoryNotFoundException(
                $"The prepared package source is empty or missing: {source}");
        }

        if (!Directory.Exists(target))
        {
            throw new DirectoryNotFoundException(
                $"The managed runtime is missing: {target}");
        }

        Diagnostics.Append(
            logPath,
            $"[installer] Replacing package files. source={source} target={target}");

        var targetDistributions = ReadDistributions(target);
        var sourceDistributions = ReadDistributions(source);

        var backupPaths =
            PackagePaths(
                    targetDistributions,
                    target,
                    packageNames)
                .ToList();

        var sourcePackagePaths =
            PackagePaths(
                    sourceDistributions,
                    source,
                    packageNames)
                .ToList();

        int totalFiles =
            Math.Max(
                1,
                sourcePackagePaths.Count(
                    path => !Directory.Exists(path)));

        int copiedFiles = 0;

        progress?.Invoke(
            "backup",
            0,
            totalFiles);

        CopyRelativePaths(
            target,
            backup,
            backupPaths,
            ref copiedFiles,
            Math.Max(totalFiles, backupPaths.Count),
            "backup");

        HasBackup =
            Directory.Exists(backup)
            && Directory.EnumerateFileSystemEntries(backup).Any();

        StopRuntimeProcesses();

        mutated = true;

        RemovePackages(
            targetDistributions,
            target,
            packageNames);

        copiedFiles = 0;

        progress?.Invoke(
            "copy",
            copiedFiles,
            totalFiles);

        CopyRelativePaths(
            source,
            target,
            sourcePackagePaths,
            ref copiedFiles,
            totalFiles,
            "copy");

        progress?.Invoke(
            "complete",
            totalFiles,
            totalFiles);

        Diagnostics.Append(
            logPath,
            "[installer] Package files replaced; waiting for application validation.");
    }

    public void Commit()
    {
        using var filePrivileges = WindowsFilePrivilegeScope.Enable(logPath);

        mutated = false;
        HasBackup = false;

        try
        {
            Retry(() =>
            {
                if (Directory.Exists(backup))
                    DeletePath(backup, recursive: true);
            });
        }
        catch (Exception error)
        {
            Diagnostics.Append(
                logPath,
                $"[installer] Validated package backup cleanup failed: {error}");
        }
    }

    public void Rollback()
    {
        if (!mutated && !HasBackup)
            return;

        using var filePrivileges = WindowsFilePrivilegeScope.Enable(logPath);

        StopRuntimeProcesses();

        RemovePackages(
            ReadDistributions(target),
            target,
            packageNames);

        if (Directory.Exists(backup))
        {
            int copiedFiles = 0;

            CopyTreeContents(
                backup,
                target,
                ref copiedFiles);

            Retry(() =>
                DeletePath(
                    backup,
                    recursive: true));
        }

        mutated = false;
        HasBackup = false;

        Diagnostics.Append(
            logPath,
            "[installer] Restored the previous package files.");
    }

    private void StopRuntimeProcesses()
    {
        if (OperatingSystem.IsWindows()
            && ManagedRuntimeProcessTerminator.Run(
                ["--runtime-root", target]) != 0)
        {
            throw new IOException(
                "A process using the installed runtime could not be stopped.");
        }
    }

    private static List<Distribution> ReadDistributions(
        string runtimeRoot)
    {
        var distributions =
            new List<Distribution>();

        var seen =
            new HashSet<string>(
                PathComparer);

        foreach (string sitePackagesDirectory in
                 SitePackagesDirectories(runtimeRoot))
        {
            if (!Directory.Exists(sitePackagesDirectory))
                continue;

            foreach (string entry in
                     Directory.EnumerateFileSystemEntries(
                         sitePackagesDirectory))
            {
                string name =
                    Path.GetFileName(entry);

                bool isDistInfo =
                    name.EndsWith(
                        ".dist-info",
                        StringComparison.OrdinalIgnoreCase);

                bool isEggInfo =
                    name.EndsWith(
                        ".egg-info",
                        StringComparison.OrdinalIgnoreCase);

                if (!isDistInfo
                    && !isEggInfo)
                {
                    continue;
                }

                if (!seen.Add(
                        PathIdentity(entry)))
                {
                    continue;
                }

                string metadataPath =
                    File.Exists(entry)
                        ? entry
                        : Path.Combine(
                            entry,
                            isDistInfo
                                ? "METADATA"
                                : "PKG-INFO");

                var metadata =
                    ParseDistributionMetadata(
                        metadataPath);

                // var directoryIdentity = ParseDistributionDirectoryName(name);

                string packageName =
                    metadata?.Name ?? "";

                string version =
                    metadata?.Version ?? "";

                packageName =
                    NormalizePackageName(
                        packageName);

                if (packageName.Length == 0
                    || version.Length == 0)
                {
                    continue;
                }

                distributions.Add(
                    new Distribution(
                        packageName,
                        version,
                        sitePackagesDirectory,
                        Path.GetFullPath(entry)));
            }
        }

        return distributions;
    }

    private static IEnumerable<string> SitePackagesDirectories(
        string runtimeRoot)
    {
        var directories =
            new HashSet<string>(
                PathComparer)
            {
                Path.Combine(
                    runtimeRoot,
                    "Lib",
                    "site-packages"),
                Path.Combine(
                    runtimeRoot,
                    "lib",
                    "site-packages"),
            };

        string libRoot =
            Path.Combine(
                runtimeRoot,
                "lib");

        if (Directory.Exists(libRoot))
        {
            foreach (string pythonDirectory in
                     Directory.EnumerateDirectories(
                         libRoot,
                         "python*"))
            {
                directories.Add(
                    Path.Combine(
                        pythonDirectory,
                        "site-packages"));
            }
        }

        string frameworkVersions =
            Path.Combine(
                runtimeRoot,
                "Library",
                "Frameworks",
                "Python.framework",
                "Versions");

        if (Directory.Exists(frameworkVersions))
        {
            foreach (string versionDirectory in
                     Directory.EnumerateDirectories(
                         frameworkVersions))
            {
                string frameworkLib =
                    Path.Combine(
                        versionDirectory,
                        "lib");

                if (!Directory.Exists(frameworkLib))
                    continue;

                foreach (string pythonDirectory in
                         Directory.EnumerateDirectories(
                             frameworkLib,
                             "python*"))
                {
                    directories.Add(
                        Path.Combine(
                            pythonDirectory,
                            "site-packages"));
                }
            }
        }

        return directories;
    }

    private static IEnumerable<string> PackagePaths(
        IEnumerable<Distribution> distributions,
        string runtimeRoot,
        HashSet<string> packageNames)
    {
        var paths =
            new Dictionary<string, string>(
                PathComparer);

        foreach (Distribution distribution in
                 distributions)
        {
            if (!packageNames.Contains(
                    distribution.Name))
            {
                continue;
            }

            AddPath(
                distribution.InfoPath);

            foreach (string filePath in
                     DistributionRecordPaths(
                         distribution,
                         runtimeRoot))
            {
                AddPath(filePath);
            }
        }

        return paths.Values;

        void AddPath(
            string filePath)
        {
            string fullPath =
                Path.GetFullPath(filePath);

            if (!Within(
                    fullPath,
                    runtimeRoot)
                || SamePath(
                    fullPath,
                    runtimeRoot))
            {
                return;
            }

            paths[
                PathIdentity(fullPath)] =
                fullPath;
        }
    }

    private static IEnumerable<string> DistributionRecordPaths(
        Distribution distribution,
        string runtimeRoot)
    {
        var paths =
            new Dictionary<string, string>(
                PathComparer);

        var pycacheDirectories =
            new Dictionary<string, string[]>(
                PathComparer);

        var entries =
            DistributionRecordEntries(
                    distribution)
                .ToList();

        foreach (string relativePath in entries)
        {
            if (string.IsNullOrWhiteSpace(
                    relativePath))
            {
                continue;
            }

            string destination =
                Path.GetFullPath(
                    Path.Combine(
                        distribution.SitePackagesDirectory,
                        relativePath.Replace(
                            '/',
                            Path.DirectorySeparatorChar)));

            AddPath(destination);

            if (!destination.EndsWith(
                    ".py",
                    StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string extensionlessPath =
                destination[..^3];

            AddPath(
                extensionlessPath + ".pyc");

            AddPath(
                extensionlessPath + ".pyo");

            string sourceBaseName =
                Path.GetFileName(
                    extensionlessPath);

            string pycacheDirectory =
                Path.Combine(
                    Path.GetDirectoryName(
                        destination)!,
                    "__pycache__");

            if (!pycacheDirectories.TryGetValue(
                    pycacheDirectory,
                    out string[]? pycacheEntries))
            {
                pycacheEntries =
                    Directory.Exists(
                        pycacheDirectory)
                        ? Directory.GetFileSystemEntries(
                            pycacheDirectory)
                        : [];

                pycacheDirectories[
                    pycacheDirectory] =
                    pycacheEntries;
            }

            foreach (string pycacheEntry in
                     pycacheEntries)
            {
                string name =
                    Path.GetFileName(
                        pycacheEntry);

                if (!name.StartsWith(
                        sourceBaseName + ".",
                        StringComparison.Ordinal))
                {
                    continue;
                }

                if (!name.EndsWith(
                        ".pyc",
                        StringComparison.OrdinalIgnoreCase)
                    && !name.EndsWith(
                        ".pyo",
                        StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                AddPath(pycacheEntry);
            }
        }

        return paths.Values;

        void AddPath(
            string filePath)
        {
            string fullPath =
                Path.GetFullPath(filePath);

            if (!Within(
                    fullPath,
                    runtimeRoot)
                || SamePath(
                    fullPath,
                    runtimeRoot))
            {
                return;
            }

            paths[
                PathIdentity(fullPath)] =
                fullPath;
        }
    }

    private static IEnumerable<string> DistributionRecordEntries(
        Distribution distribution)
    {
        string recordPath =
            Path.Combine(
                distribution.InfoPath,
                "RECORD");

        if (File.Exists(recordPath))
        {
            foreach (string line in
                     File.ReadLines(recordPath))
            {
                string? relativePath =
                    PythonRecordRelativePath(line);

                if (!string.IsNullOrWhiteSpace(
                        relativePath))
                {
                    yield return relativePath;
                }
            }

            yield break;
        }

        string installedFilesPath =
            Path.Combine(
                distribution.InfoPath,
                "installed-files.txt");

        if (!File.Exists(installedFilesPath))
            yield break;

        foreach (string line in
                 File.ReadLines(installedFilesPath))
        {
            string relativePath =
                line.Trim();

            if (relativePath.Length <= 0)
                continue;

            string absolutePath =
                Path.GetFullPath(
                    Path.Combine(
                        distribution.InfoPath,
                        relativePath));

            yield return Path.GetRelativePath(
                distribution.SitePackagesDirectory,
                absolutePath);
        }
    }

    private static string? PythonRecordRelativePath(
        string line)
    {
        if (!line.StartsWith('"'))
        {
            return line
                .Split(',', 2)[0]
                .Trim();
        }

        var value =
            new System.Text.StringBuilder();

        for (int index = 1;
             index < line.Length;
             index += 1)
        {
            char character =
                line[index];

            if (character != '"')
            {
                value.Append(character);
                continue;
            }

            if (index + 1 < line.Length
                && line[index + 1] == '"')
            {
                value.Append('"');
                index += 1;
                continue;
            }

            return value
                .ToString()
                .Trim();
        }

        return null;
    }

    private static void RemovePackages(
        IEnumerable<Distribution> installed,
        string runtimeRoot,
        HashSet<string> packageNames)
    {
        var distributions =
            installed.ToList();

        var protectedPaths =
            new HashSet<string>(
                PathComparer);

        foreach (Distribution distribution in
                 distributions)
        {
            if (packageNames.Contains(
                    distribution.Name))
            {
                continue;
            }

            foreach (string filePath in
                     PackagePaths(
                         [distribution],
                         runtimeRoot,
                         new HashSet<string>(
                             [distribution.Name],
                             StringComparer.OrdinalIgnoreCase)))
            {
                protectedPaths.Add(
                    PathIdentity(filePath));
            }
        }

        var emptyDirectories =
            new HashSet<string>(
                PathComparer);

        foreach (Distribution distribution in
                 distributions.Where(
                     distribution =>
                         packageNames.Contains(
                             distribution.Name)))
        {
            foreach (string filePath in
                     DistributionRecordPaths(
                         distribution,
                         runtimeRoot))
            {
                RemovePath(
                    filePath,
                    distribution.SitePackagesDirectory,
                    protectedPaths,
                    emptyDirectories);
            }

            Retry(() =>
            {
                if (Directory.Exists(
                        distribution.InfoPath))
                {
                    DeletePath(
                        distribution.InfoPath,
                        recursive: true);
                }
                else if (File.Exists(
                             distribution.InfoPath))
                {
                    DeletePath(
                        distribution.InfoPath,
                        recursive: false);
                }
            });

            CollectEmptySitePackageDirectories(
                Path.GetDirectoryName(
                    distribution.InfoPath)!,
                distribution.SitePackagesDirectory,
                emptyDirectories);
        }

        foreach (string directory in
                 emptyDirectories
                     .OrderByDescending(
                         value => value.Length))
        {
            try
            {
                if (!SamePath(
                        directory,
                        runtimeRoot)
                    && Directory.Exists(
                        directory)
                    && !Directory
                        .EnumerateFileSystemEntries(
                            directory)
                        .Any())
                {
                    DeletePath(
                        directory,
                        recursive: false);
                }
            }
            catch
            {
                // Keep directories that became non-empty.
            }
        }
    }

    private static void RemovePath(
        string filePath,
        string sitePackagesDirectory,
        HashSet<string> protectedPaths,
        HashSet<string> emptyDirectories)
    {
        string identity =
            PathIdentity(filePath);

        if (protectedPaths.Contains(identity))
            return;

        if (Directory.Exists(filePath))
        {
            try
            {
                if (!Directory
                    .EnumerateFileSystemEntries(
                        filePath)
                    .Any())
                {
                    DeletePath(
                        filePath,
                        recursive: false);
                }
            }
            catch (DirectoryNotFoundException)
            {
            }
        }
        else if (File.Exists(filePath))
        {
            Retry(() =>
                DeletePath(filePath, recursive: false));
        }

        CollectEmptySitePackageDirectories(
            Path.GetDirectoryName(filePath)
            ?? sitePackagesDirectory,
            sitePackagesDirectory,
            emptyDirectories);
    }

    private void CopyRelativePaths(
        string sourceRoot,
        string targetRoot,
        IEnumerable<string> sourcePaths,
        ref int copiedFiles,
        int totalFiles,
        string phase)
    {
        var copied =
            new HashSet<string>(
                PathComparer);

        foreach (string sourcePath in
                 sourcePaths)
        {
            if (!File.Exists(sourcePath)
                && !Directory.Exists(sourcePath))
            {
                continue;
            }

            string relative =
                Path.GetRelativePath(
                    sourceRoot,
                    sourcePath);

            if (relative.StartsWith(
                    "..",
                    StringComparison.Ordinal)
                || Path.IsPathRooted(relative))
            {
                continue;
            }

            string destination =
                Path.GetFullPath(
                    Path.Combine(
                        targetRoot,
                        relative));

            if (!copied.Add(
                    PathIdentity(destination)))
            {
                continue;
            }

            CopyPath(
                sourcePath,
                destination,
                ref copiedFiles,
                totalFiles,
                phase);
        }
    }

    private void CopyTreeContents(
        string sourceRoot,
        string targetRoot,
        ref int copiedFiles)
    {
        if (!Directory.Exists(sourceRoot))
            return;

        foreach (string entry in
                 Directory.EnumerateFileSystemEntries(
                     sourceRoot))
        {
            CopyPath(
                entry,
                Path.Combine(
                    targetRoot,
                    Path.GetFileName(entry)),
                ref copiedFiles,
                1,
                "copy");
        }
    }

    private void CopyPath(
        string sourcePath,
        string destination,
        ref int copiedFiles,
        int totalFiles,
        string phase)
    {
        FileAttributes attributes =
            File.GetAttributes(sourcePath);

        if ((attributes
             & FileAttributes.ReparsePoint) != 0)
        {
            throw new IOException(
                $"Package replacement cannot copy a linked file: {sourcePath}");
        }

        if ((attributes
             & FileAttributes.Directory) != 0)
        {
            Directory.CreateDirectory(
                destination);

            foreach (string entry in
                     Directory.EnumerateFileSystemEntries(
                         sourcePath))
            {
                CopyPath(
                    entry,
                    Path.Combine(
                        destination,
                        Path.GetFileName(entry)),
                    ref copiedFiles,
                    totalFiles,
                    phase);
            }

            return;
        }

        Directory.CreateDirectory(
            Path.GetDirectoryName(
                destination)!);

        CopyFile(
            sourcePath,
            destination);

        copiedFiles += 1;

        if (copiedFiles == totalFiles
            || copiedFiles % 50 == 0)
        {
            progress?.Invoke(
                phase,
                Math.Min(
                    copiedFiles,
                    totalFiles),
                totalFiles);
        }
    }

    private const uint DeleteAccess = 0x00010000;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileWriteAttributes = 0x00000100;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint CreateAlways = 2;
    private const uint OpenExisting = 3;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const int FileDispositionInfo = 4;
    private const int FileDispositionInfoEx = 21;
    private const uint FileDispositionDelete = 0x00000001;
    private const uint FileDispositionIgnoreReadonlyAttribute = 0x00000010;
    private const int ErrorInvalidParameter = 87;
    private const int ErrorNotSupported = 50;

    private static void CopyFile(string sourcePath, string destinationPath)
    {
        try
        {
            File.Copy(
                sourcePath,
                destinationPath,
                overwrite: true);
        }
        catch (Exception error) when (IsWindowsAccessDenied(error))
        {
            CopyFileWithBackupSemantics(sourcePath, destinationPath);
        }
    }

    private static void CopyFileWithBackupSemantics(
        string sourcePath,
        string destinationPath)
    {
        Directory.CreateDirectory(
            Path.GetDirectoryName(destinationPath)!);

        using SafeFileHandle sourceHandle = OpenBackupHandle(
            sourcePath,
            GenericRead | FileReadAttributes,
            OpenExisting);

        using SafeFileHandle destinationHandle = OpenBackupHandle(
            destinationPath,
            GenericWrite | FileWriteAttributes,
            CreateAlways);

        using var sourceStream = new FileStream(
            sourceHandle,
            FileAccess.Read);

        using var destinationStream = new FileStream(
            destinationHandle,
            FileAccess.Write);

        sourceStream.CopyTo(destinationStream);
        destinationStream.Flush(flushToDisk: true);
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
            DeleteAccess | FileReadAttributes | FileWriteAttributes,
            OpenExisting);

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
            FileReadAttributes,
            OpenExisting);

        if (!GetFileInformationByHandle(handle, out ByHandleFileInformation information))
        {
            ThrowWindowsFileError(
                Marshal.GetLastWin32Error(),
                $"Could not read attributes for {path} with Windows backup semantics");
        }

        return (FileAttributes)information.FileAttributes;
    }

    private static SafeFileHandle OpenBackupHandle(
        string path,
        uint desiredAccess,
        uint creationDisposition)
    {
        SafeFileHandle handle = CreateFileW(
            Path.GetFullPath(path),
            desiredAccess,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            creationDisposition,
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

    private static void CollectEmptySitePackageDirectories(
        string directory,
        string sitePackagesDirectory,
        HashSet<string> directories)
    {
        string root =
            Path.GetFullPath(
                sitePackagesDirectory);

        string current =
            Path.GetFullPath(
                directory);

        while (!SamePath(
                   current,
                   root)
               && Within(
                   current,
                   root))
        {
            directories.Add(current);

            string? parent =
                Path.GetDirectoryName(
                    current);

            if (parent is null
                || SamePath(
                    parent,
                    current))
            {
                break;
            }

            current = parent;
        }
    }

    private static (string? Name, string? Version)?
        ParseDistributionMetadata(
            string metadataPath)
    {
        string? name = null;
        string? version = null;

        try
        {
            foreach (string line in
                     File.ReadLines(
                         metadataPath))
            {
                if (name is null
                    && line.StartsWith(
                        "Name:",
                        StringComparison.OrdinalIgnoreCase))
                {
                    name =
                        line["Name:".Length..]
                            .Trim();
                }
                else if (version is null
                         && line.StartsWith(
                             "Version:",
                             StringComparison.OrdinalIgnoreCase))
                {
                    version =
                        line["Version:".Length..]
                            .Trim();
                }

                if (name is not null
                    && version is not null)
                {
                    break;
                }
            }
        }
        catch
        {
            return null;
        }

        return (name, version);
    }

    private static (string? Name, string? Version)
        ParseDistributionDirectoryName(
            string directoryName)
    {
        string stem =
            directoryName.EndsWith(
                ".dist-info",
                StringComparison.OrdinalIgnoreCase)
                ? directoryName[
                    ..^".dist-info".Length]
                : directoryName.EndsWith(
                    ".egg-info",
                    StringComparison.OrdinalIgnoreCase)
                    ? directoryName[
                        ..^".egg-info".Length]
                    : directoryName;

        string[] parts =
            stem.Split('-');

        for (int index = 1;
             index < parts.Length;
             index += 1)
        {
            string version =
                parts[index];

            if (version.Length == 0
                || !char.IsDigit(
                    version[0]))
            {
                continue;
            }

            return (
                string.Join(
                    "-",
                    parts[..index]),
                version);
        }

        return (null, null);
    }

    private static string NormalizePackageName(
        string name)
    {
        var builder =
            new System.Text.StringBuilder();

        bool lastWasSeparator = false;

        foreach (char raw in
                 name.Trim())
        {
            char character =
                char.ToLowerInvariant(raw);

            bool separator =
                character is '-'
                    or '_'
                    or '.';

            if (separator)
            {
                if (!lastWasSeparator
                    && builder.Length > 0)
                {
                    builder.Append('-');
                }

                lastWasSeparator = true;
                continue;
            }

            builder.Append(character);
            lastWasSeparator = false;
        }

        if (builder.Length > 0
            && builder[^1] == '-')
        {
            builder.Length -= 1;
        }

        return builder.ToString();
    }

    internal static bool SamePath(
        string first,
        string second) =>
        string.Equals(
            Path.GetFullPath(first)
                .TrimEnd(
                    Path.DirectorySeparatorChar),
            Path.GetFullPath(second)
                .TrimEnd(
                    Path.DirectorySeparatorChar),
            OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal);

    private static bool Within(
        string candidate,
        string directory) =>
        SamePath(
            candidate,
            directory)
        || Path.GetFullPath(candidate)
            .StartsWith(
                Path.GetFullPath(directory)
                    .TrimEnd(
                        Path.DirectorySeparatorChar)
                + Path.DirectorySeparatorChar,
                OperatingSystem.IsWindows()
                    ? StringComparison.OrdinalIgnoreCase
                    : StringComparison.Ordinal);

    private static void RejectLinkedAncestors(
        string directory)
    {
        for (DirectoryInfo? current =
                 new(directory);
             current is not null;
             current = current.Parent)
        {
            if (current.Exists
                && (current.Attributes
                    & FileAttributes.ReparsePoint) != 0)
            {
                throw new IOException(
                    $"Package replacement cannot traverse a linked directory: {current.FullName}");
            }
        }
    }

    private static string PathIdentity(
        string path) =>
        OperatingSystem.IsWindows()
            ? Path.GetFullPath(path)
                .ToLowerInvariant()
            : Path.GetFullPath(path);

    private static IEqualityComparer<string>
        PathComparer =>
        OperatingSystem.IsWindows()
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;

    private static void Retry(
        Action operation)
    {
        int[] delays =
            [0, 100, 250, 500, 1000, 2000, 4000];

        for (int attempt = 0; ;
             attempt += 1)
        {
            if (delays[attempt] > 0)
                Thread.Sleep(delays[attempt]);

            try
            {
                operation();
                return;
            }
            catch (Exception error)
                when (attempt < delays.Length - 1
                      && error is IOException
                          or UnauthorizedAccessException)
            {
            }
        }
    }

    /*
     * Temporarily enables Windows backup/restore privileges on the current
     * elevated process token.
     *
     * This does not modify filesystem ACLs, inheritance, or ownership.
     * Dispose() restores each privilege to the state it had before the scope.
     */

    private sealed record Distribution(
        string Name,
        string Version,
        string SitePackagesDirectory,
        string InfoPath);
}
