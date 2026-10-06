# CLAUDE.md — glance

glance is a Claude Code mod: a plugin whose behavior is one hooks module (`hooks/register.ts`) that draws one line
in the band above the prompt. The repository root is both the plugin and its marketplace
(`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` with `source: "./"`).

> Personal/machine-local overrides live in `CLAUDE.local.md` (gitignored). Don't put shared guidance there.

## Layout

| Path | Content |
| --- | --- |
| `hooks/register.ts` | The whole mod: event hooks, state, segment builders, the VS Code status-line fallback |
| `types/index.d.ts` | The `$.state` contract (`interface PluginState` under `glance`); every key the module reads or writes is declared here |
| `tests/register.test.ts` | `claude plugin test` suite, run on the `terminal` and `desktop` surfaces plus the `vscode` fallback |
| `.claude-plugin/types/` | Written by Claude Code on every load (gitignored); the API reference to grep (`'tool.call'`, `AbovePrompt: {`) |

## Verify

Run all three before calling a change done:

```bash
claude plugin validate .
claude plugin test .
tsc -p .
```

`tsc -p .` needs `.claude-plugin/types/`, which exists only after Claude Code has loaded the mod once (any of the
preview paths below).

## Preview a change live

- Terminal: `claude --plugin-dir .` from this folder. The folder is watched, so a save reloads the mod in place.
- The installed copy (`glance@glance`) is also named `glance`. Disable it while previewing so only the working copy
  draws: `claude plugin disable glance@glance`, and `claude plugin enable glance@glance` afterwards.
- The VS Code / Cursor extension panel attaches no drawing surface (`$.session.surfaces()` returns `[]`, verified on
  extension 2.1.290), so nothing there can show the mod. Use the editor's integrated terminal.

## Release

1. Bump `version` in `.claude-plugin/plugin.json` (semver). `/plugin update` compares this field.
2. Commit with explicit paths, message `type: 한글 설명` on one line, no AI attribution.
3. `git push origin main`. This folder's git identity and SSH remote come from the `~/Documents/toy` config (Kir93).
4. Refresh the installed copy, then start a new session:

```bash
claude plugin marketplace update glance
claude plugin update glance@glance
```

Commit, push and anything else public wait for an explicit request.

## Rules

- Don't copy code, wording, layout or thresholds from claude-hud or other HUD projects. Instead, design features
  independently. The README presents glance as an original work.
- Don't let the HUD affect a tool call. Instead, await nothing before `next(e)` in `tool.call` and route the mod's
  own failures to `.catch`. It never denies or rewrites a call.
- Don't add network calls or file writes. Instead, read from `$.session`, `$.agent` and read-only `git` through
  `$.process.run`; the README promises this.
- Don't draw a tree a surface may refuse. Instead, cover every new element or color in the test on both `terminal`
  and `desktop`; a refused tree only shows up in the debug log.
- Don't move the prompt. Instead, keep the HUD to exactly one line: append live segments only while they apply, and
  when the line is too wide shed details in `SHED` order before dropping whole segments.
