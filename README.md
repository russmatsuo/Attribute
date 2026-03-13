# Attribute

A Chromium-based browser for vibecoding and rapid visual prototyping.

Attribute lets you browse to any site, click any element, and tweak its styles live — with an AI-assisted side panel powered by Gemini that turns your changes into natural language prompts you can feed back into your design workflow.

## Features

- **In-browser element inspector** — click any element to select it and edit its CSS live
- **Viewport controls** — resize the browser view to test responsive layouts
- **AI prompt generation** — describe your style changes in natural language, powered by Google Gemini
- **Pinned tabs** — save URLs you're actively building on
- **Console log capture** — copy browser logs directly from the panel

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 18+
- A [Google Gemini API key](https://aistudio.google.com/app/apikey) (free tier works)

## Getting Started

```bash
# Install dependencies
npm install

# Start in development mode
npm run dev
```

On first launch, enter your Gemini API key in the side panel. It's stored encrypted using your OS keychain — never sent anywhere except directly to Google's API.

## Building

```bash
# Build for production
npm run build

# Build + package as macOS DMG
npm run dist
```

Output is written to `release/`.

## Project Structure

```
src/
├── main/         # Electron main process (window, BrowserView, IPC, CDP)
├── preload/      # Context-isolated IPC bridge
├── renderer/     # React side panel UI
└── inject/       # Overlay script injected into target pages via CDP
```

## Contributing

Pull requests are welcome. For significant changes, open an issue first to discuss what you'd like to change.

## License

GPL v3 — see [LICENSE](LICENSE).

You're free to use, fork, and contribute. Any derivative work must also be distributed under GPL v3.
