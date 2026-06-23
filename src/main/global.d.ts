export {};

declare global {
  // Minimal persistent preference store used by the main process and update controller.
  // Electron reloads compiled CommonJS files, so this intentionally lives on globalThis.
  var sharedStore: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  } | null | undefined;
}
