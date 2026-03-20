import { app, BrowserWindow, BrowserView, ipcMain, session, Menu, dialog, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { geminiGenerate } from './gemini'
import {
  initConsolePreview,
  showConsolePreview,
  hideConsolePreview,
  updateConsolePreview,
  isConsolePreviewVisible,
  handlePreviewMouseLeave,
  handlePreviewMouseEnter,
  handlePreviewContentHeight,
  repositionConsolePreview,
  destroyConsolePreview,
  scheduleCloseFromButton,
  cancelCloseFromButton
} from './consolePreview'

let mainWindow: BrowserWindow | null = null
let targetView: BrowserView | null = null
let unpinnedTabCount = 0
let consoleLogs: string[] = []
let consoleButtonBounds: { viewportX: number; viewportY: number; width: number } | null = null
const MAX_CONSOLE_LOGS = 500

// Simple JSON file store (replaces electron-store to avoid ESM issues)
function getSettingsPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'attribute-settings.json')
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(getSettingsPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function writeSetting(key: string, value: unknown): void {
  const settings = readSettings()
  settings[key] = value
  writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 })
}

function deleteSetting(key: string): void {
  const settings = readSettings()
  delete settings[key]
  writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 })
}

// Read the compiled overlay script
const overlayScript = readFileSync(join(__dirname, 'overlay.js'), 'utf-8')

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 320,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 17 },
    acceptFirstMouse: true,
    backgroundColor: '#0e0e0e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  // Load the side panel renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Create BrowserView for the target web page
  targetView = new BrowserView({
    webPreferences: {
      sandbox: false,
      webSecurity: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.setBrowserView(targetView)
  targetView.webContents.setWindowOpenHandler(({ url, features }) => {
    const width = parseInt(features.match(/width=(\d+)/)?.[1] || '500')
    const height = parseInt(features.match(/height=(\d+)/)?.[1] || '600')
    
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width,
        height,
        parent: mainWindow ?? undefined,
        modal: false,
        show: true,
        backgroundColor: '#ffffff',
        title: 'Sign in',
        webPreferences: {
          sandbox: true,
          webSecurity: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      }
    }
  })
  layoutViews()

  // Attach CDP debugger to the target view
  try {
    targetView.webContents.debugger.attach('1.3')
  } catch (err) {
    console.error('Failed to attach debugger:', err)
  }

  targetView.webContents.debugger.on('detach', (_event, reason) => {
    console.log('Debugger detached:', reason)
  })

  // Enable Runtime domain and listen for binding calls
  targetView.webContents.debugger.sendCommand('Runtime.enable')

  targetView.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.bindingCalled' && params.name === '__attributeSelect__') {
      try {
        const elementData = JSON.parse(params.payload)
        mainWindow?.webContents.send('element-selected', elementData)
      } catch (err) {
        console.error('Failed to parse element data:', err)
      }
    }
    if (method === 'Runtime.consoleAPICalled') {
      const type = params.type || 'log'
      const args = (params.args || [])
        .map((a: { type: string; value?: unknown; description?: string }) =>
          a.type === 'string' ? a.value : a.description ?? JSON.stringify(a.value ?? '')
        )
        .join(' ')
      const line = `[${type}] ${args}`
      consoleLogs.push(line)
      if (consoleLogs.length > MAX_CONSOLE_LOGS) {
        consoleLogs = consoleLogs.slice(-MAX_CONSOLE_LOGS)
      }
      // Update preview if visible
      updateConsolePreview(consoleLogs.join('\n'))
    }
    if (method === 'Runtime.exceptionThrown') {
      const desc = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Unknown error'
      consoleLogs.push(`[error] ${desc}`)
      if (consoleLogs.length > MAX_CONSOLE_LOGS) {
        consoleLogs = consoleLogs.slice(-MAX_CONSOLE_LOGS)
      }
      // Update preview if visible
      updateConsolePreview(consoleLogs.join('\n'))
    }
  })

  // Block navigation to non-http(s) schemes initiated by the target page
  targetView.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const parsed = new URL(navUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        event.preventDefault()
      }
    } catch {
      event.preventDefault()
    }
  })


  // Load a default page
  targetView.webContents.loadURL('http://localhost:3000')

  // Send URL updates back to the renderer
  targetView.webContents.on('did-navigate', (_event, url) => {
    mainWindow?.webContents.send('url-changed', url)
  })

  targetView.webContents.on('did-navigate-in-page', (_event, url) => {
    mainWindow?.webContents.send('url-changed', url)
  })

  // Clear console logs and inject overlay after full navigations
  targetView.webContents.on('did-finish-load', () => {
    consoleLogs = []
    injectOverlay()
    mainWindow?.webContents.send('page-title-changed', targetView.webContents.getTitle())
  })

  targetView.webContents.on('page-title-updated', (_event, title) => {
    mainWindow?.webContents.send('page-title-changed', title)
  })

  // Inject overlay after SPA navigations (guard in script prevents double-inject)
  targetView.webContents.on('did-navigate-in-page', () => {
    injectOverlay()
  })

  mainWindow.on('resize', () => {
    layoutViews()
    // Update console preview max height on resize
    if (isConsolePreviewVisible() && consoleButtonBounds && mainWindow) {
      repositionConsolePreview(
        consoleButtonBounds.viewportX,
        consoleButtonBounds.viewportY,
        consoleButtonBounds.width,
        mainWindow.getContentSize()[1]
      )
    }
  })

  // Initialize console preview module
  initConsolePreview(mainWindow)

  mainWindow.on('close', (event) => {
    if (unpinnedTabCount > 0) {
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Unpinned tabs',
        message: `You have ${unpinnedTabCount} unpinned tab${unpinnedTabCount > 1 ? 's' : ''} that will be lost.`,
        detail: 'Pin tabs you want to keep as bookmarks before quitting.'
      })
      if (choice === 1) {
        event.preventDefault()
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    targetView = null
    destroyConsolePreview()
  })
}

