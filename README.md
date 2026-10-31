# ES Tools Cache Meter

A quiet meter above the Claude Code prompt for the prompt cache and your usage windows. One row in your theme's colors; the full breakdown one click away.

```
● cache warm 42m left · next $0.06 · ctx 301k 30% · 5h 42% 3h10m · 7d 88% 2d4h · cold $2.41 · hit 97% · session $3.50    details
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cache-meter --marketplace iameryksadowski/estools-plugin-claude-code-cache-meter
```

Answer `y` to add the marketplace and pick the user scope. From a shell:

```
claude plugin install cache-meter --marketplace iameryksadowski/estools-plugin-claude-code-cache-meter
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `iameryksadowski/estools-plugin-claude-code-cache-meter`, then Add plugin.

## What it shows

- **Cache state**: warm with time left, a warning color in the last 10 minutes (last minute on a 5m TTL), cold with idle time.
- **Next message**: what re-sending the context costs while warm (cache read) and once cold (cache write).
- **Context**: tokens the next request re-sends and the share of the model's window.
- **Usage windows**: 5h and 7d percent used and time to reset; warning at 80%, error at 95%.
- **Hit rate and session cost**: share of input served from cache on the main thread, and the engine's session total.

Parts drop out by priority as the window narrows. `details` (or `/cache`) opens a side pane with the full breakdown: TTL bar, read and write rates, cold/warm ratio, tokens read, written and uncached, what caching saved, cold writes paid, the last request and both usage windows.

## Cold send guard

When the cache has gone cold and the context is over 50k tokens, the first message you send is held once with its re-cache price. Send it again to go ahead, or `/clear` and start from a summary. Slash commands and prompts nobody typed (task notifications, scheduled prompts, other sessions) are never held.

## Settings

Both are pickers in `/config` (or `pluginConfigs` in settings):

| Field | Values | Default |
| --- | --- | --- |
| `ttl` | `auto`, `1h`, `5m` | `auto`: 1h on a subscription, 5m on an API key |
| `guard` | `confirm`, `warn`, `off` | `confirm` |

## Good to know

- It never calls a model and costs nothing to run: it reads the engine's own figures and the API's usage counts.
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

[MIT](LICENSE)

---

ES Tools by Eryk Sadowski · eryksadowski.com
