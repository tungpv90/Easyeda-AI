# Claude Chat dialog

`Copilot → Claude Chat` opens a chat window inside EasyEDA Pro. Claude works on the open project through the same EasyEDA Copilot MCP tools that Claude Code uses, so you do not need a terminal session.

The dialog uses **your own Claude Code installation and sign-in** (Claude Pro or Max subscription, or a Console account). It never reads or stores Claude credentials.

## Setup (Windows)

1. Import the `.eext` in EasyEDA Pro (`Settings → Extensions → Extensions Manager → Import Extensions`) and enable **External Interactions**.
2. Double-click `ClaudeChatSetup.exe` once. It needs no Node.js. It:
   - installs Claude Code with Anthropic's official installer if it is missing;
   - copies the helper to `%LOCALAPPDATA%\EasyEDA Copilot\Claude Chat`;
   - starts the helper now and at every Windows login (Startup folder).
3. Open `Copilot → Claude Chat`. If Claude Code is not signed in yet, select **Sign in with Claude**; a browser window opens for the claude.ai sign-in.

Running `ClaudeChatSetup.exe` again updates the helper. `ClaudeChatSetup.exe --uninstall` removes it.

Why a separate installer: EasyEDA extensions run in a sandbox and cannot start programs, so the helper that runs Claude Code has to be installed outside EasyEDA.

### Building the installer

```sh
npm run build:installer   # -> build/dist/ClaudeChatSetup.exe
```

The installer is a Node.js single executable application ([installer/](../installer/)). It carries the built MCP package and its Windows runtime dependencies. The installed copy also serves as the Node runtime for the helper and the MCP server.

### Other platforms and development

With Node.js 20.19+: `node mcp/dist/index.js chat --install` (or `--uninstall`). This uses a LaunchAgent on macOS and XDG autostart on Linux. To run in the foreground: `node mcp/dist/index.js chat`.

## How it works

```text
EasyEDA dialog ──ws://127.0.0.1:8788──▶ chat helper ──stdin/stdout──▶ claude -p (stream-json)
      ▲                                     │                              │
      └──── ws://127.0.0.1:8787 (bridge) ◀──┴──── easyeda-copilot MCP ◀────┘
```

- The helper keeps the EasyEDA bridge (port 8787) open, so the extension stays connected between messages. A Claude Code session started elsewhere shares it.
- Each conversation is one `claude -p --input-format stream-json --output-format stream-json` process. If it stops, the next message resumes the same session.
- The EasyEDA tools run without prompts (document changes are checkpoint-backed). Claude can also read the local MCP docs, search the web and fetch pages. Fetching a page asks for permission in the dialog.
- Shell commands, file edits and file writes are disabled (`--restricted`), and Claude Code ignores your other MCP servers and settings files for this session.

## Security

Any web page can try to open a WebSocket to `127.0.0.1`. The helper accepts a connection only when:

- the `Host` header is a loopback address, and
- the `Origin` is absent, an EasyEDA/LCEDA/JLC domain, `localhost`, or a non-web scheme used by the desktop client.

Rejected connections are logged with the origin. If your EasyEDA client sends an origin that is not recognised, allow it explicitly with `EASYEDA_COPILOT_CHAT_ORIGINS`.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `EASYEDA_COPILOT_CHAT_PORT` | `8788` | Port for the dialog (the dialog currently expects 8788). |
| `EASYEDA_COPILOT_CHAT_HOME` | `~/.easyeda-copilot/chat` | Log file, MCP config and Claude's working folder. |
| `EASYEDA_COPILOT_CHAT_ORIGINS` | – | Extra allowed origins, comma-separated. |
| `EASYEDA_COPILOT_CLAUDE_PATH` | found on `PATH` | Path to the `claude` executable. |
| `EASYEDA_COPILOT_MCP_WS_PORT` | `8787` | EasyEDA bridge port, passed on to the MCP server. |

## Troubleshooting

- **"Claude Chat is not installed on this computer"**: run `ClaudeChatSetup.exe` again, or check `~/.easyeda-copilot/chat/daemon.log`.
- **"Allow External Interactions"**: enable it in the Extensions Manager and reopen the dialog.
- **"This EasyEDA window is not connected"**: use `Copilot → MCP` to restart the extension's bridge connection.
- **Usage limits**: the header shows your 5-hour / 7-day subscription usage as reported by Claude Code.

## Terms

The helper drives the Claude Code CLI that you installed and signed in to yourself. If you redistribute this as a product for other people, check Anthropic's terms first: third-party products are generally expected to use API-key authentication rather than offer claude.ai sign-in.
