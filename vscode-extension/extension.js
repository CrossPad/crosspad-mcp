// CrossPad SWD Tracer Bridge — opens the tracer dashboard in a VS Code editor
// tab in response to a vscode:// deep link fired by the MCP server.
//
// Flow:  crosspad_trace action=start (ui_open=vscode)
//          → server: xdg-open "vscode://crosspad.swd-tracer-bridge/open?url=<http url>"
//          → OS routes vscode:// to VS Code → activates this extension (onUri)
//          → handleUri() opens the URL in a Simple Browser editor tab.
//
// This is the only mechanism that lets an EXTERNAL process open an in-editor
// browser tab: VS Code has no CLI / generic external command for it, but it does
// register itself as the OS handler for the vscode:// scheme, and an extension
// may register a URI handler for its own extension id.
const vscode = require("vscode");

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        // Expect: vscode://crosspad.swd-tracer-bridge/open?url=<encoded http url>
        let raw = null;
        try {
          raw = new URLSearchParams(uri.query).get("url");
        } catch (_e) {
          return;
        }
        if (!raw) return;
        // SECURITY: the deep link is invokable by ANY web page / process, so the
        // `url` is untrusted. The only legitimate target is the local tracer
        // dashboard, so hard-restrict to http(s) on a loopback host and reject
        // everything else. Do NOT fall back to env.openExternal — that would let
        // a crafted vscode:// link open arbitrary URIs (file://, mailto:, other
        // schemes) system-wide. Simple Browser is an in-editor webview, safe.
        let parsed;
        try {
          parsed = new URL(raw);
        } catch (_e) {
          return;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return;
        const url = parsed.toString();
        Promise.resolve(vscode.commands.executeCommand("simpleBrowser.show", url)).then(
          undefined,
          () =>
            Promise.resolve(
              vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(url)),
            ).then(undefined, () => { /* in-editor open failed; do not escalate to external */ }),
        );
      },
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