async function injectOverlay(): Promise<void> {
  if (!targetView) return

  try {
    // Add the binding first (idempotent — CDP ignores if already added)
    await targetView.webContents.debugger.sendCommand('Runtime.addBinding', {
      name: '__attributeSelect__'
    })
  } catch {
    // Binding may already exist, that's fine
  }

  try {
    await targetView.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: overlayScript
    })
    // If panel is open, enable inspect mode on the freshly injected overlay
    if (panelVisible) {
      await targetView.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: `window.__attributeEnableInspect__ && window.__attributeEnableInspect__()`
      })
    }
  } catch (err) {
    console.error('Failed to inject overlay:', err)
  }
}

const PANEL_WIDTH = 350
const TOP_BAR_HEIGHT = 52
let panelVisible = false

function getViewportSize(): { width: number; height: number } {
  if (!mainWindow) return { width: 0, height: 0 }
  const [width, height] = mainWindow.getContentSize()
  return {
    width: panelVisible ? width - PANEL_WIDTH : width,
    height: height - TOP_BAR_HEIGHT
  }
}

function layoutViews(): void {
  if (!mainWindow || !targetView) return

  const vp = getViewportSize()
  targetView.setBounds({
    x: 0,
    y: TOP_BAR_HEIGHT,
    width: vp.width,
    height: vp.height
  })

  mainWindow.webContents.send('viewport-size-changed', vp)
}

