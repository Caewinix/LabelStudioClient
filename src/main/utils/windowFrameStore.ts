import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, screen } from 'electron';

type WindowFrameId = 'main' | 'updates';

interface InitialWindowFrameOptions {
  id: WindowFrameId;
  display: Electron.Display;
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
}

const Magic = Buffer.from('LSWF');
const Version = 1;
const RecordByteLength = 24;
const SaveDelayMs = 150;

function stateDirectory(): string {
  const directory = path.join(app.getPath('userData'), 'window-state');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function stateFilePath(id: WindowFrameId): string {
  return path.join(stateDirectory(), `${id}.bin`);
}

function centerFrame(display: Electron.Display, width: number, height: number, minWidth: number, minHeight: number): Electron.Rectangle {
  const area = display.workArea;
  const frameWidth = Math.round(Math.min(Math.max(width, minWidth), area.width));
  const frameHeight = Math.round(Math.min(Math.max(height, minHeight), area.height));
  return {
    x: Math.round(area.x + (area.width - frameWidth) / 2),
    y: Math.round(area.y + (area.height - frameHeight) / 2),
    width: frameWidth,
    height: frameHeight
  };
}

function frameIntersectsVisibleDisplay(frame: Electron.Rectangle): boolean {
  return screen.getAllDisplays().some(display => {
    const area = display.workArea;
    const x1 = Math.max(frame.x, area.x);
    const y1 = Math.max(frame.y, area.y);
    const x2 = Math.min(frame.x + frame.width, area.x + area.width);
    const y2 = Math.min(frame.y + frame.height, area.y + area.height);
    return x2 > x1 && y2 > y1;
  });
}

function readStoredFrame(id: WindowFrameId, minWidth: number, minHeight: number): Electron.Rectangle | undefined {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(stateFilePath(id));
  } catch {
    return undefined;
  }

  if (buffer.length !== RecordByteLength || !buffer.subarray(0, 4).equals(Magic)) return undefined;
  if (buffer.readUInt32LE(4) !== Version) return undefined;

  const frame: Electron.Rectangle = {
    x: buffer.readInt32LE(8),
    y: buffer.readInt32LE(12),
    width: buffer.readUInt32LE(16),
    height: buffer.readUInt32LE(20)
  };

  if (frame.width < minWidth || frame.height < minHeight) return undefined;
  if (frame.width > 100_000 || frame.height > 100_000) return undefined;
  return frameIntersectsVisibleDisplay(frame) ? frame : undefined;
}

export function initialWindowFrame(options: InitialWindowFrameOptions): Electron.Rectangle {
  return readStoredFrame(options.id, options.minWidth, options.minHeight)
    ?? centerFrame(options.display, options.defaultWidth, options.defaultHeight, options.minWidth, options.minHeight);
}

export function saveWindowFrame(id: WindowFrameId, win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;

  const frame = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  const buffer = Buffer.alloc(RecordByteLength);
  Magic.copy(buffer, 0);
  buffer.writeUInt32LE(Version, 4);
  buffer.writeInt32LE(Math.round(frame.x), 8);
  buffer.writeInt32LE(Math.round(frame.y), 12);
  buffer.writeUInt32LE(Math.max(1, Math.round(frame.width)), 16);
  buffer.writeUInt32LE(Math.max(1, Math.round(frame.height)), 20);
  fs.writeFileSync(stateFilePath(id), buffer);
}

export function rememberWindowFrame(win: BrowserWindow, id: WindowFrameId): void {
  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      saveWindowFrame(id, win);
    }, SaveDelayMs);
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveWindowFrame(id, win);
  });
}
