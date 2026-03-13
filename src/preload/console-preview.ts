import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  onMouseLeave: () => ipcRenderer.send('console-preview-mouse-leave'),
  onMouseEnter: () => ipcRenderer.send('console-preview-mouse-enter'),
  onContentHeight: (height: number) => ipcRenderer.send('console-preview-content-height', height),
  onCommand: (command: string) => ipcRenderer.send('console-preview-command', command)
})
