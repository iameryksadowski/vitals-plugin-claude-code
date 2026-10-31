# ES Tools Cache Meter

A quiet meter above the Claude Code prompt for the prompt cache and your usage limits. One row in your theme's colors; the full breakdown one click away.

```
● Cache Warm 42m left  │  Next $0.06  │  If Cold $2.41  │  Context 301k 30%  │  Hit Rate 96%  │  Weekly 88% 2d 4h  │  Session $3.50    Details
```

## Install

Private repo: your GitHub account needs access to it. From a shell:

```
claude plugin marketplace add iameryksadowski/estools-plugin-claude-code-cache-meter
claude plugin install cache-meter@estools --scope user
```

Or at the prompt of a Claude Code session: `/plugin marketplace add iameryksadowski/estools-plugin-claude-code-cache-meter`, then `/plugin install cache-meter@estools`. Update later with `claude plugin marketplace update estools`.

## What it shows

- **Cache state**: warm with time left, a warning color in the last 10 minutes (last minute on a 5m TTL), cold with idle time.
- **Next message**: what re-sending the context costs while warm (cache read) and once cold (cache write).
- **Context**: tokens the next request re-sends and the share of the model's window.
- **Usage limits**: percent used and time to reset for each limit your plan has (Weekly, and 5-Hour where the plan reports one); warning at 80%, error at 95%.
- **Hit rate and session cost**: share of input served from cache on the main thread, and the engine's session total.

Parts drop out strictly by priority as the window narrows: the cache state stays always, then your main usage limit, then the next message cost and the context. `Details` (or `/cache`) opens a side pane with the full breakdown: TTL bar, read and write rates, cold/warm ratio, tokens read, written and uncached, what caching saved, cold writes paid, the last request and every usage limit.

## Honest by design

- A model switch makes the cache cold at once (the engine says so), and the next message is priced on the new model.
- A model the price table does not know shows no prices at all, never a guess from a neighbouring model.
- The TTL is the one the engine reports when it reports one; the `ttl` setting wins when set by hand.
- A usage limit past its reset time says "Just reset" until the next reply brings the new figure.
- The hit rate rounds down, so it never shows 100% unless every token was read from cache.
- Not visible to the meter: a side chat or another tool that reads the same cache. Then the real cache can be warmer than shown, never colder.

## Keep Warm

Off by default. Switch it on per session with the button in the pane or `/cache warm` (`/cache warm on`, `/cache warm off`), or for every new session with the `keepWarm` setting.

Shortly before the cache would expire (5 minutes on a 1h TTL, 45 seconds on 5m), it forks one tool-less question over the session's own transcript on the same model and system prompt. The API serves that prefix from the cache, the read starts the TTL over, and nothing is added to the conversation. Each ping costs one cache read of the context (about $0.03 for 150k tokens on Opus 5.5) instead of a full re-write later (about $1.20). It stops `keepWarmFor` after your last message, and switches itself off if a ping ever finds the cache already gone.

## Cold send guard

When the cache has gone cold and the context is over 50k tokens, the first message you send is held once with its re-cache price. Send it again to go ahead, or `/clear` and start from a summary. Slash commands and prompts nobody typed (task notifications, scheduled prompts, other sessions) are never held.

## Settings

All are pickers in `/config` (or `pluginConfigs` in settings):

| Field | Values | Default |
| --- | --- | --- |
| `ttl` | `auto`, `1h`, `5m` | `auto`: 1h on a subscription, 5m on an API key |
| `guard` | `confirm`, `warn`, `off` | `confirm` |
| `keepWarm` | `off`, `on` | `off`: switch it on per session |
| `keepWarmFor` | `1h`, `2h`, `4h`, `8h` | `2h` after your last message |

## Good to know

- With Keep Warm off it never calls a model and costs nothing to run: it reads the engine's own figures and the API's usage counts.
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

ES Tools by Eryk Sadowski · eryksadowski.com
