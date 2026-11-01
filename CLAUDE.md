# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Easyeda-AI is a fork of [EasyEDA Copilot](https://github.com/biosshot/easyeda-copilot). It is an EasyEDA Pro extension plus an MCP server that lets AI agents create, place, route and verify schematics/PCBs in real EasyEDA documents. This fork adds a **Claude Chat** dialog inside EasyEDA, backed by a local helper that runs the user's own `claude -p` session.

npm workspaces (one root `package-lock.json`; run `npm ci` from the root):

- `extension/` (`@copilot/extension`): the EasyEDA extension. `src/` runs in the EasyEDA editor runtime; `web/` is the Vue 3 + Pinia UI served as iframes.
- `mcp/` (`easyeda-copilot-mcp`): the MCP server, CLI, SDK, Claude Chat helper and agent-facing docs.
- `shared/` (`@copilot/shared`): types, zod schemas, timeout policy and protocol contracts used by both. Imported directly as TypeScript (`@copilot/shared/types/...`) and bundled into each consumer.
- `scripts/`: dependency switching and release tooling. `installer/`: Windows `ClaudeChatSetup.exe` builder.

Requires Node `^20.19.0 || >=22.12.0`.

## Commands

All from the repo root.

```sh
npm run dev                      # Vite dev server for extension/web
npm run build                    # build + package extension -> build/dist/easyeda-copilot_v<VERSION>.eext (does not build MCP)
npm run eslint                   # lint extension/src and extension/web
npm run test:extension           # all extension/tests/*.test.ts (node:test via tsx)

npm run build --workspace=mcp    # tsup -> mcp/dist (also runs scripts/build-local-dependencies.mjs first)
npm run check --workspace=mcp    # full MCP gate: build, typecheck, docs link check, all tests/check scripts
npm run typecheck --workspace=mcp
npm run inspect --workspace=mcp  # build and open MCP Inspector

npm run build:installer          # Windows only: build MCP then build/dist/ClaudeChatSetup.exe
npm run check:release            # version consistency, no local deps, platform binaries present
```

Single tests:

```sh
node --import tsx --test extension/tests/checkpointer.test.ts
node --import tsx --test mcp/tests/tool-handler.test.ts
node --test mcp/tests/spice.test.mjs
node mcp/scripts/check-execute-js.mjs     # most mcp/scripts/check-*.mjs need `npm run build --workspace=mcp` first
```

Use real filenames, not globs: Node 20 on Windows does not expand `--test` globs (see `extension/build/test.mjs`).

Run the local MCP build with `node mcp/dist/index.js` (`npx easyeda-copilot-mcp` runs the published upstream package, not this checkout). Run the Claude Chat helper in the foreground with `node mcp/dist/index.js chat` (`chat --install` / `--uninstall` for autostart).

SPICE tests skip unless `SPICE_TEST_NGSPICE` points to an ngspice executable; set `SPICE_TEST_REQUIRED=1` to make them fail instead.

## Architecture

```text
Claude Chat iframe (extension/web/src/claude) --ws 127.0.0.1:8788--> chat helper (mcp/src/chat) --stdio--> claude -p (stream-json)
                                                                           |                                   |
MCP client (Claude Code/Codex) --stdio--> MCP server (mcp/src/server.ts) <-+-----------------------------------+
                                                 |
                                   ws 127.0.0.1:8787 bridge (mcp/src/bridge)
                                                 |
                       extension/src/mcp-client.ts (runs inside EasyEDA) --> eda.* Pro API --> open document
```

- **MCP server is the WebSocket server; the extension is the client.** The extension scans for `ws://127.0.0.1:8787` every few seconds (`extension/src/mcp-client.ts`). Several EasyEDA windows can connect; the bridge tracks instances and the selected target. A second MCP process can attach to an existing bridge as a proxy (broker mode) instead of failing on the port.
- **Request/response protocol**: the MCP side calls `bridge.requestEasyEda(event, body)`. The extension dispatches on `message.event` in a long `if` chain in `mcp-client.ts` (`get-schematic`, `assemble-circuit`, `apply-routing-result`, `checkpoint-restore`, ...) through a bounded `McpCommandQueue` with per-command timeouts. Adding a capability usually means: a tool in `mcp/src/tools/*`, a new event handler in `mcp-client.ts`, editor logic in `extension/src/eda/*`, and shared types in `shared/types/*`. Timeouts for both sides come from `shared/timeout-policy.ts`.
- **Tool registration**: `mcp/src/server.ts` calls `register*Tools(server, bridge)` per area. Wrap handlers with the helpers in `mcp/src/tools/handler.ts`: `toolHandler` (abort signal + version-mismatch warning), `targetedToolHandler` (pins the call to the EasyEDA instance/document chosen at invocation), `managedMutationHandler` (runs a document mutation through the Operation Manager in `mcp/src/operations/`, which handles long-running operations, cancellation and resumable results).
- **Heavy computation is in external packages**, not this repo: component resolution and PCB placement in `eda-copilot-backend` (N-API + Rust), routing in `eda-copilot-router`. They stay external in the tsup bundle so their assets resolve after install. To co-develop them, clone them as siblings and run `npm run deps:local`. Run `npm run deps:release` before committing so `mcp/package.json` and the lockfile pin registry versions (`npm run deps:status` shows the current mode; paths and versions are in `scripts/dependency-config.json`). Restart the MCP process after rebuilding them.
- **Checkpoints**: every document-mutating flow saves the full EasyEDA document source first and restores it on failure (`extension/src/eda/checkpointer.ts`, `checkpoint-store.ts`, `checkpoint-scopes.ts`). Keep this guarantee when adding mutating commands.
- **Agent docs are product code.** `mcp/docs/` ships in the npm package and is what agents read at runtime (`SKILL.md` is the entry point and routes to per-stage guides and the `dsl.ts` files for placement/routing). `npm run test:docs --workspace=mcp` fails on broken relative links and on `SKILL.md` files missing frontmatter. `mcp/docs/execution/easyeda-api/` is generated by `npm run docs:update-api --workspace=mcp`; don't hand-edit it.
- **Extension packaging**: `extension/build.mjs` builds each Vue page (`web/index.html`, `graph.html`, `reused.html`, `claude.html`) as a single-file bundle into `extension/iframe/`. esbuild bundles `src/index.ts` into `extension/dist/`, and `build/packaged.ts` zips the `.eext`. Functions exported from `extension/src/index.ts` are bound to menu items by name in `extension/extension.json` (`headerMenus`).
- **Legacy built-in UI**: the original Copilot chat in `extension/web` (`App.vue`, settings and completions) talks to hosted services selected by `shared/mode.ts` (`__MODE__ = 'PROD'`). The MCP path does not use it.

## Conventions

- Keep versions in sync across root `package.json`, `extension/package.json`, `extension/extension.json` and `mcp/package.json` (plus `mcp/server.json`). `check:release` enforces this.
- Pushing a `v*` tag starts the CI publish pipeline (npm + MCP Registry). Don't create or push tags unless asked. See `docs/releasing.md`.
- Some docs and code comments are in Russian or Chinese (upstream origin). `docs/local-development.md` covers env vars for PCB worker and thread tuning (`PCB_LAYOUT_SUBTREE_WORKERS`, `PCB_BOARD_PACKER_THREADS`, ...). `docs/claude-chat.md` covers the chat helper's env vars and origin checks.
