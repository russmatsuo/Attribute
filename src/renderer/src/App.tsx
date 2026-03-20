import { useState, useEffect, useCallback, useRef } from 'react'
import ElementPanel from './components/ElementPanel'
import type { ElementData } from './lib/types'
import { compilePrompt } from './lib/promptCompiler'
import { buildEnhanceSystemPrompt, buildEnhanceUserPrompt } from './lib/aiPrompts'

declare global {
  interface Window {
    api: {
      navigate: (url: string) => Promise<{ success: boolean; url?: string; error?: string }>
      goBack: () => Promise<void>
      goForward: () => Promise<void>
      reload: () => Promise<void>
      cdpCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
      onUrlChanged: (callback: (url: string) => void) => () => void
      onElementSelected: (callback: (data: ElementData) => void) => () => void
      geminiHasKey: () => Promise<boolean>
      geminiSetKey: (key: string) => Promise<boolean>
      geminiStyleSuggest: (
        systemPrompt: string,
        userPrompt: string
      ) => Promise<{ success: boolean; result?: Record<string, string>; error?: string }>
      geminiEnhancePrompt: (
        systemPrompt: string,
        userPrompt: string
      ) => Promise<{ success: boolean; result?: string; error?: string }>
      onApiKeyChanged: (callback: () => void) => () => void
      getCustomUrls: () => Promise<string[]>
      setCustomUrls: (urls: string[]) => Promise<void>
      setPanelVisible: (visible: boolean) => Promise<void>
      setUnpinnedCount: (count: number) => Promise<void>
      getConsoleLogs: () => Promise<string>
      setViewportSize: (w: number, h: number) => Promise<void>
      getViewportSize: () => Promise<{ width: number; height: number }>
      onViewportSizeChanged: (callback: (size: { width: number; height: number }) => void) => () => void
      showSizePresets: () => Promise<void>
      consolePreviewShow: (x: number, y: number, buttonWidth: number, mainHeight: number) => Promise<void>
      consolePreviewHide: () => Promise<void>
      consolePreviewUpdate: () => Promise<void>
      consolePreviewIsVisible: () => Promise<boolean>
      consolePreviewReposition: (x: number, y: number, buttonWidth: number, mainHeight: number) => Promise<void>
      consolePreviewScheduleClose: () => Promise<void>
      consolePreviewCancelClose: () => Promise<void>
      onConsolePreviewLeave: (callback: () => void) => () => void
      onDuplicateTab: (callback: () => void) => () => void
      onPageTitleChanged: (callback: (title: string) => void) => () => void
    }
  }
}

