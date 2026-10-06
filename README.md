# glance

One line above the Claude Code prompt, for the things you would otherwise stop and check:

```
idle     ◔ 38% 124K left · ◑ 5h 41% ↻2:15 · ◔ 7d 20% ↻3d · ⎇ main ±3
working  ◔ 38% · ◑ 5h 41% · ◔ 7d 20% · ⎇ main ±3 · ▸ Edit register.ts #6 · ◇ Explore 45s · ☐ 2/5 Fix auth bug
```

State that is always true comes first. What is happening right now is appended only while it is happening.

| Segment | Shows |
| --- | --- |
| `◔ 38% 124K left` | How full the context window is, and how many tokens are left. Yellow from 60%, red from 80%. |
| `◑ 5h 41% ↻2:15` · `◔ 7d 20% ↻3d` | The 5-hour and 7-day subscription limits, each with the time until it resets. Yellow from 70%, red from 90%. |
| `⎇ main ±3` | The current branch and the number of changed files, or `✓` when clean. |
| `▸ Edit register.ts #6` | While Claude works: the tool running now and the number of tool calls this turn. |
| `◇ Explore 45s` | While subagents run: the agent type (or a count when several), and how long the oldest has been at it. |
| `☐ 2/5 Fix auth bug` | While a todo list or task list has unfinished items: progress and the item in progress. |

Every gauge is the same circle, filling in fifths, beside the exact number. The line never grows to two, so the
prompt does not jump when a turn starts or ends. When the line is too wide, details go first — reset times, tokens
left, the change count, the todo text, then git — and context, the limits and the running tool always stay.

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

The line appears after the next turn. If it does not, restart Claude Code.

To stay current, turn on auto-update for the marketplace: `/plugin` → Marketplaces → `glance` → auto-update.
The Claude desktop app has no auto-update toggle; it shares `~/.claude/settings.json` with the
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
| VS Code / Cursor extension panel | Not yet: the extension does not attach a drawing surface for mods. Run `claude` in the editor's integrated terminal instead. glance already pins its line as the status line when a `vscode` surface attaches, so nothing needs to change once the extension supports it. |

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
