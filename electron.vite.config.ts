import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { build as esbuild } from 'esbuild'
import type { Plugin } from 'vite'

function overlayPlugin(): Plugin {
  const overlayEntry = resolve(__dirname, 'src/inject/overlay.ts')
  let overlaySource = ''

  return {
    name: 'overlay-iife',
    async buildStart() {
      const result = await esbuild({
        entryPoints: [overlayEntry],
        bundle: true,
        format: 'iife',
        write: false,
        target: 'chrome120',
        minify: false
      })
      overlaySource = result.outputFiles[0].text
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'overlay.js',
        source: overlaySource
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), overlayPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'console-preview': resolve(__dirname, 'src/preload/console-preview.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()]
  }
})
