// bugfix-main.js
// Thin bootstrap around the upstream main.js.
//
// Goal of this version:
// - KEEP normal mouse visibility and normal Cue click handling.
// - DO NOT make the Cue window permanently mouse-pass-through.
// - Remove mouse-driven visual feedback that can escape the protected window:
//   native HTML tooltips, hover/active/focus styling, pointer/grab/text cursors,
//   native Electron/Windows drag feedback, resize cursor/system menu.
// - Replace native -webkit-app-region dragging with manual BrowserWindow.setPosition().
//
// Existing Ctrl/Cmd+Shift+I forced passthrough is preserved and remains OFF by
// default. If you never use that shortcut, Cue behaves as an interactive window.

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen
} = require('electron');

let forcedPassthrough = false;
let manualDragState = null;

const PASSTHROUGH_ACCELERATOR =
  'CommandOrControl+Shift+I';

const DRAG_START =
  '__cue_manual_drag_start__';

const DRAG_MOVE =
  '__cue_manual_drag_move__';

const DRAG_END =
  '__cue_manual_drag_end__';

function isCueOverlayWindow(win) {
  if (!win || win.isDestroyed()) {
    return false;
  }

  try {
    const url =
      win.webContents &&
      win.webContents.getURL();

    return (
      typeof url === 'string' &&
      /\/renderer\/index\.html(?:$|[?#])/.test(
        url
      )
    );
  } catch {
    return false;
  }
}

function getCueOverlayWindows() {
  return BrowserWindow
    .getAllWindows()
    .filter(isCueOverlayWindow);
}

function setWindowPassthrough(
  win,
  ignore
) {
  if (!win || win.isDestroyed()) {
    return;
  }

  // IMPORTANT:
  // This is only used by the project's existing hover-based passthrough and
  // the explicit Ctrl/Cmd+Shift+I shortcut. We do NOT force it on by default.
  win.setIgnoreMouseEvents(
    !!ignore,
    { forward: true }
  );
}

function sendStatus(message) {
  for (
    const win
    of getCueOverlayWindows()
  ) {
    try {
      win.webContents.send(
        'status',
        { message }
      );
    } catch (_) {}
  }
}

function applyForcedPassthrough() {
  for (
    const win
    of getCueOverlayWindows()
  ) {
    setWindowPassthrough(
      win,
      forcedPassthrough
    );
  }
}

function toggleForcedPassthrough() {
  forcedPassthrough =
    !forcedPassthrough;

  applyForcedPassthrough();

  sendStatus(
    forcedPassthrough
      ? '鼠标穿透已开启。再次按 Ctrl/Cmd+Shift+I 恢复 Cue 鼠标交互。'
      : '鼠标穿透已关闭。Cue 已恢复正常鼠标交互。'
  );

  return forcedPassthrough;
}

function startManualDrag(
  event,
  senderWindow
) {
  if (
    !senderWindow ||
    senderWindow.isDestroyed() ||
    !isCueOverlayWindow(
      senderWindow
    )
  ) {
    return;
  }

  // Ensure Cue keeps receiving pointer events during manual dragging.
  setWindowPassthrough(
    senderWindow,
    false
  );

  const [
    windowX,
    windowY
  ] = senderWindow.getPosition();

  const cursor =
    screen.getCursorScreenPoint();

  manualDragState = {
    webContentsId:
      event.sender.id,
    target:
      senderWindow,
    offsetX:
      cursor.x - windowX,
    offsetY:
      cursor.y - windowY
  };
}

function moveManualDrag(event) {
  const state =
    manualDragState;

  if (
    !state ||
    state.webContentsId !==
      event.sender.id ||
    !state.target ||
    state.target.isDestroyed()
  ) {
    return;
  }

  const cursor =
    screen.getCursorScreenPoint();

  state.target.setPosition(
    Math.round(
      cursor.x -
      state.offsetX
    ),
    Math.round(
      cursor.y -
      state.offsetY
    )
  );
}

function endManualDrag(event) {
  if (
    manualDragState &&
    manualDragState.webContentsId ===
      event.sender.id
  ) {
    manualDragState = null;
  }
}

// Renderer-side hardening is injected instead of replacing renderer.js/styles.css.
// It intentionally does NOT use pointer-events:none.
const POINTER_NEUTRAL_SCRIPT = String.raw`
(() => {
  if (window.__cuePointerNeutralInstalled) {
    return;
  }

  window.__cuePointerNeutralInstalled = true;

  // ------------------------------------------------------------
  // 1) Remove every native HTML title tooltip.
  // ------------------------------------------------------------
  function removeNativeTitles(root) {
    const scope =
      root && root.querySelectorAll
        ? root
        : document;

    scope
      .querySelectorAll('[title]')
      .forEach((element) => {
        element.removeAttribute(
          'title'
        );
      });

    if (
      root &&
      root.nodeType === 1 &&
      root.hasAttribute &&
      root.hasAttribute('title')
    ) {
      root.removeAttribute(
        'title'
      );
    }
  }

  removeNativeTitles(document);

  // renderer.js currently writes title dynamically for the live dot,
  // Smart button, prep status and other controls. Remove those immediately.
  const titleObserver =
    new MutationObserver(
      (records) => {
        for (
          const record
          of records
        ) {
          if (
            record.type ===
              'attributes' &&
            record.attributeName ===
              'title'
          ) {
            const element =
              record.target;

            if (
              element &&
              element.removeAttribute
            ) {
              element.removeAttribute(
                'title'
              );
            }
          }

          for (
            const node
            of record.addedNodes ||
              []
          ) {
            if (
              node &&
              node.nodeType === 1
            ) {
              removeNativeTitles(
                node
              );
            }
          }
        }
      }
    );

  titleObserver.observe(
    document.documentElement,
    {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'title'
      ]
    }
  );

  // ------------------------------------------------------------
  // 2) Delete :hover / :active / :focus rules from loaded CSS.
  //
  // This preserves all normal state classes (.active, .on, .ready, etc.)
  // while removing ONLY pointer/focus-driven visual changes.
  // ------------------------------------------------------------
  function stripPointerPseudoRules(
    container
  ) {
    let rules;

    try {
      rules =
        container.cssRules;
    } catch (_) {
      return;
    }

    if (!rules) {
      return;
    }

    for (
      let i =
        rules.length - 1;
      i >= 0;
      i--
    ) {
      const rule =
        rules[i];

      const selector =
        rule &&
        rule.selectorText;

      if (
        selector &&
        /:(hover|active|focus|focus-visible|focus-within)\b/i.test(
          selector
        )
      ) {
        try {
          container.deleteRule(i);
        } catch (_) {}

        continue;
      }

      if (
        rule &&
        rule.cssRules &&
        typeof rule.deleteRule ===
          'function'
      ) {
        stripPointerPseudoRules(
          rule
        );
      }
    }
  }

  function stripAllPointerPseudoRules() {
    for (
      const sheet
      of document.styleSheets
    ) {
      try {
        stripPointerPseudoRules(
          sheet
        );
      } catch (_) {}
    }
  }

  stripAllPointerPseudoRules();

  // ------------------------------------------------------------
  // 3) Override native drag regions + cursor changes.
  //
  // The mouse remains fully visible to Windows/screen sharing.
  // Cue remains clickable. Only cursor SHAPE feedback is neutralized.
  // ------------------------------------------------------------
  const neutralStyle =
    document.createElement(
      'style'
    );

  neutralStyle.id =
    'cue-pointer-neutral-style';

  neutralStyle.textContent = [
    '#toolbar,',
    '.drag-handle,',
    '.drag-pill {',
    '  -webkit-app-region: no-drag !important;',
    '}',
    '',
    'html, body,',
    '#app, #app * {',
    '  cursor: default !important;',
    '}',
    '',
    'button, input, textarea, select,',
    '.drag-pill, .act, .smart-pill,',
    '.history-btn, .more-btn, #send-btn {',
    '  transition: none !important;',
    '}'
  ].join('\n');

  document.head.appendChild(
    neutralStyle
  );

  // If a stylesheet is added later, strip its pointer pseudo rules too.
  const cssObserver =
    new MutationObserver(() => {
      stripAllPointerPseudoRules();
    });

  cssObserver.observe(
    document.head,
    {
      childList: true
    }
  );

  // ------------------------------------------------------------
  // 4) Manual window drag.
  //
  // No -webkit-app-region:drag -> no Windows native move outline.
  // Uses the already-exposed cue.setIgnoreMouse IPC channel with private
  // sentinel values, so preload.js does not need to change.
  // ------------------------------------------------------------
  const handle =
    document.querySelector(
      '.drag-pill'
    );

  if (handle) {
    let dragging = false;
    let pointerId = null;
    let moveQueued = false;

    handle.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0) {
          return;
        }

        dragging = true;
        pointerId =
          event.pointerId;

        event.preventDefault();

        try {
          handle.setPointerCapture(
            pointerId
          );
        } catch (_) {}

        if (
          window.cue &&
          window.cue.setIgnoreMouse
        ) {
          window.cue.setIgnoreMouse(
            '${DRAG_START}'
          );
        }
      },
      true
    );

    handle.addEventListener(
      'pointermove',
      (event) => {
        if (
          !dragging ||
          event.pointerId !==
            pointerId ||
          moveQueued
        ) {
          return;
        }

        moveQueued = true;

        requestAnimationFrame(
          () => {
            moveQueued = false;

            if (
              dragging &&
              window.cue &&
              window.cue.setIgnoreMouse
            ) {
              window.cue.setIgnoreMouse(
                '${DRAG_MOVE}'
              );
            }
          }
        );
      },
      true
    );

    function stopDrag(event) {
      if (!dragging) {
        return;
      }

      if (
        event &&
        event.pointerId !==
          undefined &&
        pointerId !== null &&
        event.pointerId !==
          pointerId
      ) {
        return;
      }

      dragging = false;

      try {
        if (
          pointerId !== null &&
          handle.hasPointerCapture(
            pointerId
          )
        ) {
          handle.releasePointerCapture(
            pointerId
          );
        }
      } catch (_) {}

      pointerId = null;

      if (
        window.cue &&
        window.cue.setIgnoreMouse
      ) {
        window.cue.setIgnoreMouse(
          '${DRAG_END}'
        );
      }
    }

    handle.addEventListener(
      'pointerup',
      stopDrag,
      true
    );

    handle.addEventListener(
      'pointercancel',
      stopDrag,
      true
    );

    window.addEventListener(
      'blur',
      () => stopDrag(),
      true
    );
  }

  // Do not allow browser-native drag images/ghosts.
  document.addEventListener(
    'dragstart',
    (event) => {
      event.preventDefault();
    },
    true
  );

  // Do not allow a browser context menu to appear over the protected UI.
  document.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault();
    },
    true
  );
})();
`;

function installPointerNeutralMode(
  win
) {
  if (
    !win ||
    win.isDestroyed() ||
    !isCueOverlayWindow(win)
  ) {
    return;
  }

  // Keep Windows normal mouse handling. Do NOT call setIgnoreMouseEvents(true).
  // Only prevent native resize feedback on the overlay edges.
  try {
    win.setResizable(false);
  } catch (_) {}

  // Retain the project's content-protection request.
  try {
    if (
      !process.env.CUE_NO_PROTECT
    ) {
      win.setContentProtection(
        true
      );
    }
  } catch (_) {}

  // Native system context menu is outside the protected renderer surface.
  if (
    !win.__cueSystemMenuBlocked
  ) {
    win.__cueSystemMenuBlocked =
      true;

    win.on(
      'system-context-menu',
      (event) => {
        event.preventDefault();
      }
    );

    // Native Electron drag should no longer be reachable after CSS override.
    // This is a final guard. Programmatic setPosition() does not use the
    // native user-move path.
    win.on(
      'will-move',
      (event) => {
        if (!manualDragState) {
          event.preventDefault();
        }
      }
    );
  }

  win.webContents
    .executeJavaScript(
      POINTER_NEUTRAL_SCRIPT
    )
    .catch((error) => {
      console.warn(
        '[cue] pointer-neutral injection failed:',
        error &&
        error.message
          ? error.message
          : error
      );
    });
}

// Attach before main.js registers/creates its BrowserWindow.
app.on(
  'browser-window-created',
  (_event, win) => {
    const install = () => {
      if (
        isCueOverlayWindow(win)
      ) {
        installPointerNeutralMode(
          win
        );
      }
    };

    win.webContents.on(
      'dom-ready',
      install
    );

    win.webContents.on(
      'did-finish-load',
      install
    );
  }
);

// Load original application. Its AI/audio/capture/settings behavior remains.
require('../main.js');

// Replace ONLY the upstream mouse-ignore listener so the same IPC channel can
// carry our private manual-drag messages.
//
// Boolean values keep the original project's hover-based click-through logic.
// We never force passthrough unless the user explicitly toggles it.
ipcMain.removeAllListeners(
  'mouse:ignore'
);

ipcMain.on(
  'mouse:ignore',
  (event, value) => {
    const senderWindow =
      BrowserWindow.fromWebContents(
        event.sender
      );

    if (
      !senderWindow ||
      senderWindow.isDestroyed()
    ) {
      return;
    }

    if (
      value === DRAG_START
    ) {
      startManualDrag(
        event,
        senderWindow
      );

      return;
    }

    if (
      value === DRAG_MOVE
    ) {
      moveManualDrag(event);
      return;
    }

    if (
      value === DRAG_END
    ) {
      endManualDrag(event);
      return;
    }

    // While manually dragging, ignore renderer auto-passthrough messages so
    // pointer capture cannot be lost mid-drag.
    if (
      manualDragState &&
      manualDragState.webContentsId ===
        event.sender.id
    ) {
      return;
    }

    // Original behavior:
    // - forced passthrough OFF: renderer decides whether empty gaps pass through.
    // - forced passthrough ON: all clicks pass through until shortcut toggled off.
    setWindowPassthrough(
      senderWindow,
      forcedPassthrough
        ? true
        : !!value
    );
  }
);

// If the overlay is recreated while forced passthrough is enabled, keep that
// explicit user-selected state. Otherwise we leave normal mouse interaction on.
app.on(
  'browser-window-created',
  (_event, win) => {
    win.webContents.on(
      'did-finish-load',
      () => {
        if (
          forcedPassthrough &&
          isCueOverlayWindow(win)
        ) {
          setWindowPassthrough(
            win,
            true
          );
        }
      }
    );
  }
);

app.whenReady().then(() => {
  // In case a window was created before our event completed, harden it now.
  for (
    const overlay
    of getCueOverlayWindows()
  ) {
    installPointerNeutralMode(
      overlay
    );
  }

  const ok =
    globalShortcut.register(
      PASSTHROUGH_ACCELERATOR,
      toggleForcedPassthrough
    );

  if (!ok) {
    console.warn(
      '[cue] Could not register ' +
      PASSTHROUGH_ACCELERATOR +
      '; another app may already own it.'
    );
  }
});

module.exports = {
  PASSTHROUGH_ACCELERATOR,
  isCueOverlayWindow,
  toggleForcedPassthrough,
  installPointerNeutralMode
};
