using System.Text;

namespace LabelStudio.Installer;

internal static class Diagnostics
{
    public static void Append(string? path, string message)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            string? directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            File.AppendAllText(path, $"{DateTime.UtcNow:O} {message}{Environment.NewLine}", Encoding.UTF8);
        }
        catch
        {
            // Diagnostics are optional and never control installer behavior.
        }
    }
}
