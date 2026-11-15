# Cache Meter

Prompt cache, usage limits and your account at a glance in Claude Code, in the terminal and in the desktop app. A band above the prompt and a status line, each with the fields you choose; the full breakdown one click away.

```
● Cache Warm 42m left  │  Next $0.06  │  If Cold $2.41  │  Context 301k 30%  │  Hit Rate 96%  │  Weekly 88% 2d 4h  │  Session $3.50    Details
[A] name@example.com · Opus 5.5 · medium · 5h 34% (14:40) · 7d 55% (Mon 03:00) · ctx 31%
```

## Install

Private repo: your GitHub account needs access to it. From a shell:

```
claude plugin marketplace add iameryksadowski/cachemeter-plugin-claude-code
claude plugin install cache-meter@cachemeter --scope user
```

Or at the prompt of a Claude Code session: `/plugin marketplace add iameryksadowski/cachemeter-plugin-claude-code`, then `/plugin install cache-meter@cachemeter`. Update later with `claude plugin marketplace update cachemeter`.

## What it shows

- **Cache state**: warm with time left, a warning color in the last 10 minutes (last minute on a 5m TTL), cold with idle time.
- **Next message**: what re-sending the context costs while warm (cache read) and once cold (cache write).
- **Context**: tokens the next request re-sends and the share of the model's window.
- **Usage limits**: percent used and time to reset for each limit your plan has (Weekly, and 5-Hour where the plan reports one); warning at 80%, error at 95%.
- **Hit rate and session cost**: share of input served from cache on the main thread, and the engine's session total.

Parts drop out strictly by priority as the window narrows: the cache state stays always, then your main usage limit, then the next message cost and the context. `Details` (or `/cache`) opens a side pane with the full breakdown: TTL bar, read and write rates, cold/warm ratio, tokens read, written and uncached, what caching saved, cold writes paid, the last request and every usage limit.

## Status line

One line with the fields you pick, in the order you pick: by default the account, its e-mail, the model with its version, the effort, the 5-hour and weekly limits with their reset, and the context share. It is drawn in two ways, both from the same fields:

| Where | How it is drawn |
| --- | --- |
| Desktop app (Code tab) | Pinned under the prompt by the plugin (`statusLine: auto`). The desktop app does not run a `statusLine` command. |
| Terminal | The account's `statusLine` command runs the plugin's script, which prints the line the plugin wrote for that session. Without that script, the plugin pins the line under the prompt there too. |

The terminal script, in each account's `settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "bash \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/cachemeter/bin/statusline.sh\""
}
```

Before the plugin has written a session's line (its first moment, or with the plugin off) the script prints a short line from the status line JSON: account, model, limits, context. The script sends nothing anywhere.

## Fields

The band and the status line take the same fields. The band keeps them strictly by priority as the window narrows (the cache state longest, then the plan's main limit); the status line shows all of them.

| Field | Shows |
| --- | --- |
| `account` | Account name: a letter from the config folder (`~/.claude` is A, `~/.claude-b` is B) or your own label (`accountLabels`) |
| `email` | E-mail of the signed-in account, from the account's login record. Shown only, never sent |
| `model` | Model with its version (Opus 5.5) |
| `effort` | Reasoning effort |
| `mode` | Permission mode (default, accept edits, plan, auto, bypass), as of the last prompt or turn |
| `style` | Output style, when it is not the default |
| `dir`, `branch` | Working folder and git branch |
| `cache` | Prompt cache warm or cold, time left or idle time |
| `next`, `ifcold` | What the next message costs now, and once the cache is cold |
| `context` | Context tokens and share of the window |
| `hit` | Cache hit rate of the session |
| `5h`, `7d`, `spend` | Usage limits with their reset, each only where your plan reports it |
| `session` | What the session has cost (API list prices) |

Aliases work too: `weekly`, `ctx`, `cold`, `cost`, `limits` (all three limits), `cwd`, `git`.

Change them for this account (every session after, over the plugin settings):

```
/cache line                      the line now, and its fields
/cache line hide email effort
/cache line show branch mode
/cache line set account model 7d context
/cache line reset                back to the plugin settings
/cache line on | off | auto      pin it under the prompt always, never, or where no terminal script draws it
/cache band show account model   the same for the band
/cache fields                    every field and both lists
```

Or in `/plugin configure cache-meter@cachemeter` (and `/config`): `bandFields`, `lineFields`, `statusLine`, `resetStyle`, `accountLabels`.

What Claude Code does not hand a plugin, the plugin does not show: fast mode has no reading for plugins yet.

## Alfred

With `alfred` set to `on`, the plugin sends the session's usage reading to the local Alfred engine (`POST http://127.0.0.1:8765/api/konta/uzycie`, its local token from `alfred-app/data/api.token`) at most once a minute per session: the config folder, the session id, each usage window (percent used and reset), the context window and the model id. Never the e-mail, never a credential, never anything said in the session. It works in the desktop app and in the terminal alike, and a down engine never holds anything up; the pane says when the last reading went. `alfredHome` and `alfredUrl` (or `ALFRED_URL`) point it elsewhere; `ALFRED_API_TOKEN` adds a bearer token.

