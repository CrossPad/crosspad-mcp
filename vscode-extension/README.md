# CrossPad SWD Tracer Bridge

Tiny VS Code extension that lets the `crosspad-mcp` SWD tracer open its live
dashboard **inside VS Code** (a Simple Browser editor tab) instead of the system
browser.

VS Code exposes no CLI / external command to open its in-editor browser, but it
does register itself as the OS handler for the `vscode://` scheme. This extension
registers a URI handler for its own id, so the tracer can fire:

```
vscode://crosspad.swd-tracer-bridge/open?url=http%3A%2F%2Flocalhost%3A7373%2F
```

and the extension opens that URL in a Simple Browser tab.

## Install (local)

```bash
cd vscode-extension
npx --yes @vscode/vsce package          # → swd-tracer-bridge-0.1.0.vsix
code --install-extension swd-tracer-bridge-0.1.0.vsix
```

Then set the tracer to VS Code mode (default):

```
crosspad_trace action=config_set key=ui_open value=vscode
```

`ui_open`: `vscode` (default — open in a VS Code tab via this bridge) ·
`browser` (system browser) · `none` (don't auto-open).
