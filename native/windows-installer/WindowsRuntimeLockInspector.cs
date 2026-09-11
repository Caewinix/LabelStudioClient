using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace LabelStudio.Installer;

internal static class WindowsRuntimeLockInspector
{
    private const int ErrorSuccess = 0;
    private const int ErrorMoreData = 234;
    private const int SessionKeyLength = 32;

    public static string Describe(string runtimeRoot, string? logPath) =>
        Inspect(runtimeRoot, logPath).Description;

    public static WindowsRuntimeLockInspection Inspect(string runtimeRoot, string? logPath)
    {
        if (!OperatingSystem.IsWindows())
            return new("lock inspection is only available on Windows", 0, false);
        if (!Directory.Exists(runtimeRoot))
            return new($"runtime directory no longer exists: {runtimeRoot}", 0, false);

        try
        {
            string[] files = Directory.EnumerateFiles(runtimeRoot, "*", SearchOption.AllDirectories).ToArray();
            if (files.Length == 0)
                return new("no runtime files were available to inspect", 0, false);

            IReadOnlyList<LockingProcess> processes = Query(files);
            if (processes.Count == 0)
                return new("Windows Restart Manager reported no process holding the registered runtime files", 0, true);

            return new(
                string.Join("; ", processes.Select(process =>
                    $"pid={process.ProcessId} name={process.ApplicationName} path={process.ExecutablePath ?? "unavailable"} service={process.ServiceName ?? "none"}")),
                processes.Count,
                true);
        }
        catch (Exception error)
        {
            Diagnostics.Append(logPath, $"[installer] Windows runtime lock inspection failed: {error}");
            return new($"lock inspection failed: {error.Message}", 0, false);
        }
    }

    private static IReadOnlyList<LockingProcess> Query(string[] files)
    {
        var sessionKey = new StringBuilder(SessionKeyLength + 1);
        int result = RmStartSession(out uint sessionHandle, 0, sessionKey);
        ThrowIfFailed(result, "start a Restart Manager session");
        try
        {
            result = RmRegisterResources(sessionHandle, (uint)files.Length, files, 0, null, 0, null);
            ThrowIfFailed(result, "register runtime files with Restart Manager");

            uint needed = 0;
            uint count = 0;
            uint rebootReasons = 0;
            result = RmGetList(sessionHandle, out needed, ref count, null, ref rebootReasons);
            if (result == ErrorSuccess && needed == 0) return [];
            if (result != ErrorMoreData) ThrowIfFailed(result, "query Restart Manager lock owners");

            while (true)
            {
                var nativeProcesses = new RmProcessInfo[checked((int)needed)];
                count = needed;
                result = RmGetList(sessionHandle, out needed, ref count, nativeProcesses, ref rebootReasons);
                if (result == ErrorMoreData) continue;
                ThrowIfFailed(result, "read Restart Manager lock owners");

                return nativeProcesses.Take((int)count)
                    .Select(process => new LockingProcess(
                        process.Process.ProcessId,
                        string.IsNullOrWhiteSpace(process.ApplicationName) ? "unknown" : process.ApplicationName,
                        string.IsNullOrWhiteSpace(process.ServiceShortName) ? null : process.ServiceShortName,
                        ExecutablePath(process.Process.ProcessId)))
                    .ToArray();
            }
        }
        finally
        {
            RmEndSession(sessionHandle);
        }
    }

    private static string? ExecutablePath(int processId)
    {
        try
        {
            using Process process = Process.GetProcessById(processId);
            return process.MainModule?.FileName;
        }
        catch
        {
            return null;
        }
    }

    private static void ThrowIfFailed(int result, string operation)
    {
        if (result != ErrorSuccess) throw new IOException($"Windows could not {operation} (error {result}).");
    }

    private sealed record LockingProcess(
        int ProcessId,
        string ApplicationName,
        string? ServiceName,
        string? ExecutablePath);

    [StructLayout(LayoutKind.Sequential)]
    private struct RmUniqueProcess
    {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RmProcessInfo
    {
        public RmUniqueProcess Process;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string ApplicationName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string ServiceShortName;

        public uint ApplicationType;
        public uint AppStatus;
        public uint TerminalServicesSessionId;

        [MarshalAs(UnmanagedType.Bool)]
        public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint sessionHandle, int sessionFlags, StringBuilder sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(
        uint sessionHandle,
        uint fileCount,
        string[] fileNames,
        uint applicationCount,
        [In] RmUniqueProcess[]? applications,
        uint serviceCount,
        string[]? serviceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(
        uint sessionHandle,
        out uint processInfoNeeded,
        ref uint processInfoCount,
        [In, Out] RmProcessInfo[]? affectedApplications,
        ref uint rebootReasons);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint sessionHandle);
}

internal sealed record WindowsRuntimeLockInspection(
    string Description,
    int ProcessCount,
    bool QuerySucceeded);
