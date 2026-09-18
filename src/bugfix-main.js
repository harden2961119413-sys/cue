// bugfix-main.js
// Thin bootstrap around the upstream main.js.
//
// Fixes:
// 1) Adds a reliable global passthrough toggle (Ctrl/Cmd+Shift+I) so the native
//    Electron window can be made fully click-through when it covers content the
//    user needs to click underneath.
// 2) Keeps the existing hover-based auto click-through behavior when forced
//    passthrough is OFF.
//
// Keeping this as a wrapper avoids copying/maintaining the large upstream
// main.js and makes it safe to combine with prompt changes in that file later.

const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');

let forcedPassthrough = false;
const PASSTHROUGH_ACCELERATOR = 'CommandOrControl+Shift+I';

function isCueOverlayWindow(win) {
  if (!win || win.isDestroyed()) return false;
  try {
    const url = win.webContents && win.webContents.getURL();
    return typeof url === 'string' && /\/renderer\/index\.html(?:$|[?#])/.test(url);
  } catch {
    return false;
  }
}

function getCueOverlayWindows() {
  return BrowserWindow.getAllWindows().filter(isCueOverlayWindow);
}

function setWindowPassthrough(win, ignore) {
  if (!win || win.isDestroyed()) return;
  // forward:true is supported on Windows/macOS and lets Chromium continue to
  // receive movement events while clicks pass through. On platforms that ignore
  // "forward", setIgnoreMouseEvents(true) still provides native click-through.
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
}

function sendStatus(message) {
  for (const win of getCueOverlayWindows()) {
    try { win.webContents.send('status', { message }); } catch (_) {}
  }
}

function applyForcedPassthrough() {
  for (const win of getCueOverlayWindows()) setWindowPassthrough(win, forcedPassthrough);
}

function toggleForcedPassthrough() {
  forcedPassthrough = !forcedPassthrough;
  applyForcedPassthrough();
  sendStatus(
    forcedPassthrough
      ? '鼠标穿透已开启（Ctrl/Cmd+Shift+I）：点击会落到 cue 后面的窗口。再次按快捷键恢复操作 cue。'
      : '鼠标穿透已关闭：已恢复 cue 的自动悬停点击逻辑。'
  );
  return forcedPassthrough;
}

// Load the original application. It registers its normal IPC handlers,
// BrowserWindow lifecycle, audio capture and interview functionality.
require('../main.js');

// Replace only the mouse-ignore IPC listener from upstream.
// The renderer can continue its automatic hover-based click-through, but while
// forced passthrough is enabled it is not allowed to accidentally turn native
// mouse capture back on.
ipcMain.removeAllListeners('mouse:ignore');
ipcMain.on('mouse:ignore', (event, value) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow.isDestroyed()) return;
  setWindowPassthrough(senderWindow, forcedPassthrough ? true : !!value);
});

// If the overlay is recreated while forced passthrough is enabled, apply the
// same native state after renderer/index.html has loaded.
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => {
    if (forcedPassthrough && isCueOverlayWindow(win)) setWindowPassthrough(win, true);
  });
});

app.whenReady().then(() => {
  const ok = globalShortcut.register(PASSTHROUGH_ACCELERATOR, toggleForcedPassthrough);
  if (!ok) {
    console.warn(
      `[cue] Could not register ${PASSTHROUGH_ACCELERATOR}; another app may already own it.`
    );
  }
});

module.exports = {
  PASSTHROUGH_ACCELERATOR,
  isCueOverlayWindow,
  toggleForcedPassthrough
};
