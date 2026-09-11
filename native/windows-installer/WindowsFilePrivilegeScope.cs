using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace LabelStudio.Installer;

/// <summary>
/// Temporarily enables SeRestorePrivilege and SeBackupPrivilege on the
/// current process token.
///
/// This class only adjusts token privilege state. It does not modify
/// filesystem ACLs, ownership, or inheritance.
///
/// Dispose restores every privilege state changed by this scope.
/// </summary>
internal sealed class WindowsFilePrivilegeScope : IDisposable
{
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustPrivileges = 0x0020;
    private const uint SePrivilegeEnabled = 0x00000002;

    private const int ErrorSuccess = 0;
    private const int ErrorNotAllAssigned = 1300;

    private const string SeRestorePrivilegeName = "SeRestorePrivilege";
    private const string SeBackupPrivilegeName = "SeBackupPrivilege";

    private readonly string? logPath;
    private readonly List<TokenPrivileges> previousStates = [];

    private IntPtr tokenHandle;
    private bool disposed;

    private WindowsFilePrivilegeScope(
        IntPtr tokenHandle,
        string? logPath)
    {
        this.tokenHandle = tokenHandle;
        this.logPath = logPath;
    }

    /// <summary>
    /// Enables SeRestorePrivilege and SeBackupPrivilege for the lifetime
    /// of the returned scope.
    ///
    /// AdjustTokenPrivileges can only enable privileges already present
    /// in the current process token; it cannot add missing privileges.
    /// </summary>
    public static WindowsFilePrivilegeScope Enable(
        string? logPath = null)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "Windows filesystem privileges are only available on Windows.");
        }

        if (!OpenProcessToken(
                GetCurrentProcess(),
                TokenQuery | TokenAdjustPrivileges,
                out IntPtr tokenHandle))
        {
            int error = Marshal.GetLastWin32Error();

            throw new Win32Exception(
                error,
                "Could not open the installer process token.");
        }

        var scope = new WindowsFilePrivilegeScope(
            tokenHandle,
            logPath);

        try
        {
            /*
             * Restore privilege is the write/delete side.
             * Backup privilege supplies protected read/traverse access.
             */
            scope.EnablePrivilege(
                SeRestorePrivilegeName);

            scope.EnablePrivilege(
                SeBackupPrivilegeName);

            Diagnostics.Append(
                logPath,
                "[installer] Enabled SeRestorePrivilege and SeBackupPrivilege.");

            return scope;
        }
        catch
        {
            /*
             * If one privilege was already changed before the next one fails,
             * restore that state and close the token handle.
             */
            scope.Dispose();
            throw;
        }
    }

    private void EnablePrivilege(
        string privilegeName)
    {
        if (!LookupPrivilegeValue(
                null,
                privilegeName,
                out Luid luid))
        {
            int lookupError = Marshal.GetLastWin32Error();

            throw new Win32Exception(
                lookupError,
                $"Could not resolve Windows privilege {privilegeName}.");
        }

        var requestedState = new TokenPrivileges
        {
            PrivilegeCount = 1,
            Privileges = new LuidAndAttributes
            {
                Luid = luid,
                Attributes = SePrivilegeEnabled,
            },
        };

        /*
         * AdjustTokenPrivileges may return TRUE while setting
         * ERROR_NOT_ALL_ASSIGNED. Clear the thread last-error value first
         * and always inspect it after the call.
         */
        Marshal.SetLastPInvokeError(
            ErrorSuccess);

        bool adjusted = AdjustTokenPrivileges(
            tokenHandle,
            disableAllPrivileges: false,
            ref requestedState,
            Marshal.SizeOf<TokenPrivileges>(),
            out TokenPrivileges previousState,
            out _);

        int error = Marshal.GetLastPInvokeError();

        if (!adjusted)
        {
            throw new Win32Exception(
                error,
                $"Could not enable Windows privilege {privilegeName}.");
        }

        if (error == ErrorNotAllAssigned)
        {
            throw new InvalidOperationException(
                $"The installer process token does not contain {privilegeName}. " +
                "The installer must be running with an elevated Windows token " +
                "that has the required backup/restore privileges.");
        }

        if (error != ErrorSuccess)
        {
            throw new Win32Exception(
                error,
                $"Windows returned an error while enabling privilege {privilegeName}.");
        }

        /*
         * PreviousState contains the prior state only for a privilege whose
         * state was actually changed. If it was already enabled,
         * PrivilegeCount is normally zero and there is nothing to restore.
         */
        if (previousState.PrivilegeCount != 0)
        {
            previousStates.Add(
                previousState);
        }

        Diagnostics.Append(
            logPath,
            $"[installer] Enabled Windows privilege: {privilegeName}");
    }

    public void Dispose()
    {
        if (disposed)
            return;

        disposed = true;

        if (tokenHandle == IntPtr.Zero)
            return;

        try
        {
            /*
             * Restore in reverse order so the process token returns to the
             * state it had before this scope enabled any privilege.
             */
            for (int index = previousStates.Count - 1;
                 index >= 0;
                 index--)
            {
                TokenPrivileges previousState =
                    previousStates[index];

                Marshal.SetLastPInvokeError(
                    ErrorSuccess);

                bool restored = AdjustTokenPrivileges(
                    tokenHandle,
                    disableAllPrivileges: false,
                    ref previousState,
                    Marshal.SizeOf<TokenPrivileges>(),
                    out _,
                    out _);

                int restoreError = Marshal.GetLastPInvokeError();

                if (!restored || restoreError != ErrorSuccess)
                {
                    Diagnostics.Append(
                        logPath,
                        $"[installer] Could not restore a Windows privilege " +
                        $"to its previous state. win32={restoreError}");
                }
            }
        }
        finally
        {
            if (!CloseHandle(tokenHandle))
            {
                int closeError = Marshal.GetLastWin32Error();

                Diagnostics.Append(
                    logPath,
                    $"[installer] Could not close the Windows process token handle. " +
                    $"win32={closeError}");
            }

            tokenHandle = IntPtr.Zero;

            Diagnostics.Append(
                logPath,
                "[installer] Restored Windows filesystem privileges to their previous token state.");
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LuidAndAttributes
    {
        public Luid Luid;
        public uint Attributes;
    }

    /*
     * One privilege is adjusted per call, so one LUID_AND_ATTRIBUTES entry
     * is sufficient for TOKEN_PRIVILEGES here.
     */
    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivileges
    {
        public uint PrivilegeCount;
        public LuidAndAttributes Privileges;
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport(
        "kernel32.dll",
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(
        IntPtr handle);

    [DllImport(
        "advapi32.dll",
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        IntPtr processHandle,
        uint desiredAccess,
        out IntPtr tokenHandle);

    [DllImport(
        "advapi32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LookupPrivilegeValue(
        string? systemName,
        string name,
        out Luid luid);

    [DllImport(
        "advapi32.dll",
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AdjustTokenPrivileges(
        IntPtr tokenHandle,
        [MarshalAs(UnmanagedType.Bool)]
        bool disableAllPrivileges,
        ref TokenPrivileges newState,
        int bufferLength,
        out TokenPrivileges previousState,
        out int returnLength);
}
