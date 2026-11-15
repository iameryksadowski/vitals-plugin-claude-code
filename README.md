# Cache Meter

Everything about the session Claude Code does not show on its own, in one row above the prompt, in the terminal and in the desktop app: the prompt cache, what the next message costs, the account and its usage limit, the context and when to compact. The rest is one click away in a side pane.

```
● Warm 42m  │  Next $0.06  │  A  │  Weekly 5% 6d 15h  │  Context 301k 30%                         Details
A · Opus 5.5 · medium · ● Warm 42m · next $0.06 · 7d 5% 6d 15h · ctx 30% · main
```

The first line is the band above the prompt. The second is the terminal status line, which also carries what the terminal footer lacks (model, effort, branch). Nothing Claude Code already shows (the desktop footer has the model, effort and permission mode) is repeated by default.

## What it shows

- **Cache state**: warm with time left, a warning color in the last 10 minutes (last minute on a 5m TTL), cold with idle time. After a compaction, or a session that comes back after a restart, it knows the cache is cold.
- **Next message**: what re-sending the context costs while warm (cache read) and once cold (cache write). In the last minutes it also says what waiting longer would cost.
- **Account and usage limits**: which account (config folder) the session runs on, and percent used with the time to reset for each limit your plan reports (an Ultra plan reports only the weekly one); warning at 80%, error at 95%. Resets read as `6d 15h`, within a day as `14h 20m`.
- **Context and compaction**: the share of the window, when auto-compact runs, and a hint when compacting is worth it.
- **Hit rate and session cost**: share of input served from cache on the main thread, and the engine's session total.

Parts drop out strictly by priority as the window narrows: the cache state stays always, then the account and its main limit, then the next message cost, the compact hint and the context.

## The pane

`Details`, or `/cache`, opens a side pane with five tabs. `/cache now`, `/cache context`, `/cache cost`, `/cache timeline` and `/cache settings` open it on that tab.

| Tab | Shows |
| --- | --- |
| Now | Account (e-mail, model, effort, mode, output style, folder and branch), the prompt cache with its TTL bar, what the next message costs warm and cold, every usage limit |
| Context | How full the context is, auto-compact (on or off, and at what share) with a switch, the compact advice and **Compact Now**, what fills the context (as `/context` counts it, estimated locally) and the heaviest MCP servers |
| Cost | Requests, cache hit rate, tokens read, written and uncached, what caching saved, cold writes paid, the last request, the session total |
| Timeline | When each message went and how long each reply took, with its tool count, and the breaks after which the cache went cold. Claude Code does not show these times |
| Settings | The status line and where it is drawn, Keep Warm, the cold send guard, the compact hint, the Alfred send |

## Compaction

Compacting costs about one pass over the context. It is cheapest at a break you choose:

- **The cache has gone cold and the context is large** (over `compactAt`, 50% by default): the next message pays that pass anyway, so compacting first costs about the same and every message after it is smaller.
- **Auto-compact is near** (within 10 points of its threshold): better now, at a natural break, than when it cuts in mid-task.
- **Auto-compact is off** and the context is over 80%.

Then the band shows `Compact` with the reason. `/cache compact` (or Compact Now in the pane) compacts, the same as `/compact`. `/cache autocompact on|off` (or the switch in the pane) switches Claude Code's own auto-compact, the same row as in `/config`. `compactHint: off` hides the hint.

## Status line

One line with the fields you pick, in the order you pick: by default the account, the model with its version, the effort, the cache, the next message cost, the 5-hour and weekly limits with their reset, the context share, the compact hint and the branch.

| Where | How it is drawn |
| --- | --- |
| Terminal | The account's `statusLine` command runs the plugin's script, which prints the line the plugin wrote for that session (`statusLine: auto`). |
| Desktop app (Code tab) | Not drawn by default: the desktop app does not run a `statusLine` command, the band shows the same and the footer already has the model and effort. `statusLine: on` (or `/cache line on`) pins it under the prompt there too. |

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
| `compact` | A hint to compact, with the reason, only when it is worth it |
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
/cache line on | off | auto      also pin it under the prompt, draw it nowhere, or only in the terminal script
/cache band show account model   the same for the band
/cache fields                    every field and both lists
```

Or in `/plugin configure cache-meter@cachemeter` (and `/config`): `bandFields`, `lineFields`, `statusLine`, `resetStyle`, `accountLabels`.

Compaction from the prompt:

```
/cache compact                   compact now, as /compact does
/cache autocompact on | off      switch Claude Code's auto-compact, as /config does
```

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
| `bandFields` | fields, in order | `cache, next, account, 5h, 7d, spend, context, compact` |
| `lineFields` | fields, in order | `account, model, effort, cache, next, 5h, 7d, context, compact, branch` |
| `statusLine` | `auto`, `on`, `off` | `auto`: the terminal script only |
| `resetStyle` | `auto`, `countdown`, `clock`, `both` | `auto`: a countdown, `6d 15h` or `14h 20m` |
| `compactHint` | `on`, `off` | `on` |
| `compactAt` | `30` to `70` | `50`: with a cold cache, the context share from which the hint shows |
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
