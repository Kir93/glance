# glance

Two lines above the Claude Code prompt, for the things you would otherwise stop and check:

```
◔ 38%  124K left  ·  ◑ 5h 41%  ↻2:15  ·  ◔ 7d 20%  ↻3d  ·  ⎇ main ±3
▸ Edit register.ts  #6  ·  ◇ 2 agents 3m  ·  ☐ 2/5 Fix auth bug
```

The first line is state that is always true. The second is what is happening right now.

| Segment | Shows |
| --- | --- |
| `◔ 38%  124K left` | How full the context window is, and how many tokens are left. Yellow from 60%, red from 80%. |
| `◑ 5h 41%  ↻2:15` · `◔ 7d 20%  ↻3d` | The 5-hour and 7-day subscription limits, each with the time until it resets. Yellow from 70%, red from 90%. |
| `⎇ main ±3` | The current branch and the number of changed files, or `✓` when clean. |
| `▸ Edit register.ts  #6` | While Claude works: the tool running now and the number of tool calls this turn. When idle: how many calls the last turn made. |
| `◇ 2 agents 3m` | Subagents still running, and how long the oldest has been at it. One agent shows its type instead of a count. |
| `☐ 2/5 Fix auth bug` | Progress through Claude's todo list or tasks, and the item in progress. |

Every gauge is the same circle, filling in fifths, beside the exact number. Both lines always draw, so the prompt does
not jump when a turn starts or ends; with nothing going on, the second line reads `ready`. When the band is narrow,
segments drop from the right of each line.

glance is a Claude Code **mod**: a plugin whose behavior is a hooks module running inside the session. It reads the
session's own figures (`$.session.usage()`), lists the session's running agents, runs a couple of read-only `git`
commands when files may have changed, and draws through the band above the prompt. It makes no network calls, writes no files, and never blocks or changes a tool call.

## Requirements

- Claude Code **2.1.287** or later, on an account where mods are enabled.
- The 5-hour / 7-day segment needs a Claude subscription. With an API key there is no limit to show, and the segment is
  left out.

## Install

```text
/plugin marketplace add Kir93/glance
/plugin install glance@glance
/reload-plugins
```

The lines appear after the next turn. If they do not, restart Claude Code.

To stay current, turn on auto-update for the marketplace: `/plugin` → Marketplaces → `glance` → auto-update. Without
it, update by hand. The Claude desktop app has no auto-update toggle; it shares `~/.claude/settings.json` with the
CLI, so set it there instead:

```json
"extraKnownMarketplaces": {
  "glance": { "source": { "source": "github", "repo": "Kir93/glance" }, "autoUpdate": true }
}
```

To update by hand:

```text
/plugin marketplace update glance
/plugin update glance@glance
```

glance itself makes no network calls, update checks included.

## Where it shows

| Surface | Status |
| --- | --- |
| Terminal (`claude`) | Supported |
| Claude desktop app, Code tab | Supported |
| VS Code / Cursor extension panel | Not yet: the extension does not attach a drawing surface for mods. Run `claude` in the editor's integrated terminal instead. glance already pins both lines, joined, as the status line when a `vscode` surface attaches, so nothing needs to change once the extension supports it. |

## Develop

```text
claude --plugin-dir ./
claude plugin validate .
claude plugin test .
```

Claude Code writes the API's type declarations into `.claude-plugin/types/` each time it loads the mod, and
`tsconfig.json` extends them, so `tsc -p .` type-checks the module after the first load.

## License

MIT
