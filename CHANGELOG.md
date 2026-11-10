# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-11-10

### Changed

- No more ES Tools: the plugin is Cache Meter, signed Eryk Sadowski. The repository is now `cachemeter-plugin-claude-code` and the marketplace `cachemeter`, so install it as `cache-meter@cachemeter` (the old `estools` marketplace is gone; remove it and add the new one).

## [0.3.0] - 2026-11-05

### Added

- The cold send guard switches off and on per session: a Cold Send Guard card with a button in the pane, `/cache guard [on|off]`, and a hint in the held message. `/cache` prints its state where no pane can be seated.

### Fixed

- After a restart, before the first reply, the limits were cleared, so a subscription was taken for an API key: the TTL read 5m and the guard priced a cold send at the 5-minute write rate ($1.82 instead of $2.91 for 364k on Opus 5.5). The last known limits now stay until the API reports new ones.

## [0.2.0] - 2026-10-31

### Changed

- One spacing rule in the band: one space inside a part, the `│` separator between parts.
- Parts are kept strictly by priority as the band narrows, and the cache state is always drawn (Details gives way first).
- The hit rate rounds down: 99.6% reads 99%, never 100%.
- A model the price table does not know shows no prices instead of `n/a`, and models are named from their id (Sonnet 4.6, Opus 5.1).
- Price rows match whole versions only, so an unknown version is never priced as its neighbour. Added Opus 4.1, Sonnet 4.5 and 4.6, Sonnet 3.7, Haiku 3, Opus 3, and long-context prices for Sonnet 4.x.

### Fixed

- After a model switch the band showed the old model's warm cache; it now shows Cold, "Model changed", priced on the new model, and the guard and Keep Warm follow.
- The engine's own cache TTL, when it reports one, is used instead of the guess.
- The context share of the window was missing until the engine reported the window separately.
- Token counts between 999.5k and 1M read "1000k"; cents half way between were rounded down ($1.505 read $1.50).
- A usage limit past its reset showed the old figure with "now"; it says "Just reset".
- A limit with no valid figure is left out instead of drawn as NaN.

### Added

- 49 tests: formatting, prices, the cache view at its edges, the band at every width from 10 to 220 columns, the pane on every surface, the guard, Keep Warm, model switches, /clear, compaction and resume.

## [0.1.3] - 2026-10-31

### Changed

- Time to a usage limit's reset is a plain gray countdown (`2d 4h`), without "Resets in".
- When the cache state is not known yet but the session already has requests (after a plugin update or restart), the band says "Waiting for the next reply" instead of "first reply".

## [0.1.2] - 2026-10-31

### Added

- The pane shows the effort next to the model (Low, Medium, High, Extra High, Max, or a token budget), as the last main-thread request asked for it.

## [0.1.1] - 2026-10-31

### Changed

- The band keeps the plan's main usage limit (Weekly on Ultra) with its time to reset right after the cache state, so it stays on narrow windows.
- A little space between the rows of each card in the pane, easier to read on small screens.

## [0.1.0] - 2026-10-31

### Added

- Band above the prompt: prompt cache warm or cold with time left, next message cost warm and cold, context size, cache hit rate, usage limits with time to reset, session cost. Parts are split by dividers and drop out by priority as the window narrows.
- Usage limits follow the plan: only limits the API reports are shown, so a plan with the weekly limit alone (Ultra) shows no 5-hour one.
- `/cache` and the `Details` button open a pane with the full breakdown in sections: Prompt Cache, Next Message, This Session, Usage Limits.
- Cold send guard: a message sent into a cold cache over 50k tokens is held once with its re-cache price (`guard`: confirm, warn, off).
- Keep Warm, off by default: a one-line fork over the session's own transcript shortly before the cache expires, so it is read instead of re-written. Toggle in the pane or `/cache warm`; `keepWarm` and `keepWarmFor` settings.
- The pane reflows at any width: cards with borders, text that wraps as one paragraph, meters sized in percent.
- Plugin icon in the Eryk Sadowski style.
- `ttl` setting: auto (1h on a subscription, 5m on an API key), 1h or 5m.
- List price table for Fable, Mythos, Opus, Sonnet and Haiku models, October 2026.
