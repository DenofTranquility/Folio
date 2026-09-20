# Folio

A quiet Markdown reader for Windows. Rust handles file access and Markdown parsing; a small, framework-free interface uses the existing Microsoft Edge WebView2 runtime.

## Run

Open **dist/Folio.exe**. No installer is needed. Choose a document with **Ctrl+O**, drop a file into the window, or pass its path on the command line:

```powershell
.\dist\Folio.exe "C:\Notes\readme.md"
```

Try `examples/field-notes.md` for tables, code, tasks, local images, footnotes, and linked documents. In Windows, you can use **Open with → Choose another app** to associate `.md` files with Folio if you want.

Requires Windows 10/11 x64 and Microsoft Edge WebView2 (normally already installed). The executable does not bundle a browser, run a server, or need Node.js.

## Features

- Markdown headings, emphasis, lists, tables, blockquotes, task lists, strikethrough, fenced code and footnotes.
- File picker, drag and drop, command-line opening, recent documents, back/forward history and heading navigation.
- Case-insensitive search with highlighted matches, including phrases spanning inline formatting.
- Paper, light and dark themes; serif/sans-serif text; adjustable size; wide layout; focus mode.
- Remembered reading positions and preferences. Automatic refresh checks the active file every two seconds while the app is visible, and when the window gains focus.
- Selectable text, one-click code copying, and Print / Save as PDF.
- Relative local images and Markdown links. Web and email links open in your default application.
- Keyboard navigation and shortcuts, reduced-motion support, and semantic screen-reader controls.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Open | Ctrl+O |
| Search | Ctrl+F |
| Next / previous match | Enter / Shift+Enter in search |
| Sidebar | Ctrl+B |
| Focus mode | Ctrl+Shift+F |
| Text size | Ctrl+plus / Ctrl+minus |
| Reset text size | Ctrl+0 |
| Previous / next document | Alt+Left / Alt+Right |
| Reload | F5 or Ctrl+R |
| Print / PDF | Ctrl+P |
| Close search or focus mode | Escape |
| Shortcut reference | ? |

## Build

Install stable Rust and Microsoft's **Visual Studio Build Tools 2022** with **MSVC x64/x86 tools** and a **Windows 11 SDK**. No frontend package install or build step is needed.

```powershell
cargo run -- examples/field-notes.md
cargo test --locked
cargo clippy --locked -- -D warnings
cargo build --release --locked
```

`scripts/build.ps1` builds and copies the release executable and documentation into `dist/`. The checked-in Cargo.lock pins dependencies.

## Scope and privacy

Folio is a reader: it never edits your Markdown files. Rendering is done in Rust with pulldown-cmark and sanitized with Ammonia. Document scripts, embedded frames, and active HTML are removed. Remote images require a per-image click and use no referrer. Preferences, recent paths, and up to 100 reading positions are stored locally in the app's WebView2 storage. There is no telemetry or cloud service. Clear recent files also clears saved reading positions.

Files must be UTF-8 or BOM-marked UTF-16 and no larger than 20 MB. Local images support PNG, JPEG, GIF, WebP, BMP and SVG, up to 8 MB per image and 24 MB total per document. Missing images display an explanation. Network-share links are not followed. Search highlights the first 5,000 matches. Code blocks are rendered as plain monospaced text with their language label; executable diagrams, LaTeX, MDX components, and syntax coloring are outside this reader's scope.

The Windows release is the supported build. The underlying libraries are cross-platform, but macOS/Linux are not verified here.