// IPC: Navigate the target page
ipcMain.handle('navigate', async (_event, url: string) => {
  if (!targetView) return

  let normalizedUrl = url.trim()
  if (/^https?:\/\//i.test(normalizedUrl)) {
    // Already has protocol
  } else if (/^(localhost|127\.0\.0\.1)(:\d+)?/i.test(normalizedUrl)) {
    normalizedUrl = 'http://' + normalizedUrl
  } else if (/^[\w-]+(\.[\w-]+)+/.test(normalizedUrl)) {
    // Looks like a domain (has a dot) — add https
    normalizedUrl = 'https://' + normalizedUrl
  } else {
    // Not a URL — treat as a Google search
    normalizedUrl = 'https://www.google.com/search?q=' + encodeURIComponent(normalizedUrl)
  }

  // Only allow http/https schemes
  try {
    const parsed = new URL(normalizedUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: `Blocked scheme: ${parsed.protocol}` }
    }
  } catch {
    return { success: false, error: 'Invalid URL' }
  }

  try {
    await targetView.webContents.loadURL(normalizedUrl)
    return { success: true, url: normalizedUrl }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// IPC: Execute a CDP command on the target page (whitelisted methods only)
const ALLOWED_CDP_METHODS = new Set(['Runtime.evaluate'])

ipcMain.handle('cdp-command', async (_event, method: string, params?: Record<string, unknown>) => {
  if (!targetView) return { error: 'No target view' }
  if (!ALLOWED_CDP_METHODS.has(method)) return { error: `CDP method not allowed: ${method}` }

  // Allowlist Runtime.evaluate params to prevent abuse of dangerous options
  const ALLOWED_EVALUATE_PARAMS = new Set(['expression', 'returnByValue', 'awaitPromise'])
  const sanitizedParams: Record<string, unknown> = {}
  if (params) {
    for (const key of Object.keys(params)) {
      if (ALLOWED_EVALUATE_PARAMS.has(key)) {
        sanitizedParams[key] = params[key]
      }
    }
  }

  try {
    const result = await targetView.webContents.debugger.sendCommand(method, sanitizedParams)
    return { success: true, result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// IPC: Go back
ipcMain.handle('go-back', () => {
  if (targetView?.webContents.navigationHistory.canGoBack()) {
    targetView.webContents.navigationHistory.goBack()
  }
})

// IPC: Go forward
ipcMain.handle('go-forward', () => {
  if (targetView?.webContents.navigationHistory.canGoForward()) {
    targetView.webContents.navigationHistory.goForward()
  }
})

// IPC: Reload
ipcMain.handle('reload', () => {
  targetView?.webContents.reload()
})

// IPC: Show size presets as native popup menu
ipcMain.handle('show-size-presets', () => {
  if (!mainWindow) return
  const presets = [
    { label: 'Mobile S', w: 320, h: 568 },
    { label: 'Mobile M', w: 375, h: 667 },
    { label: 'Mobile L', w: 425, h: 812 },
    { label: 'Tablet', w: 768, h: 1024 },
    { label: 'Laptop', w: 1024, h: 768 },
    { label: 'Laptop L', w: 1440, h: 900 },
    { label: 'Desktop', w: 1920, h: 1080 },
    { label: 'Desktop L', w: 2560, h: 1440 }
  ]
  const menu = Menu.buildFromTemplate(
    presets.map((p) => ({
      label: `${p.label}  (${p.w}×${p.h})`,
      click: () => {
        const contentWidth = p.w + (panelVisible ? PANEL_WIDTH : 0)
        const contentHeight = p.h + TOP_BAR_HEIGHT
        mainWindow?.setContentSize(contentWidth, contentHeight)
      }
    }))
  )
  menu.popup({ window: mainWindow })
})

// IPC: Custom URLs persistence
ipcMain.handle('get-custom-urls', () => {
  return (readSettings()['custom-urls'] as string[]) ?? []
})

ipcMain.handle('set-custom-urls', (_event, urls: string[]) => {
  writeSetting('custom-urls', urls)
})

// IPC: Get console logs from target page
ipcMain.handle('get-console-logs', () => {
  return consoleLogs.join('\n')
})

// IPC: Track unpinned tab count (for quit warning)
ipcMain.handle('set-unpinned-count', (_event, count: number) => {
  unpinnedTabCount = count
})

// IPC: Toggle side panel visibility
ipcMain.handle('set-panel-visible', async (_event, visible: boolean) => {
  panelVisible = visible
  layoutViews()
  // Enable/disable overlay inspect mode
  if (targetView) {
    try {
      await targetView.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: visible
          ? `window.__attributeEnableInspect__ && window.__attributeEnableInspect__()`
          : `window.__attributeDisableInspect__ && window.__attributeDisableInspect__()`
      })
    } catch {
      // ignore — overlay may not be injected yet
    }
  }
})

// IPC: Get current viewport size
ipcMain.handle('get-viewport-size', () => {
  return getViewportSize()
})

// IPC: Set viewport size (resize window to accommodate)
ipcMain.handle('set-viewport-size', (_event, w: number, h: number) => {
  if (!mainWindow) return
  const contentWidth = w + (panelVisible ? PANEL_WIDTH : 0)
  const contentHeight = h + TOP_BAR_HEIGHT
  mainWindow.setContentSize(contentWidth, contentHeight)
})

// --- Gemini API key helpers (encrypted via safeStorage) ---
function saveApiKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('safeStorage encryption not available — refusing to store API key in plaintext')
    return
  }
  const encrypted = safeStorage.encryptString(key)
  writeSetting('gemini-api-key', encrypted.toString('base64'))
  // Remove any legacy plaintext key
  deleteSetting('gemini-api-key-plain')
}

function loadApiKey(): string | undefined {
  const stored = readSettings()['gemini-api-key'] as string | undefined
  if (!stored) return undefined
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      // Might be a legacy plaintext value — migrate it
      saveApiKey(stored)
      return stored
    }
  }
  return stored
}

function removeApiKey(): void {
  deleteSetting('gemini-api-key')
}

// IPC: Gemini — check if API key is set (boolean only, key never exposed)
ipcMain.handle('gemini-has-key', () => {
  return !!loadApiKey()
})

// IPC: Gemini — store API key
ipcMain.handle('gemini-set-key', (_event, key: string) => {
  if (key.trim()) {
    saveApiKey(key.trim())
  } else {
    removeApiKey()
  }
  return true
})

