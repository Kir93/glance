# glance

One line above the Claude Code prompt, for the things you would otherwise stop and check:

```
◔ 38%  124K left  ·  5h 41%  ↻2:15  ·  ▸ Edit register.ts  #6  ·  ⎇ main ±3
```

| Segment | Shows |
| --- | --- |
| `◔ 38%  124K left` | How full the context window is, and how many tokens are left. Yellow from 60%, red from 80%. |
| `5h 41%  ↻2:15` | Whichever subscription limit, 5-hour or 7-day, is closer to its cap, and the time until it resets. Yellow from 70%, red from 90%. |
| `▸ Edit register.ts  #6` | While Claude works: the tool running now and the number of tool calls this turn. When idle: how many calls the last turn made. |
| `⎇ main ±3` | The current branch and the number of changed files, or `✓` when clean. |

When the band is narrow, git goes first, then activity. Context and the limit stay.

glance is a Claude Code **mod**: a plugin whose behavior is a hooks module running inside the session. It reads the
session's own figures (`$.session.usage()`), runs a couple of read-only `git` commands when files may have changed, and draws through
the band above the prompt. It makes no network calls, writes no files, and never blocks or changes a tool call.

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
