import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { BrowserWindow as BrowserWindowType } from 'electron'

let previewWindow: BrowserWindowType | null = null
let mainWindowRef: BrowserWindowType | null = null
let leaveTimeout: NodeJS.Timeout | null = null
let cursorPollInterval: NodeJS.Timeout | null = null
let wasOverPreview = false
let onLeaveCallback: (() => void) | null = null
let currentMaxHeight = 400

const PREVIEW_WIDTH = 400
const MIN_HEIGHT = 60
const BOTTOM_PADDING = 16
const TOP_BAR_HEIGHT = 52
const GAP = 4
const HEADER_HEIGHT = 36
const LINE_HEIGHT = 19.2
const LOG_PADDING = 16

const PREVIEW_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      background: transparent;
      overflow: hidden;
      height: 100%;
    }
    .container {
      background: #111111;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    }
    .header {
      padding: 10px 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 11px;
      font-weight: 500;
      color: #888888;
      border-bottom: 1px solid #2a2a2a;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .logs {
      flex: 1;
      overflow-y: auto;
      padding: 8px 14px;
      font-family: SFMono-Regular, Menlo, 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.6;
      color: #d4d4d4;
    }
    .logs::-webkit-scrollbar {
      width: 6px;
    }
    .logs::-webkit-scrollbar-track {
      background: transparent;
    }
    .logs::-webkit-scrollbar-thumb {
      background: #3a3a3a;
      border-radius: 3px;
    }
    .logs::-webkit-scrollbar-thumb:hover {
      background: #4a4a4a;
    }
    .log-line {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .log-line[data-type="error"] {
      color: #ff6b6b;
    }
    .log-line[data-type="warn"] {
      color: #ffa94d;
    }
    .log-line[data-type="info"] {
      color: #74c0fc;
    }
    .log-line[data-type="result"] {
      color: #a0a0a0;
      font-style: italic;
    }
    .log-line[data-type="command"] {
      color: #6b9eff;
    }
    .input-wrapper {
      border-top: 1px solid #2a2a2a;
      padding: 10px 14px;
      flex-shrink: 0;
    }
    .input-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .prompt {
      color: #6b9eff;
      font-family: SFMono-Regular, Menlo, 'Courier New', monospace;
      font-size: 16px;
      flex-shrink: 0;
    }
    .console-input {
      flex: 1;
      background: transparent;
      border: none;
      color: #d4d4d4;
      font-family: SFMono-Regular, Menlo, 'Courier New', monospace;
      font-size: 12px;
      outline: none;
      height: 20px;
    }
    .console-input::placeholder {
      color: #555555;
    }
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #555555;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      gap: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span>Console</span>
    </div>
    <div class="logs" id="logs"></div>
    <div class="input-wrapper">
      <div class="input-row">
        <span class="prompt">›</span>
        <input class="console-input" id="input" type="text" spellcheck="false" />
      </div>
    </div>
  </div>
  <script>
    document.body.addEventListener('mouseleave', () => {
      if (window.electron && window.electron.onMouseLeave) {
        window.electron.onMouseLeave()
      }
    })
    document.body.addEventListener('mouseenter', () => {
      if (window.electron && window.electron.onMouseEnter) {
        window.electron.onMouseEnter()
      }
    })
    const input = document.getElementById('input')
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const command = input.value.trim()
        if (window.electron && window.electron.onCommand) {
          window.electron.onCommand(command)
        }
        input.value = ''
      }
    })
    function updateLogs(logs) {
      const container = document.getElementById('logs')
      if (!logs || logs.trim() === '') {
        container.innerHTML = '<div class="empty"><span>Console is empty</span></div>'
      } else {
        const lines = logs.split('\\n')
        container.innerHTML = lines.map(line => {
          let type = 'log'
          let content = line
          if (line.startsWith('[error]')) {
            type = 'error'
            content = line
          } else if (line.startsWith('[warn]')) {
            type = 'warn'
            content = line
          } else if (line.startsWith('[info]')) {
            type = 'info'
            content = line
          } else if (line.startsWith('> ')) {
            type = 'command'
            content = line
          }
          return '<div class="log-line" data-type="' + type + '">' + escapeHtml(content) + '</div>'
        }).join('')
      }
      requestAnimationFrame(() => {
        const inputWrapper = document.querySelector('.input-wrapper')
        const inputHeight = inputWrapper ? inputWrapper.offsetHeight : 0
        const contentHeight = container.scrollHeight + 36 + inputHeight
        if (window.electron && window.electron.onContentHeight) {
          window.electron.onContentHeight(contentHeight)
        }
        container.scrollTop = container.scrollHeight
      })
    }
    function escapeHtml(text) {
      const div = document.createElement('div')
      div.textContent = text
      return div.innerHTML
    }
    function focusInput() {
      input.focus()
    }
    window.updateLogs = updateLogs
    window.focusInput = focusInput
  </script>