## Honest by design

- A model switch makes the cache cold at once (the engine says so), and the next message is priced on the new model.
- A model the price table does not know shows no prices at all, never a guess from a neighbouring model.
- The TTL is the one the engine reports when it reports one; the `ttl` setting wins when set by hand.
- A usage limit past its reset time says "Just reset" until the next reply brings the new figure.
- After a restart the last known limits stay until the API reports new ones, so a subscription keeps its 1h TTL and its prices.
- The hit rate rounds down, so it never shows 100% unless every token was read from cache.
- Not visible to the meter: a side chat or another tool that reads the same cache. Then the real cache can be warmer than shown, never colder.

## Keep Warm

Off by default. Switch it on for every repo, for one repo or for one session (see [On, off and where](#on-off-and-where)).

Shortly before the cache would expire (5 minutes on a 1h TTL, 45 seconds on 5m), it forks one tool-less question over the session's own transcript on the same model and system prompt. The API serves that prefix from the cache, the read starts the TTL over, and nothing is added to the conversation. Each ping costs one cache read of the context (about $0.03 for 150k tokens on Opus 5.5) instead of a full re-write later (about $1.20). It stops `keepWarmFor` after your last message, and switches itself off if a ping ever finds the cache already gone.

## Cold send guard

When the cache has gone cold and the context is over 50k tokens, the first message you send is held once with its re-cache price. Send it again to go ahead, or `/clear` and start from a summary. Slash commands and prompts nobody typed (task notifications, scheduled prompts, other sessions) are never held.

Off by default. Switch it on for every repo, for one repo or for one session (see below). Switched on over a `warn` setting it keeps only warning; over `off` it holds.

## On, off and where

Keep Warm and the cold send guard are each set at three levels. The closer one wins: this session, then this repo, then the plugin settings.

| Level | How | Lasts |
| --- | --- | --- |
| Every repo | `/plugin configure cache-meter@cachemeter` (or `/config`): `guard`, `keepWarm` | Until you change it |
| This repo | `/cache guard repo on`, `off` or `reset`; `/cache warm repo on`, `off` or `reset`; or "Keep On Here" / "Follow Settings" in the pane | Every new session in this repo and its worktrees |
| This session | `/cache guard on` or `off`, `/cache warm on` or `off`, or the Turn On / Turn Off button in the pane | Until the session ends |

The pane shows for each which level set it. Claude Code reads plugin settings from your user settings only (a repo's `.claude/settings.json` cannot set them), so the plugin keeps each repo's choice in its own store under your Claude Code configuration, keyed by the repo's folder.

## Settings

All are in `/plugin configure cache-meter@cachemeter` and `/config` (stored as `pluginConfigs` in your user settings, so each account keeps its own):

| Field | Values | Default |
| --- | --- | --- |
| `ttl` | `auto`, `1h`, `5m` | `auto`: 1h on a subscription, 5m on an API key |
| `guard` | `off`, `confirm`, `warn` | `off` |
| `keepWarm` | `off`, `on` | `off` |
| `keepWarmFor` | `1h`, `2h`, `4h`, `8h` | `2h` after your last message |
| `bandFields` | fields, in order | `cache, next, ifcold, context, hit, 5h, 7d, spend, session` |
| `lineFields` | fields, in order | `account, email, model, effort, 5h, 7d, context` |
| `statusLine` | `auto`, `on`, `off` | `auto`: pinned wherever no terminal script draws it |
| `resetStyle` | `auto`, `countdown`, `clock`, `both` | `auto`: a countdown in the band, the clock in the status line |
| `accountLabels` | `.claude=A, .claude-b=Work` | a letter from the folder |
| `alfred` | `off`, `on` | `off` |
| `alfredHome` | a folder | `~/Development/alfred-app` |
| `alfredUrl` | a URL | `http://127.0.0.1:8765` |

`ttl`, `guard` and `keepWarm` are the default for every repo (see [On, off and where](#on-off-and-where)); the fields are per account, and `/cache band|line ...` keeps a choice over them.

## Good to know

- With Keep Warm off it never calls a model and costs nothing to run: it reads the engine's own figures and the API's usage counts.
- Each account (config folder) reads its own login record, limits and settings, so the line never shows another account's figures.
- Dollar figures are API list prices from `hooks/cache.ts`. On a subscription they show how heavy a message is against your limits, not a bill.
- Only the main thread resets the cache clock; subagents have their own caches.
- Built on Claude Code mods (2.1.287 or later). The mod API is in early access: after a Claude Code update, run the checks below.

## Develop

```
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```

Loading the folder once writes the API types to `.claude-plugin/types/` (ignored by git), so `tsc -p .` type-checks the mod.

## License

Private. [MIT](LICENSE) text kept for a possible public release.

---

Eryk Sadowski · eryksadowski.com
