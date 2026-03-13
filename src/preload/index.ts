import { contextBridge, ipcRenderer } from 'electron'

const api = {
  navigate: (url: string) => ipcRenderer.invoke('navigate', url),
  goBack: () => ipcRenderer.invoke('go-back'),
  goForward: () => ipcRenderer.invoke('go-forward'),
  reload: () => ipcRenderer.invoke('reload'),
  cdpCommand: (method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke('cdp-command', method, params),
  onUrlChanged: (callback: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) => callback(url)
    ipcRenderer.on('url-changed', handler)
    return () => ipcRenderer.removeListener('url-changed', handler)
  },
  onElementSelected: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
    ipcRenderer.on('element-selected', handler)
    return () => ipcRenderer.removeListener('element-selected', handler)
  },
  geminiHasKey: () => ipcRenderer.invoke('gemini-has-key') as Promise<boolean>,
  geminiSetKey: (key: string) => ipcRenderer.invoke('gemini-set-key', key) as Promise<boolean>,
  geminiStyleSuggest: (systemPrompt: string, userPrompt: string) =>
    ipcRenderer.invoke('gemini-style-suggest', systemPrompt, userPrompt) as Promise<{
      success: boolean
      result?: Record<string, string>
      error?: string
    }>,
  geminiEnhancePrompt: (systemPrompt: string, userPrompt: string) =>
    ipcRenderer.invoke('gemini-enhance-prompt', systemPrompt, userPrompt) as Promise<{
      success: boolean
      result?: string
      error?: string
    }>,
  showSizePresets: () => ipcRenderer.invoke('show-size-presets'),
  getCustomUrls: () => ipcRenderer.invoke('get-custom-urls') as Promise<string[]>,
  setCustomUrls: (urls: string[]) => ipcRenderer.invoke('set-custom-urls', urls),
  setPanelVisible: (visible: boolean) => ipcRenderer.invoke('set-panel-visible', visible),
  setUnpinnedCount: (count: number) => ipcRenderer.invoke('set-unpinned-count', count),
  getConsoleLogs: () => ipcRenderer.invoke('get-console-logs') as Promise<string>,
  setViewportSize: (w: number, h: number) => ipcRenderer.invoke('set-viewport-size', w, h),
  getViewportSize: () => ipcRenderer.invoke('get-viewport-size') as Promise<{ width: number; height: number }>,
  onViewportSizeChanged: (callback: (size: { width: number; height: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, size: { width: number; height: number }) => callback(size)
    ipcRenderer.on('viewport-size-changed', handler)
    return () => ipcRenderer.removeListener('viewport-size-changed', handler)
  },
  onApiKeyChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('api-key-changed', handler)
    return () => ipcRenderer.removeListener('api-key-changed', handler)
  },
  consolePreviewShow: (x: number, y: number, buttonWidth: number, mainHeight: number) =>
    ipcRenderer.invoke('console-preview-show', x, y, buttonWidth, mainHeight),
  consolePreviewHide: () => ipcRenderer.invoke('console-preview-hide'),
  consolePreviewUpdate: () => ipcRenderer.invoke('console-preview-update'),
  consolePreviewIsVisible: () => ipcRenderer.invoke('console-preview-is-visible') as Promise<boolean>,
  consolePreviewReposition: (x: number, y: number, buttonWidth: number, mainHeight: number) =>
    ipcRenderer.invoke('console-preview-reposition', x, y, buttonWidth, mainHeight),
  consolePreviewScheduleClose: () => ipcRenderer.invoke('console-preview-schedule-close'),
  consolePreviewCancelClose: () => ipcRenderer.invoke('console-preview-cancel-close'),
  onConsolePreviewLeave: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('console-preview-leave', handler)
    return () => ipcRenderer.removeListener('console-preview-leave', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
