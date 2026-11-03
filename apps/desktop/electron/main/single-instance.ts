interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): unknown;
  quit(): void;
}

interface PrimaryWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Prevent a second process from opening the same local profile and servers. */
export function keepSingleInstance(
  app: SingleInstanceApp,
  getWindow: () => PrimaryWindow | null,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  app.on("second-instance", () => {
    const window = getWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
