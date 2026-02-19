# Codex Desktop (Windows)

Desktop UI wrapper for the `codex` CLI with:

- Model profiles (`Codex 5.1`, `Codex 5.2`, `Codex 5.3`)
- Reasoning effort selector (`Low`, `Medium`, `High`) with invalid legacy values auto-mapped
- Approval mode selector (`Ask Me`, `Yes Yes and Allow`, `No, Suggest Something Else`)
- Image attachments per message
- Clipboard image paste support
- Local chat history/session list
- Workspace folder picker with folder preview
- Codex install/login health check with Refresh button
- Custom startup splash animation
- Session continuity using `codex exec` + `codex exec resume`

## Requirements

- Windows
- Node.js 20+
- `codex` CLI installed and authenticated (`codex login`)

## Run

```bash
npm install
npm start
```

If your global `npm` command is broken on Windows, use:

```powershell
.\start-codex-desktop.cmd
```

## Build EXE

```powershell
.\build-exe.cmd
```

Output:

- `dist\CodexDesktop-0.1.0-x64.exe`

## Build MSI (x64 + x86)

```powershell
.\build-msi.cmd
```

Or run individual targets:

```powershell
npm run build:msi:x64
npm run build:msi:ia32
```

Output:

- `dist\Codex-Desktop-<version>-x64.msi`
- `dist\Codex-Desktop-<version>-ia32.msi`

Installer behavior:

- Shows a license agreement that must be accepted
- Guided install flow (`oneClick: false`) with install mode and destination selection

Install location (default if unchanged):

- `C:\Program Files\Codex-Desktop`

## Notes

- The app stores state in Electron `userData` (`state.json`), not in this repo.
- Folder changes reset the underlying Codex thread id for that chat session.
- The app uses the command from the `Codex Command` field (default: `codex`).
