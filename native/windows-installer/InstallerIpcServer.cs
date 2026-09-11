using System.IO.Pipes;
using System.Text;

namespace LabelStudio.Installer;

internal sealed class InstallerIpcServer : IAsyncDisposable
{
    private readonly string pipeName;
    private readonly string diagnosticLogPath;
    private readonly CancellationTokenSource cancellation = new();
    private readonly TaskCompletionSource ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object serverLock = new();
    private NamedPipeServerStream? currentServer;
    private Task? loopTask;

    public InstallerIpcServer(string pipeName, string diagnosticLogPath)
    {
        this.pipeName = pipeName;
        this.diagnosticLogPath = diagnosticLogPath;
    }

    public async Task Start()
    {
        loopTask = Run();
        await ready.Task;
    }

    private async Task Run()
    {
        bool firstServer = true;
        while (!cancellation.IsCancellationRequested)
        {
            NamedPipeServerStream? server = null;
            try
            {
                server = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    4,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);
                lock (serverLock) currentServer = server;
                if (firstServer)
                {
                    firstServer = false;
                    ready.TrySetResult();
                }

                await server.WaitForConnectionAsync(cancellation.Token);
                using var reader = new StreamReader(server, Encoding.UTF8, false, 1024, leaveOpen: true);
                using var writer = new StreamWriter(server, new UTF8Encoding(false), 1024, leaveOpen: true)
                {
                    AutoFlush = true,
                };
                string? command = await reader.ReadLineAsync(cancellation.Token);
                string response = string.Equals(command, "STATUS", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(command, "ACTIVATE", StringComparison.OrdinalIgnoreCase)
                    ? "ACTIVE"
                    : "UNKNOWN";
                await writer.WriteLineAsync(response);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
                break;
            }
            catch (ObjectDisposedException) when (cancellation.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                if (firstServer)
                {
                    firstServer = false;
                    ready.TrySetException(new InvalidOperationException("Could not create the installer IPC endpoint.", error));
                    return;
                }
                Diagnostics.Append(diagnosticLogPath, $"[installer-ipc] Client handling failed: {error}");
            }
            finally
            {
                lock (serverLock)
                {
                    if (ReferenceEquals(currentServer, server)) currentServer = null;
                }
                server?.Dispose();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        cancellation.Cancel();
        lock (serverLock) currentServer?.Dispose();
        if (loopTask is not null)
        {
            try
            {
                await loopTask;
            }
            catch (OperationCanceledException)
            {
                // Cancellation is the normal shutdown path.
            }
        }
        cancellation.Dispose();
    }
}
