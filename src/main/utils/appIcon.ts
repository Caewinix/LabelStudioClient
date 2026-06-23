import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export function resolveAppIconPath(): string | undefined {
  const root = app.getAppPath();
  const candidates = process.platform === 'win32'
    ? [path.join(root, 'icons', 'logo.ico')]
    : process.platform === 'linux'
      ? [path.join(root, 'icons', 'linux', 'png', 'logo_512x512.png'), path.join(root, 'icons', 'linux', 'png', 'logo_256x256.png')]
      : [path.join(root, 'icons', 'logo.iconset', 'icon_512x512.png'), path.join(root, 'icons', 'logo.iconset', 'icon_256x256.png')];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return undefined;
}