</body>
</html>
`

export function initConsolePreview(mainWindow: BrowserWindowType): void {
  mainWindowRef = mainWindow
}

export function showConsolePreview(
  buttonX: number,
  buttonY: number,
  buttonWidth: number,
  mainHeight: number,
  logs: string,
  onLeave: () => void
): void {
  onLeaveCallback = onLeave
  currentMaxHeight = mainHeight - TOP_BAR_HEIGHT - BOTTOM_PADDING - GAP

  if (previewWindow && !previewWindow.isDestroyed()) {
    positionAndShow(buttonX, buttonY, buttonWidth, logs)
    return
  }

  previewWindow = new BrowserWindow({
    width: PREVIEW_WIDTH,
    height: MIN_HEIGHT,
    minWidth: PREVIEW_WIDTH,
    maxWidth: PREVIEW_WIDTH,
    minHeight: MIN_HEIGHT,
    maxHeight: currentMaxHeight,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: true,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    hasShadow: true,
    skipTaskbar: true,
    vibrancy: 'under-window',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, '../preload/console-preview.js')
    }
  })

  previewWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PREVIEW_HTML))

  previewWindow.webContents.on('did-finish-load', () => {
    updateContent(logs)
    positionAndShow(buttonX, buttonY, buttonWidth, logs)
  })

  previewWindow.on('closed', () => {
    previewWindow = null
  })
}

function positionAndShow(
  viewportX: number,
  viewportY: number,
  buttonWidth: number,
  logs: string
): void {
  if (!previewWindow || previewWindow.isDestroyed()) return
  // viewportX/viewportY are already screen-absolute (computed in renderer via window.screenX/Y).
  // Right-align preview to button's right edge, position just below.
  const screenX = viewportX + buttonWidth - PREVIEW_WIDTH
  const screenY = viewportY + GAP

  previewWindow.setMaximumSize(PREVIEW_WIDTH, currentMaxHeight)
  previewWindow.setPosition(Math.round(screenX), Math.round(screenY))
  // showInactive keeps focus on the main window so clicking the console
  // button to copy still works on the first click. The preview becomes
  // focusable naturally when the user clicks into its input to type.
  previewWindow.showInactive()

  updateContent(logs)
  startCursorTracking()
}

export function updateConsolePreview(logs: string): void {
  if (!previewWindow || previewWindow.isDestroyed()) return
  updateContent(logs)
}

function updateContent(logs: string): void {
  if (!previewWindow || previewWindow.isDestroyed()) return
  const serialized = JSON.stringify(logs)
  previewWindow.webContents.executeJavaScript(`window.updateLogs && window.updateLogs(${serialized})`)
}

function startCursorTracking(): void {
  stopCursorTracking()
  wasOverPreview = false
  cursorPollInterval = setInterval(() => {
    if (!previewWindow || previewWindow.isDestroyed() || !previewWindow.isVisible()) {
      stopCursorTracking()
      return
    }
    const cursor = screen.getCursorScreenPoint()
    const b = previewWindow.getBounds()
    const isOver =
      cursor.x >= b.x && cursor.x <= b.x + b.width &&
      cursor.y >= b.y && cursor.y <= b.y + b.height

    if (isOver) {
      // Cursor is inside — cancel any pending close
      cancelClose()
      wasOverPreview = true
    } else if (wasOverPreview) {
      // Cursor just left the preview — schedule close
      wasOverPreview = false
      scheduleClose()
    }
  }, 50)
}

function stopCursorTracking(): void {
  if (cursorPollInterval) {
    clearInterval(cursorPollInterval)
    cursorPollInterval = null
  }
}

export function hideConsolePreview(): void {
  stopCursorTracking()
  if (leaveTimeout) {
    clearTimeout(leaveTimeout)
    leaveTimeout = null
  }
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.hide()
  }
}

export function destroyConsolePreview(): void {
  stopCursorTracking()
  if (leaveTimeout) {
    clearTimeout(leaveTimeout)
    leaveTimeout = null
  }
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.close()
    previewWindow = null
  }
  onLeaveCallback = null
}

export function isConsolePreviewVisible(): boolean {
  return previewWindow !== null && !previewWindow.isDestroyed() && previewWindow.isVisible()
}

function scheduleClose(): void {
  if (leaveTimeout) clearTimeout(leaveTimeout)
  leaveTimeout = setTimeout(() => {
    leaveTimeout = null
    if (onLeaveCallback) onLeaveCallback()
    hideConsolePreview()
  }, 300)
}

function cancelClose(): void {
  if (leaveTimeout) {
    clearTimeout(leaveTimeout)
    leaveTimeout = null
  }
}

export function scheduleCloseFromButton(): void {
  scheduleClose()
}

export function cancelCloseFromButton(): void {
  cancelClose()
}

export function handlePreviewMouseLeave(): void {
  scheduleClose()
}

export function handlePreviewMouseEnter(): void {
  cancelClose()
}

export function handlePreviewContentHeight(height: number): void {
  if (!previewWindow || previewWindow.isDestroyed()) return
  const clampedHeight = Math.max(MIN_HEIGHT, Math.min(height, currentMaxHeight))
  previewWindow.setSize(PREVIEW_WIDTH, Math.round(clampedHeight))
}

export function repositionConsolePreview(
  viewportX: number,
  viewportY: number,
  buttonWidth: number,
  mainHeight: number
): void {
  if (!previewWindow || previewWindow.isDestroyed()) return
  currentMaxHeight = mainHeight - TOP_BAR_HEIGHT - BOTTOM_PADDING - GAP

  // viewportX/viewportY are already screen-absolute (computed in renderer via window.screenX/Y).
  const screenX = viewportX + buttonWidth - PREVIEW_WIDTH
  const screenY = viewportY + GAP

  previewWindow.setMaximumSize(PREVIEW_WIDTH, currentMaxHeight)
  previewWindow.setPosition(Math.round(screenX), Math.round(screenY))
  
  const [, currentHeight] = previewWindow.getSize()
  const clampedHeight = Math.max(MIN_HEIGHT, Math.min(currentHeight, currentMaxHeight))
  previewWindow.setSize(PREVIEW_WIDTH, clampedHeight)
}

export function getConsolePreviewWindow(): BrowserWindowType | null {
  return previewWindow && !previewWindow.isDestroyed() ? previewWindow : null
}
