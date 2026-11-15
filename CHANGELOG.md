# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-11-15

### Added

- The pane has five tabs: Now, Context, Cost, Timeline and Settings. `/cache now|context|cost|timeline|settings` opens it on one.
- Context tab: how full the context is, when auto-compact runs with a switch for it, what fills the context as `/context` counts it (estimated locally, no request) and the heaviest MCP servers.
- A compact hint (`compact` field, on by default): the band says when compacting is worth it, when the cache is cold and the context is over `compactAt` (50%), when auto-compact is within 10 points, or over 80% with auto-compact off. `/cache compact` and Compact Now compact; `/cache autocompact on|off` switches Claude Code's auto-compact. Settings `compactHint` and `compactAt`.
- Timeline tab: when each message went and how long each reply took, with its tool count, and the breaks after which the cache went cold.
- In its last minutes the band also says what the next message costs once the cache is cold.

### Changed

- One row above the prompt by default: cache, next message cost, account, its usage limits, context and the compact hint. Fields Claude Code already shows (model, effort and permission mode are in the desktop footer) are left out of it.
- The status line is the terminal's: `statusLine: auto` no longer pins it under the prompt in the desktop app, where the band shows the same. `on` still pins it everywhere. Its default fields are account, model, effort, cache, next, limits, context, compact hint and branch; the e-mail is in the pane.
- Resets read as a countdown everywhere: `6d 15h`, within a day `14h 20m`. `resetStyle: clock` or `both` brings the clock back.
- The account reads as its bare label (`A`), and the status line splits every field with a middle dot.

### Fixed

- After a compaction, or a session that comes back after an app restart, the band no longer says "Waiting for the next reply" for hours: the cache reads cold (compacted, or after a break), priced from the live context. Each session's last request is kept, so a session that comes back shows its real idle time.

## [0.5.0] - 2026-11-15

### Added

- A status line with the fields you choose: account (a letter from the config folder or your own label), e-mail, model with its version, effort, permission mode, output style, folder, git branch, everything the band shows, and the 5-hour and weekly limits with their reset on the clock or as a countdown.
- It works in the desktop app and in the terminal: pinned under the prompt by the plugin where no `statusLine` command runs (the desktop app), and printed by the plugin's `bin/statusline.sh` where the account's `statusLine` points at it.
- Every field can be shown, hidden and ordered, in the band and in the status line: `bandFields` and `lineFields` in the plugin settings, or `/cache band|line show|hide|set|reset` for this account; `/cache fields` lists them; `/cache line on|off|auto` pins the line.
- `resetStyle` (countdown, clock or both) and `accountLabels`.
- An Account card in the pane: account, e-mail, model and effort, mode, output style, folder and branch, the status line as it reads now and the last send to Alfred.
- `alfred`: sends the session's usage windows, context and model id (never the e-mail) to the local Alfred engine once a minute per session, from the plugin itself, so desktop sessions report too. It replaces the sending in `alfred-app/scripts/statusline.sh`.

### Changed

- The band is built from the chosen fields; out of the box it reads as before.

### Fixed

- A test expected the engine's own band row above ours; since Claude Code stacks the rows itself (`AbovePromptList`), it now checks that both stay.

## [0.4.0] - 2026-11-12

### Added

- Keep Warm and the cold send guard can be kept on or off per repo: `/cache guard repo on|off|reset`, `/cache warm repo on|off|reset`, or one button in the pane. A repo's choice holds in every new session there and in its worktrees, over the plugin settings; a session's own switch still wins.
- The pane and `/cache` say for each switch which level set it: this session, this repo or the plugin settings.

### Changed

- The cold send guard is off by default, like Keep Warm. Both are switched on in the plugin settings for every repo, per repo or per session. An unknown `guard` value now reads as off.

## [0.3.2] - 2026-11-10

### Changed

- The plugin shows as "Cache Meter" in the plugin list (`displayName`), with "By Eryk Sadowski" in its description and the author on the marketplace entry. A shorter, clearer description; category and tags for search. The plugin id stays `cache-meter@cachemeter`.

### Removed

- The plugin icon and its source: Claude Code does not show a plugin icon, and the plugin carries no brand marks. The plugin list shows the default icon.

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