// IPC: Gemini — per-group style suggestion (JSON mode)
ipcMain.handle(
  'gemini-style-suggest',
  async (_event, systemPrompt: string, userPrompt: string) => {
    const apiKey = loadApiKey()
    if (!apiKey) return { success: false, error: 'No API key' }

    try {
      const text = await geminiGenerate(apiKey, systemPrompt, userPrompt, {
        responseMimeType: 'application/json',
        maxTokens: 512
      })
      const parsed = JSON.parse(text)
      return { success: true, result: parsed }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }
)

// IPC: Gemini — enhance prompt (text mode)
ipcMain.handle(
  'gemini-enhance-prompt',
  async (_event, systemPrompt: string, userPrompt: string) => {
    const apiKey = loadApiKey()
    if (!apiKey) return { success: false, error: 'No API key' }

    try {
      const text = await geminiGenerate(apiKey, systemPrompt, userPrompt, {
        maxTokens: 256
      })
      return { success: true, result: text.trim() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }
)

// IPC: Console preview — show
ipcMain.handle(
  'console-preview-show',
  (_event, viewportX: number, viewportY: number, buttonWidth: number, mainHeight: number) => {
    if (!mainWindow) return
    consoleButtonBounds = { viewportX, viewportY, width: buttonWidth }
    const logs = consoleLogs.join('\n')
    showConsolePreview(viewportX, viewportY, buttonWidth, mainHeight, logs, () => {
      mainWindow?.webContents.send('console-preview-leave')
    })
  }
)

// IPC: Console preview — hide
ipcMain.handle('console-preview-hide', () => {
  hideConsolePreview()
})

// IPC: Console preview — update
ipcMain.handle('console-preview-update', () => {
  const logs = consoleLogs.join('\n')
  updateConsolePreview(logs)
})

// IPC: Console preview — check visibility
ipcMain.handle('console-preview-is-visible', () => {
  return isConsolePreviewVisible()
})

// IPC: Console preview — reposition on resize
ipcMain.handle(
  'console-preview-reposition',
  (_event, viewportX: number, viewportY: number, buttonWidth: number, mainHeight: number) => {
    consoleButtonBounds = { viewportX, viewportY, width: buttonWidth }
    repositionConsolePreview(viewportX, viewportY, buttonWidth, mainHeight)
  }
)

// IPC from preview window — mouse leave
ipcMain.on('console-preview-mouse-leave', () => {
  handlePreviewMouseLeave()
})

// IPC from preview window — mouse enter
ipcMain.on('console-preview-mouse-enter', () => {
  handlePreviewMouseEnter()
})

// IPC from main renderer — button mouse leave (schedule close unless preview captures cursor)
ipcMain.handle('console-preview-schedule-close', () => {
  scheduleCloseFromButton()
})

// IPC from main renderer — button mouse enter (cancel any pending close)
ipcMain.handle('console-preview-cancel-close', () => {
  cancelCloseFromButton()
})

// IPC from preview window — content height update
ipcMain.on('console-preview-content-height', (_event, height: number) => {
  handlePreviewContentHeight(height)
})

// IPC from preview window — execute command
ipcMain.on('console-preview-command', async (_event, command: string) => {
  if (!targetView) return
  
  // Add command to logs (just the input with > prefix)
  consoleLogs.push(`> ${command}`)
  if (consoleLogs.length > MAX_CONSOLE_LOGS) {
    consoleLogs = consoleLogs.slice(-MAX_CONSOLE_LOGS)
  }
  
  // Update preview with command
  updateConsolePreview(consoleLogs.join('\n'))
  
  try {
    const result = await targetView.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: command,
      returnByValue: true
    })
    
    if (result.result) {
      const value = result.result.value
      const type = result.result.type
      let output: string
      
      if (value === undefined) {
        output = 'undefined'
      } else if (typeof value === 'object') {
        output = JSON.stringify(value, null, 2)
      } else {
        output = String(value)
      }
      
      // Only show result if it's not undefined (undefined is implicit for statements)
      if (output !== 'undefined') {
        consoleLogs.push(output)
      }
    } else if (result.exceptionDetails) {
      consoleLogs.push(`[error] ${result.exceptionDetails.text || 'Error'}`)
    }
  } catch (err) {
    consoleLogs.push(`[error] ${String(err)}`)
  }
  
  if (consoleLogs.length > MAX_CONSOLE_LOGS) {
    consoleLogs = consoleLogs.slice(-MAX_CONSOLE_LOGS)
  }
  
  updateConsolePreview(consoleLogs.join('\n'))
})

let apiKeyWindow: BrowserWindow | null = null

function openApiKeyWindow(): void {
  if (apiKeyWindow) {
    apiKeyWindow.focus()
    return
  }

  const hasKey = !!loadApiKey()

  apiKeyWindow = new BrowserWindow({
    width: 380,
    height: 160,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Gemini API Key',
    parent: mainWindow ?? undefined,
    modal: true,
    show: false,
    backgroundColor: '#18181b',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: 'api-key-window'
    }
  })

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif; background:#18181b; color:#fafafa;
    padding:40px 20px 20px; display:flex; flex-direction:column; gap:10px; -webkit-app-region:drag; }
  .buttons { display:flex; gap:6px; justify-content:flex-end; -webkit-app-region:no-drag; }
  input { width:100%; height:32px; background:#0e0e10; border:1px solid #3f3f46; border-radius:6px;
    padding:0 10px; color:#fafafa; font-size:13px; outline:none; -webkit-app-region:no-drag; }
  input:focus { border-color:#6366f1; }
  input::placeholder { color:#71717a; }
  button { height:32px; padding:0 14px; border:none; border-radius:6px; font-size:13px; font-weight:500;
    cursor:pointer; white-space:nowrap; }
  .save { background:#6366f1; color:#fff; }
  .save:hover { background:#818cf8; }
  .cancel { background:#27272a; color:#a1a1aa; }
  .cancel:hover { background:#3f3f46; color:#fafafa; }
  .remove { background:none; border:none; color:#71717a; font-size:12px; cursor:pointer; padding:0;
    -webkit-app-region:no-drag; }
  .remove:hover { color:#ef4444; }
  .status { font-size:12px; color:#a1a1aa; -webkit-app-region:no-drag; }
</style></head><body>
  <input id="key" type="password" placeholder="${hasKey ? '••••••••  (enter new key to replace)' : 'Paste Gemini API key...'}" spellcheck="false" autofocus />
  <div class="buttons">
    <button class="cancel" id="cancel">Cancel</button>
    <button class="save" id="save">Save</button>
  </div>
  ${hasKey ? '<button class="remove" id="remove">Remove key</button>' : ''}
  <div class="status" id="status"></div>
  <script>
    const keyEl = document.getElementById('key');
    const statusEl = document.getElementById('status');
    document.getElementById('save').onclick = () => {
      const val = keyEl.value.trim();
      if (!val) return;
      fetch('ipc://set-key?key=' + encodeURIComponent(val));
      statusEl.textContent = 'Saved!';
      setTimeout(() => window.close(), 800);
    };
    document.getElementById('cancel').onclick = () => window.close();
    keyEl.onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('save').click(); if (e.key === 'Escape') window.close(); };
    const removeBtn = document.getElementById('remove');
    if (removeBtn) removeBtn.onclick = () => {
      fetch('ipc://remove-key');
      statusEl.textContent = 'Removed';
      setTimeout(() => window.close(), 800);
    };
  </script>
</body></html>`

  apiKeyWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

  apiKeyWindow.once('ready-to-show', () => apiKeyWindow?.show())
  apiKeyWindow.on('closed', () => {
    apiKeyWindow = null
    // Notify renderer that key may have changed
    mainWindow?.webContents.send('api-key-changed')
  })
}

// Handle API key save/remove from the key window via protocol (scoped to dedicated partition)
function setupApiKeyProtocol(): void {
  const apiKeySession = session.fromPartition('api-key-window')
  apiKeySession.protocol.handle('ipc', (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'set-key') {
      const key = url.searchParams.get('key') ?? ''
      if (key) saveApiKey(key)
    } else if (url.hostname === 'remove-key') {
      removeApiKey()
    }
    return new Response('ok')
  })
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Gemini API Key…',
          click: () => openApiKeyWindow()
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Page',
          accelerator: 'CmdOrCtrl+R',
          click: () => targetView?.webContents.reload()
        },
        {
          label: 'Force Reload Page',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => targetView?.webContents.reloadIgnoringCache()
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        {
          label: 'Duplicate Tab',
          accelerator: 'CmdOrCtrl+D',
          click: () => mainWindow?.webContents.send('duplicate-tab')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'"

app.whenReady().then(() => {
  setupApiKeyProtocol()
  createWindow()
  buildMenu()

  // Apply CSP to the main renderer via response headers (not the BrowserView which loads arbitrary sites).
  // Using onHeadersReceived ensures CSP is active before any scripts execute (no timing gap).
  if (mainWindow) {
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP]
        }
      })
    })
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
