# AGENTS.md

Guidance for coding agents working on **Pixel Quota Left**, a VS Code extension that draws one pixel-art tree per AI coding plan (Claude, Codex). Leaves on the tree = % of quota left. See [README.md](README.md) for the user-facing behaviour.

## Commands

```sh
npm install          # dev deps only: typescript, @types/node, @types/vscode
npm run compile      # tsc -p ./  → out/
npm run watch        # incremental compile
npm run package      # builds pixel-quota-left-<version>.vsix via @vscode/vsce
```

- There is **no test suite and no linter**. `npm run compile` passing (strict TypeScript) is the minimum check before finishing a change.
- To run it: F5 in VS Code ("Run Extension" in [.vscode/launch.json](.vscode/launch.json)), then open the **Quota Left** activity-bar icon.
- `out/` and `*.vsix` are build output (gitignored). Never edit files in `out/`.

## Layout

| Path | Role |
|---|---|
| [src/extension.ts](src/extension.ts) | Activation. `PlanService` (polling, refresh de-dup, config), `toView` (picks the binding limit → `leftPercent`), `PlansViewProvider` (webview HTML + CSP), status-bar item, commands. |
| [src/providers/types.ts](src/providers/types.ts) | Shared types (`Limit`, `PlanStatus`, `PlanProvider`) and helpers (`getJson` with 15 s timeout, `clampPct`, `windowLabel`, `cap`). |
| [src/providers/claude.ts](src/providers/claude.ts) | Reads Claude Code OAuth token (`.credentials.json`, macOS keychain fallback), calls `api.anthropic.com/api/oauth/usage`. Handles both the `limits[]` and the legacy `five_hour`/`seven_day` response shapes. |
| [src/providers/codex.ts](src/providers/codex.ts) | Reads `~/.codex/auth.json`, calls `chatgpt.com/backend-api/wham/usage`; on failure falls back to the newest `token_count` snapshot in `sessions/YYYY/MM/DD/rollout-*.jsonl` (state `stale`). |
| [media/plans.js](media/plans.js) | Webview renderer: plain browser JS (checked via `// @ts-check`), canvas pixel art, animation loop, limit bars. Not compiled by `tsc`. |
| [media/plans.css](media/plans.css) | Webview styles; use `--vscode-*` theme variables. |
| [package.json](package.json) | Contribution points: view container, webview view `quotaLeft.view`, commands, `quotaLeft.*` settings. |

## Data flow

1. `PlanService.refresh()` calls `fetch()` on each enabled provider in parallel (throws are turned into an `error` `PlanStatus`).
2. A provider returns `undefined` when its CLI isn't installed or logged in (or Codex uses an API key) — that hides the tree entirely. Return an `error`/`stale` status instead when the user *should* see a problem.
3. `toView` chooses the binding limit: the most-used **unscoped** limit (scoped = model/feature-specific, e.g. "Weekly · Opus"). `leftPercent = 100 - usedPercent`.
4. Results go to the webview via `postMessage({ type: 'update', plans })` and to the status-bar tooltip. The webview sends `ready` and `refresh` messages back.

## Rules that must hold

- **Tokens go only to the provider that issued them.** Claude token → `api.anthropic.com` only; Codex token → `chatgpt.com` only. No telemetry, no other network calls.
- **Never refresh or write tokens.** Refreshing would rotate the CLI's login. On expiry/401/403, show a message telling the user to run the CLI once.
- Both usage endpoints are **undocumented**. Parse defensively: check types, `clampPct` every percentage, tolerate missing fields, keep old response shapes working.
- Keep the webview CSP strict (`default-src 'none'`, nonce'd script, styles from `cspSource`). No inline scripts/styles, no remote resources; assets must live in `media/`.
- Rendering in `plans.js` is deterministic per plan (seeded `mulberry`/`hash`) so trees don't change shape between refreshes — keep new randomness seeded.
- No runtime dependencies. Use Node built-ins and global `fetch` (VS Code ≥ 1.85 / Node 18+).
- Minimum refresh interval is 30 s; don't add code paths that poll faster.

## Common changes

- **New provider:** implement `PlanProvider` in `src/providers/<name>.ts`, register it in `PlanService.providers` in [extension.ts](src/extension.ts), add `quotaLeft.<name>.enabled` (and any path override) to `contributes.configuration` in [package.json](package.json), add a palette entry in `PALETTES` in [media/plans.js](media/plans.js) (keyed by provider `id`), and document the endpoint + credential in the README table.
- **New setting:** declare it in `package.json` under `quotaLeft.*`; read it via `cfg()`. Config changes already trigger a refresh.
- **Visual tweaks:** all in `media/`; reload the webview (close/reopen the view or restart the Extension Host) — no compile needed.

## Style

- TypeScript `strict`, CommonJS, ES2022. Two-space indent, single quotes, semicolons, ~130-col lines (match existing code).
- Keep files small and dependency-free; prefer a short doc comment explaining *why* over many comments explaining *what*.
- Update [README.md](README.md) when behaviour, settings, or data sources change.
