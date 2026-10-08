# glance

Two lines above the Claude Code prompt, for the things you would otherwise stop and check:

```
◔ 38% 124K left · ◑ 5h 41% ▲1:40 ↻2:15 · ◔ 7d 20% ↻3d
⎇ main ±3 ↑2 +120−30 · ▸ Edit register.ts #6 ✗2 · ⧗ codex review 6m · ☐ 2/5 Fix auth bug
```

The first line is Claude's budget: the context window and the limits, or, with no limit to show, what the session
has cost. While idle, the last turn's API error and a cooling prompt cache join it. The second line is the work: the
repository first, then what is happening right now. Each line starts with what is always there, so it stays put while the rest comes and goes.

| Segment | Shows |
| --- | --- |
| `◔ 38% 124K left` | How full the context window is, and how many tokens are left. Yellow from 60%, red from 80%. |
| `◑ 5h 41% ↻2:15` · `◔ 7d 20% ↻3d` | The 5-hour and 7-day subscription limits, each with the time until it resets. Yellow from 70%, red from 90%. |
| `◕ spend 75% ↻1d` | Behind a Claude gateway: its spend limit, with the time until it resets. Colored as the limits above. |
| `$1.50` | With no limit to show, as on an API key: what the session has cost so far, as `/cost` counts it. |
| `▲1:40` | Inside a limit, in red: how long it lasts at the pace of the last half hour. Shown only when it would run out before it resets. |
| `⎇ main ±3` | The current branch and the number of changed files, or `✓` when clean. |
| `↑2` | Inside git: commits that are on no remote yet. Left out when the repository has no remote. |
| `+120−30` | Inside git: lines added and removed in tracked files since the last commit. |
| `✗ overloaded` | While idle, in red: the API error that ended the last turn, until the next turn starts. |
| `cache 4m` | While idle, in yellow, once the prompt cache has under ten minutes left (counted an hour from the end of the last turn); then `cache cold` in red. With more time left it does not show. |
| `▸ Edit register.ts #6` | While Claude works: the tool running now and the number of tool calls this turn. |
| `✗2` | Beside the running tool, in red: the tool calls this turn that failed or were denied. |
| `◇ Explore 45s` | While subagents run: the agent type (or a count when several), and how long the oldest has been at it. |
| `⧉ review-changes ×3 4m` | While a workflow runs: its name (or a count when several), how many of its agents are at work, and how long since the first started. |
| `⧗ codex review 6m` | While background shells or monitors run: what (or a count when several), and how long the oldest has been running. |
| `☐ 2/5 Fix auth bug` | While a todo list or task list has unfinished items: progress and the item in progress. |

| Symbol | Means |
| --- | --- |
| `○` `◔` `◑` `◕` `●` | A gauge filling in fifths: the context window first, then the 5-hour and 7-day limits. |
| `↻` | Time until a limit resets. |
| `$` | What the session has cost, in US dollars. |
| `▲` | Time until a limit runs out at the current pace, shown only when that comes before the reset. |
| `⎇` | The git branch. |
| `±` / `✓` | Changed files / a clean working tree. |
| `↑` | Commits not pushed to any remote. |
| `+` `−` | Lines added and removed since the last commit. |
| `cache` | The prompt cache is about to expire (yellow) or has expired (red). |
| `✗` | Alone: the API error that ended the last turn. After the running tool: the tool calls this turn that failed or were denied. |
| `▸` `#` | The tool running now, and how many tool calls this turn has made. |
| `◇` | Subagents at work. |
| `⧉` `×` | A workflow, and how many of its agents are at work. |
| `⧗` | Background shells and monitors. |
| `☐` | A todo or task list with items left. |
| `…` | Text clipped to fit its line. |

Every gauge is the same circle, filling in fifths, beside the exact number. There are always two lines, so the prompt
does not jump when a turn starts or ends. Each line fits its own width. A todo, a background task, a workflow or a
command shows whole while there is room, and is clipped with `…` before anything else gives way. When a line is still
too wide, details go first: on the first line the reset times, tokens left, then the cache; on the second the changed
lines, the change count, the todo text, the background label (a count takes its place), then git with its unpushed
count, then whole segments from the right. Context, the limits with their pace warning (or the cost), an API error,
and the running tool with its failed calls always stay. If even those do not fit, the line is cut at the edge and ends
in `…`.

glance is a Claude Code **mod**: a plugin whose behavior is a hooks module running inside the session. It reads the
session's own figures (`$.session.usage()`) and lists the session's running agents. It watches tool calls as they
pass, without holding them up, for the background work, workflows and todos they start or end. At the end of a
turn, the `classic.Stop` hook input names the background work still in flight, and `classic.StopFailure` names the
API error that ended it. When files may have changed it runs read-only `git` commands: `status --porcelain`,
`for-each-ref --count=1 refs/remotes`, `rev-list --count HEAD --not --remotes` and `diff --shortstat HEAD`. Nothing
in the session reports how long the prompt cache lives, so glance takes it to be an hour; where it lives five
minutes, the countdown runs long. glance draws through the band above the prompt. It makes no network calls, writes
no files, and never blocks or changes a tool call.

## Requirements

- Claude Code **2.1.291** or later, on an account where mods are enabled.
- The 5-hour / 7-day segment needs a Claude subscription. With an API key there is no limit to show, and the
  session's cost shows in its place.

## Install

```text
/plugin marketplace add Kir93/glance
/plugin install glance@glance
/reload-plugins
```

The lines appear after the next turn. If they do not, restart Claude Code.

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
| VS Code / Cursor extension panel | Not yet: the extension does not attach a drawing surface for mods. Run `claude` in the editor's integrated terminal instead. glance already pins its two lines, joined into one, as the status line when a `vscode` surface attaches, so nothing needs to change once the extension supports it. |

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