export default function App() {
  const [url, setUrl] = useState('http://localhost:3000')
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [tabs, setTabs] = useState<Array<{ url: string; pinned: boolean; title?: string }>>([
    { url: 'http://localhost:3000', pinned: true }
  ])
  const [activeTab, setActiveTab] = useState<number | null>(0)
  const [selectedElement, setSelectedElement] = useState<ElementData | null>(null)
  const [initialStyles, setInitialStyles] = useState<Record<string, string>>({})
  const [modifiedStyles, setModifiedStyles] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState(false)
  const [logsCopied, setLogsCopied] = useState(false)
  const [pickedColor, setPickedColor] = useState<string | null>(null)
  const [highlightHidden, setHighlightHidden] = useState(false)
  const highlightHiddenRef = useRef(false)
  const [metaHeld, setMetaHeld] = useState(false)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [panelVisible, setPanelVisible] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [draftW, setDraftW] = useState('')
  const [draftH, setDraftH] = useState('')
  const [editingW, setEditingW] = useState(false)
  const [editingH, setEditingH] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const editingTabRef = useRef<number | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeTabRef = useRef<number | null>(null)
  const tabsRef = useRef(tabs)
  const urlRef = useRef(url)
  const consoleButtonRef = useRef<HTMLButtonElement>(null)
  const consoleHoverTimerRef = useRef<NodeJS.Timeout | null>(null)
  const [consolePreviewVisible, setConsolePreviewVisible] = useState(false)

  // Keep refs in sync for use inside event listener closures
  useEffect(() => { activeTabRef.current = activeTab }, [activeTab])
  useEffect(() => { tabsRef.current = tabs }, [tabs])
  useEffect(() => { urlRef.current = url }, [url])

  // Load pinned tabs from storage (replaces default if any saved)
  const tabsLoaded = useRef(false)
  useEffect(() => {
    window.api.getCustomUrls().then((urls) => {
      if (urls.length > 0) {
        setTabs(urls.map((u) => ({ url: u, pinned: true })))
      }
      tabsLoaded.current = true
    })
  }, [])

  // Persist only pinned tab URLs + report unpinned count to main for quit warning
  useEffect(() => {
    if (tabsLoaded.current) {
      window.api.setCustomUrls(tabs.filter((t) => t.pinned).map((t) => t.url))
    }
    window.api.setUnpinnedCount(tabs.filter((t) => !t.pinned).length)
  }, [tabs])

  // Get initial viewport size + listen for resize
  useEffect(() => {
    window.api.getViewportSize().then((size) => {
      setViewportWidth(size.width)
      setViewportHeight(size.height)
    })
    const unsub = window.api.onViewportSizeChanged((size) => {
      setViewportWidth(size.width)
      setViewportHeight(size.height)
    })
    return () => unsub()
  }, [])

  // Meta key held: toggle selection highlight temporarily
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Meta') {
        setMetaHeld(true)
        const hidden = highlightHiddenRef.current
        window.api.cdpCommand('Runtime.evaluate', {
          expression: hidden
            ? 'window.__attributeShowSelection__ && window.__attributeShowSelection__()'
            : 'window.__attributeHideSelection__ && window.__attributeHideSelection__()'
        })
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Meta') {
        setMetaHeld(false)
        const hidden = highlightHiddenRef.current
        window.api.cdpCommand('Runtime.evaluate', {
          expression: hidden
            ? 'window.__attributeHideSelection__ && window.__attributeHideSelection__()'
            : 'window.__attributeShowSelection__ && window.__attributeShowSelection__()'
        })
      }
    }
    globalThis.addEventListener('keydown', down)
    globalThis.addEventListener('keyup', up)
    return () => {
      globalThis.removeEventListener('keydown', down)
      globalThis.removeEventListener('keyup', up)
    }
  }, [])

  // Check for API key on mount + listen for changes from menu window
  useEffect(() => {
    window.api.geminiHasKey().then(setHasApiKey)
    const unsub = window.api.onApiKeyChanged?.(() => {
      window.api.geminiHasKey().then(setHasApiKey)
    })
    return () => unsub?.()
  }, [])

  // Listen for console preview leave events
  useEffect(() => {
    const unsub = window.api.onConsolePreviewLeave(() => {
      setConsolePreviewVisible(false)
    })
    return () => unsub()
  }, [])


  // Reposition console preview on window resize
  useEffect(() => {
    const handleResize = async () => {
      if (!consolePreviewVisible || !consoleButtonRef.current) return
      const rect = consoleButtonRef.current.getBoundingClientRect()
      // Use screen-absolute coords so main process doesn't need getBounds()
      const screenX = window.screenX + rect.left
      const screenY = window.screenY + rect.bottom
      const mainHeight = window.innerHeight
      await window.api.consolePreviewReposition(screenX, screenY, rect.width, mainHeight)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [consolePreviewVisible])

  useEffect(() => {
    const unsubUrl = window.api.onUrlChanged((newUrl) => {
      setUrl(newUrl)
      setInputValue(newUrl)
      setIsLoading(false)
      // Clear edit state on navigation
      setSelectedElement(null)
      setInitialStyles({})
      setModifiedStyles({})

      // If active tab is unpinned, update its URL to track navigation
      const idx = activeTabRef.current
      if (idx !== null) {
        setTabs((prev) => {
          if (idx >= prev.length || prev[idx].pinned) return prev
          const resolved = newUrl.replace(/\/$/, '')
          if (resolved.startsWith('https://www.google.com/search')) return prev
          const updated = [...prev]
          updated[idx] = { ...updated[idx], url: resolved }
          return updated
        })
      }
    })
    const unsubElement = window.api.onElementSelected((data) => {
      setSelectedElement(data)
      setInitialStyles({ ...data.computedStyles })
      setModifiedStyles({})
      setCopied(false)
      setConfirmReset(false)
    })
    return () => {
      unsubUrl()
      unsubElement()
    }
  }, [])

  const navigateTo = useCallback(async (target: string) => {
    setIsLoading(true)
    const result = await window.api.navigate(target)
    if (result.success && result.url) {
      setUrl(result.url)
    }
    setIsLoading(false)
  }, [])

  // Update the active tab's title when the page title changes
  useEffect(() => {
    const unsub = window.api.onPageTitleChanged((title) => {
      const idx = activeTabRef.current
      if (idx === null || !title) return
      setTabs((prev) => {
        const updated = [...prev]
        updated[idx] = { ...updated[idx], title }
        return updated
      })
    })
    return () => unsub()
  }, [])

  // Duplicate current tab as a new pinned tab (triggered via menu / Cmd+D)
  useEffect(() => {
    const unsub = window.api.onDuplicateTab(() => {
      const currentUrl = urlRef.current
      if (!currentUrl) return
      const idx = activeTabRef.current
      const currentTitle = idx !== null ? tabsRef.current[idx]?.title : undefined
      const newIndex = tabsRef.current.length
      setTabs((prev) => [...prev, { url: currentUrl, pinned: true, title: currentTitle }])
      setActiveTab(newIndex)
      navigateTo(currentUrl)
    })
    return () => unsub()
  }, [navigateTo])

  const handleTabClick = useCallback((index: number) => {
    setCustomMode(false)
    setActiveTab(index)
    navigateTo(tabs[index].url)
  }, [navigateTo, tabs])

  const handleCustomClick = useCallback(() => {
    editingTabRef.current = null
    setCustomMode(true)
    setInputValue('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const handleEditTab = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation()
    editingTabRef.current = index
    setCustomMode(true)
    setInputValue(tabs[index].url)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [tabs])

  const handleCustomSubmit = useCallback(async () => {
    const target = inputValue.trim()
    if (!target) return
    const editing = editingTabRef.current
    editingTabRef.current = null
    setCustomMode(false)
    const result = await window.api.navigate(target)
    if (result.success && result.url) {
      setUrl(result.url)
      const resolved = result.url.replace(/\/$/, '')
      if (editing !== null) {
        setTabs((prev) => {
          const updated = [...prev]
          updated[editing] = { ...updated[editing], url: resolved }
          return updated
        })
        setActiveTab(editing)
      } else {
        setTabs((prev) => {
          const newIndex = prev.length
          setActiveTab(newIndex)
          return [...prev, { url: resolved, pinned: false }]
        })
      }
    }
    setIsLoading(false)
  }, [inputValue])

  const handlePinTab = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setTabs((prev) => {
      const updated = [...prev]
      // Pin: freeze the current URL. Unpin: tab resumes tracking.
      updated[index] = { ...updated[index], pinned: !updated[index].pinned }
      return updated
    })
  }, [])

  const handleCloseTab = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (index === 0) return // default tab can't be closed
    const wasActive = activeTab === index
    const newTabs = tabs.filter((_, i) => i !== index)
    setTabs(newTabs)
    if (wasActive) {
      const next = Math.min(index, newTabs.length - 1)
      setActiveTab(next)
      navigateTo(newTabs[next].url)
    } else if (activeTab !== null && index < activeTab) {
      setActiveTab(activeTab - 1)
    }
  }, [activeTab, tabs, navigateTo])

  const toggleHighlight = useCallback(() => {
    const next = !highlightHiddenRef.current
    highlightHiddenRef.current = next
    setHighlightHidden(next)
    window.api.cdpCommand('Runtime.evaluate', {
      expression: next
        ? 'window.__attributeHideSelection__ && window.__attributeHideSelection__()'
        : 'window.__attributeShowSelection__ && window.__attributeShowSelection__()'
    })
  }, [])

  const handleEyedropper = useCallback(async () => {
    try {
      const dropper = new (window as any).EyeDropper()
      const result = await dropper.open()
      const color = result.sRGBHex as string
      if (color) {
        await navigator.clipboard.writeText(color)
        setPickedColor(color)
        setTimeout(() => setPickedColor(null), 2000)
      }
    } catch {
      // EyeDropper cancelled or unsupported
    }
  }, [])

  const handleConsoleMouseEnter = useCallback(() => {
    // Cancel any pending close scheduled by a previous leave
    window.api.consolePreviewCancelClose()
    if (consoleHoverTimerRef.current) {
      clearTimeout(consoleHoverTimerRef.current)
    }
    consoleHoverTimerRef.current = setTimeout(async () => {
      const button = consoleButtonRef.current
      if (!button) return
      const rect = button.getBoundingClientRect()
      // Use screen-absolute coords so main process doesn't need getBounds()
      const screenX = window.screenX + rect.left
      const screenY = window.screenY + rect.bottom
      const mainHeight = window.innerHeight
      await window.api.consolePreviewShow(screenX, screenY, rect.width, mainHeight)
      setConsolePreviewVisible(true)
    }, 100)
  }, [])

  const handleConsoleMouseLeave = useCallback(() => {
    if (consoleHoverTimerRef.current) {
      clearTimeout(consoleHoverTimerRef.current)
      consoleHoverTimerRef.current = null
    }
    // Schedule close — cancelled if cursor enters the preview window within 300ms
    window.api.consolePreviewScheduleClose()
  }, [])

  const handleCopyLogs = useCallback(async () => {
    const logs = await window.api.getConsoleLogs()
    const header = `Here's the current console output on ${url}. Use it to debug any issues. Add logging to help solve what's not working.\n\n`
    await navigator.clipboard.writeText(header + (logs || '(no console output)'))
    setLogsCopied(true)
    setTimeout(() => setLogsCopied(false), 2000)
    // Update preview if visible
    if (consolePreviewVisible) {
      await window.api.consolePreviewUpdate()
    }
  }, [url, consolePreviewVisible])

  const handleDragStart = useCallback((index: number, e: React.DragEvent) => {
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    ;(e.target as HTMLElement).style.opacity = '0.5'
  }, [])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    ;(e.target as HTMLElement).style.opacity = ''
    setDragIndex(null)
    setDropIndex(null)
  }, [])

  const handleDragOver = useCallback((index: number, e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragIndex !== null && index !== dragIndex) {
      setDropIndex(index)
    }
  }, [dragIndex])

  const handleDrop = useCallback((index: number, e: React.DragEvent) => {
    e.preventDefault()
    if (dragIndex === null || dragIndex === index) return
    setTabs((prev) => {
      const updated = [...prev]
      const [moved] = updated.splice(dragIndex, 1)
      updated.splice(index, 0, moved)
      return updated
    })
    setActiveTab((prev) => {
      if (prev === null) return null
      if (prev === dragIndex) return index
      if (dragIndex < prev && index >= prev) return prev - 1
      if (dragIndex > prev && index <= prev) return prev + 1
      return prev
    })
    setDragIndex(null)
    setDropIndex(null)
  }, [dragIndex])

  const togglePanel = useCallback(() => {
    const next = !panelVisible
    setPanelVisible(next)
    window.api.setPanelVisible(next)
  }, [panelVisible])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCustomSubmit()
    } else if (e.key === 'Escape') {
      setCustomMode(false)
    }
  }

  const handleStyleChange = useCallback(
    async (prop: string, value: string) => {
      // Update local modified state
      setModifiedStyles((prev) => ({ ...prev, [prop]: value }))

      // Apply via CDP → __attributeSetStyle__ on the target page
      const res = await window.api.cdpCommand('Runtime.evaluate', {
        expression: `window.__attributeSetStyle__(${JSON.stringify(prop)}, ${JSON.stringify(value)})`,
        returnByValue: true
      })
      console.log('[Attribute] style change:', prop, value, res)
    },
    []
  )

  const handleRevertStyle = useCallback(async (prop: string) => {
    const original = initialStyles[prop] ?? ''
    await window.api.cdpCommand('Runtime.evaluate', {
      expression: `window.__attributeSetStyle__(${JSON.stringify(prop)}, ${JSON.stringify(original)})`,
      returnByValue: true
    })
    setModifiedStyles((prev) => {
      const next = { ...prev }
      delete next[prop]
      return next
    })
  }, [initialStyles])

  const handleTextChange = useCallback(async (text: string) => {
    await window.api.cdpCommand('Runtime.evaluate', {
      expression: `window.__attributeSetText__(${JSON.stringify(text)})`,
      returnByValue: true
    })
    setSelectedElement((prev) => prev ? { ...prev, textContent: text } : prev)
  }, [])

  const handleSelectParent = useCallback(async () => {
    const res = await window.api.cdpCommand('Runtime.evaluate', {
      expression: `window.__attributeSelectParent__()`,
      returnByValue: true
    }) as { success: boolean; result?: { result?: { value?: string } } }
    const json = res?.result?.result?.value
    if (!json) return
    try {
      const data = JSON.parse(json) as ElementData
      setSelectedElement(data)
      setInitialStyles({ ...data.computedStyles })
      setModifiedStyles({})
      setCopied(false)
    } catch {
      // ignore parse errors
    }
  }, [])

  const handleSelectChild = useCallback(async () => {
    const res = await window.api.cdpCommand('Runtime.evaluate', {
      expression: `window.__attributeSelectChild__()`,
      returnByValue: true
    }) as { success: boolean; result?: { result?: { value?: string } } }
    const json = res?.result?.result?.value
    if (!json) return
    try {
      const data = JSON.parse(json) as ElementData
      setSelectedElement(data)
      setInitialStyles({ ...data.computedStyles })
      setModifiedStyles({})
      setCopied(false)
    } catch {
      // ignore parse errors
    }
  }, [])

  const handleCopyPrompt = useCallback(async () => {
    if (!selectedElement) return
    const mechanical = compilePrompt(selectedElement, initialStyles, modifiedStyles)
    if (!mechanical) return

    // Try AI enhancement first, fall back to mechanical prompt
    let finalPrompt = mechanical
    if (hasApiKey) {
      try {
        const systemPrompt = buildEnhanceSystemPrompt()
        const userPrompt = buildEnhanceUserPrompt(selectedElement, initialStyles, modifiedStyles)
        const res = await window.api.geminiEnhancePrompt(systemPrompt, userPrompt)
        if (res.success && res.result) {
          finalPrompt = res.result
        }
      } catch {
        // Fall back to mechanical prompt
      }
    }

    await navigator.clipboard.writeText(finalPrompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [selectedElement, initialStyles, modifiedStyles, hasApiKey])

  const [resetCountdown, setResetCountdown] = useState(0)

  useEffect(() => {
    if (!confirmReset) { setResetCountdown(0); return }
    setResetCountdown(3)
    const interval = setInterval(() => {
      setResetCountdown((prev) => {
        if (prev <= 1) { setConfirmReset(false); return 0 }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [confirmReset])

  const handleResetClick = useCallback(() => {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    setConfirmReset(false)
    // Re-apply each modified property's original value via CDP
    ;(async () => {
      for (const prop of Object.keys(modifiedStyles)) {
        const original = initialStyles[prop] ?? ''
        await window.api.cdpCommand('Runtime.evaluate', {
          expression: `window.__attributeSetStyle__(${JSON.stringify(prop)}, ${JSON.stringify(original)})`,
          returnByValue: true
        })
      }
      setModifiedStyles({})
      setCopied(false)
    })()
  }, [confirmReset, modifiedStyles, initialStyles])

  // Count genuine modifications (where value differs from initial)
  const modificationCount = Object.entries(modifiedStyles).filter(
    ([prop, value]) => value !== (initialStyles[prop] ?? '')
  ).length

  return (
    <div className="app">
      {/* Top nav bar */}
      <div className="url-bar">
        <div className="nav-buttons">
          <button className="nav-btn" onClick={() => window.api.goBack()} title="Back">
            <span className="material-symbols-rounded">arrow_back</span>
          </button>
          <button className="nav-btn" onClick={() => window.api.goForward()} title="Forward">
            <span className="material-symbols-rounded">arrow_forward</span>
          </button>
          <button className="nav-btn" onClick={() => window.api.reload()} title="Reload">
            <span className="material-symbols-rounded">refresh</span>
          </button>
        </div>
        {customMode ? (
          <div className="url-input-wrapper">
            <input
              ref={inputRef}
              className="url-input"
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => { setCustomMode(false); editingTabRef.current = null }}
              onFocus={(e) => e.target.select()}
              placeholder="Enter URL or search..."
              spellCheck={false}
            />
            <button
              className="url-input-close"
              onMouseDown={(e) => { e.preventDefault(); setCustomMode(false); editingTabRef.current = null }}
            >
              <span className="material-symbols-rounded">close</span>
            </button>
            {isLoading && <div className="loading-indicator" />}
          </div>
        ) : (
          <div className="nav-chips">
            {tabs.map((tab, index) => {
              let label: string
              if (tab.title) {
                label = tab.title
              } else {
                try { label = new URL(tab.url).host.replace(/^www\./, '') } catch { label = tab.url }
              }
              const isActive = activeTab === index
              return (
                <button
                  key={index}
                  className={`nav-chip${isActive ? ' nav-chip--active' : ''}${tab.pinned ? ' nav-chip--pinned' : ''}${dropIndex === index ? ' nav-chip--drop-target' : ''}`}
                  onClick={() => handleTabClick(index)}
                  draggable
                  onDragStart={(e) => handleDragStart(index, e)}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => handleDragOver(index, e)}
                  onDrop={(e) => handleDrop(index, e)}
                >
                  {index === 0 ? (
                    <>
                      {label}
                      <span
                        className="nav-chip-edit material-symbols-rounded"
                        onClick={(e) => handleEditTab(index, e)}
                        title="Edit default URL"
                      >
                        edit
                      </span>
                    </>
                  ) : (
                    <>
                      <span
                        className="nav-chip-pin material-symbols-rounded"
                        onClick={(e) => handlePinTab(index, e)}
                        title={tab.pinned ? 'Unpin' : 'Pin'}
                      >
                        {tab.pinned ? 'push_pin' : 'keep'}
                      </span>
                      {label}
                      <span
                        className="nav-chip-close material-symbols-rounded"
                        onClick={(e) => handleCloseTab(index, e)}
                      >
                        close
                      </span>
                    </>
                  )}
                </button>
              )
            })}
            <button className="nav-chip nav-chip--add" onClick={handleCustomClick}>
              <span className="material-symbols-rounded">add</span>
            </button>
            {isLoading && <div className="loading-indicator" />}
          </div>
        )}
        <div className="viewport-controls">
          <input
            className="viewport-input"
            type="text"
            value={editingW ? draftW : viewportWidth}
            onChange={(e) => setDraftW(e.target.value)}
            onFocus={(e) => { setDraftW(String(viewportWidth)); setEditingW(true); e.target.select() }}
            onBlur={() => setEditingW(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const w = parseInt(draftW, 10)
                if (w > 0) window.api.setViewportSize(w, viewportHeight)
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                setEditingW(false)
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)
                const w = Math.max(1, (parseInt(draftW, 10) || viewportWidth) + delta)
                setDraftW(String(w))
                window.api.setViewportSize(w, viewportHeight)
              }
            }}
          />
          <span className="viewport-x">×</span>
          <input
            className="viewport-input"
            type="text"
            value={editingH ? draftH : viewportHeight}
            onChange={(e) => setDraftH(e.target.value)}
            onFocus={(e) => { setDraftH(String(viewportHeight)); setEditingH(true); e.target.select() }}
            onBlur={() => setEditingH(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const h = parseInt(draftH, 10)
                if (h > 0) window.api.setViewportSize(viewportWidth, h)
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                setEditingH(false)
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)
                const h = Math.max(1, (parseInt(draftH, 10) || viewportHeight) + delta)
                setDraftH(String(h))
                window.api.setViewportSize(viewportWidth, h)
              }
            }}
          />
          <button
            className="nav-btn"
            onClick={() => window.api.showSizePresets()}
            title="Preset sizes"
          >
            <span className="material-symbols-rounded">screenshot_monitor</span>
          </button>
          <button
            ref={consoleButtonRef}
            className={`nav-btn nav-btn--copyable${logsCopied ? ' nav-btn--copied' : ''}`}
            onClick={handleCopyLogs}
            onMouseEnter={handleConsoleMouseEnter}
            onMouseLeave={handleConsoleMouseLeave}
            title="Copy Console"
          >
            <span className="material-symbols-rounded">{logsCopied ? 'check' : 'terminal'}</span>
            <span className="nav-btn-copied-label"><span>Copied!</span></span>
          </button>
          <button
            className={`nav-btn nav-btn--copyable${pickedColor ? ' nav-btn--copied' : ''}`}
            onClick={handleEyedropper}
            title="Pick color"
          >
            <span className="material-symbols-rounded">{pickedColor ? 'check' : 'colorize'}</span>
            <span className="nav-btn-copied-label"><span>Copied {pickedColor || ''}</span></span>
          </button>
          <button
            className={`nav-btn panel-toggle${panelVisible ? ' panel-toggle--active' : ''}`}
            onClick={togglePanel}
            title="Open inspector"
          >
            <span className="material-symbols-rounded">palette</span>
          </button>
        </div>
      </div>

      {/* Side panel - positioned on the right */}
      <div className={`side-panel${panelVisible ? '' : ' side-panel--hidden'}`}>
        <div className="panel-toolbar">
          <div className="panel-header">
            {selectedElement && (
              <>
                <button
                  className="header-icon-btn"
                  onClick={handleSelectParent}
                  title="Parent"
                >
                  <span className="material-symbols-rounded">move_up</span>
                </button>
                <button
                  className="header-icon-btn"
                  onClick={handleSelectChild}
                  title="Child"
                >
                  <span className="material-symbols-rounded">move_down</span>
                </button>
              </>
            )}
            {selectedElement && (
              <button
                className="header-icon-btn"
                onClick={toggleHighlight}
                title={highlightHidden ? 'Show highlight' : 'Hide highlight'}
              >
                <span className="material-symbols-rounded">{highlightHidden ? 'visibility_off' : 'visibility'}</span>
              </button>
            )}
            {selectedElement && modificationCount > 0 && (
              <div className="reset-btn-wrapper">
                <button
                  className={`header-icon-btn${confirmReset ? ' header-icon-btn--danger' : ''}`}
                  onClick={handleResetClick}
                  title={confirmReset ? undefined : 'Clear changes'}
                >
                  <span className="material-symbols-rounded">{confirmReset ? 'delete_forever' : 'delete'}</span>
                </button>
                {confirmReset && (
                  <div className="reset-tooltip">Click to confirm ({resetCountdown})</div>
                )}
              </div>
            )}
            {selectedElement && (
              <div className="panel-header-right">
                <button
                  className={`header-copy-btn${copied ? ' header-copy-btn--copied' : ''}`}
                  onClick={handleCopyPrompt}
                  disabled={modificationCount === 0}
                  title="Copy Prompt"
                >
                  <span className="material-symbols-rounded">{copied ? 'check' : 'content_copy'}</span>
                  {copied ? 'Copied!' : 'Prompt'}
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="panel-content">
          {selectedElement ? (
            <ElementPanel
              element={selectedElement}
              initialStyles={initialStyles}
              modifiedStyles={modifiedStyles}
              onStyleChange={handleStyleChange}
              onRevertStyle={handleRevertStyle}
              onCopyPrompt={handleCopyPrompt}
              onReset={handleResetClick}
              onTextChange={handleTextChange}
              copied={copied}
              modificationCount={modificationCount}
              hasApiKey={hasApiKey}
            />
          ) : (
            <div className="placeholder">
              <span className="material-symbols-rounded placeholder-icon">search</span>
              <p>Select an element<br/>to inspect</p>
            </div>
          )}
        </div>
        <div className={`panel-tip${selectedElement ? ' panel-tip--visible' : ''}`}>
          <kbd className="key-icon">&#8984;</kbd>
          {metaHeld ? 'Release to show guides' : 'Hold to hide guides'}
        </div>
      </div>

    </div>
  )
}
