# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-11-23

### Added

- Images in the context. The band's new `images` field (in the default band, hidden with none), `/vitals images` and a row in the Context tab show how many images the context carries and their tokens, which every message and every Keep Warm ping reads again.
- `/compact images` takes the images tools returned out of the context and keeps the rest of the conversation word for word. The session's own model describes each one in a single fork over its cached transcript, and the description, with the file's path, stands in its place; without one, the reply right after the image does. No summary is made, and auto-compact and other `/compact` words work as before.
- The compact hint names the images (`images 40k, /compact images`) once those from tools weigh 20k tokens or more and a tenth of the context.

## [0.7.2] - 2026-11-16

### Fixed

- An account renamed in one session kept its old name in the others until they restarted. The name is kept per account, and every reading now takes the kept one, so the band, the status line and the pane of every session follow a rename or a reset.
- A narrow pane cut buttons and the rename field at its edge. Under 72 columns each label now stands above its value, button rows wrap, and the rename field has a line of its own at any width.

### Changed

- A renamed account shows both labels: yours, and under it the automatic one (from `accountLabels`, the config folder's name, or its letter), which Reset brings back. Both are kept in the account's store, and `$.vitals.snapshot()` gives `account.auto` beside `account.label`.

### Removed

- The offered label ("Label it Acme"), guessed from the login's organization or e-mail domain. The label is the automatic one until you rename it.

## [0.7.1] - 2026-11-15

### Fixed

- Fable 5.2 and Mythos 5.2 were missing from the price table, so the pane read "Not in the price table" and the next message had no price. They are in ($8 / $40 per million tokens, cache reads $0.20), and Sonnet 5.5 cache reads are $0.10.
- A band without room for every part dropped the context even on a wide window. It now says parts shorter first (the context as its share alone, a limit without its reset time) and drops one only when that is not enough.
- The timeline showed replies with their Markdown marks (backticks, `##`, link addresses). It reads as plain words now, and a long message is cut at a word with the three dots right after it instead of on a line of their own.
- A subagent handing back its result was listed as a message from you and counted as one. It reads as "Agent".
- A message that quotes an earlier reply opened with the quote. The timeline shows what you wrote.

## [0.7.0] - 2026-11-15

### Fixed

- After a compaction the band read "Cold Compacted", as if the cache had been compacted. It is the conversation that is compacted and the cache that is cold because of it: the band now reads "Cold After compaction", the status line "Cold after compaction", and a cold cache always says why (idle 1h 06m, model changed, after a break).
- A cold cache takes more room in the band (it adds the re-cache price), which pushed the context out of a band of ordinary width. The context now stays as long as the account and the main limit; the next message cost and the second limit go first.
- The timeline cut each message at the pane's edge. Messages now wrap, up to 180 characters and then three dots, and meters are as wide as the pane leaves, so a narrow pane cuts nothing.
- The footnote about connectors named by an id showed even when every server had a name.

### Changed

- The timeline lists the newest message first. A reply says "took 16m" where it said "16m", and a break that let the cache go cold stands under the message that paid for it. Entries older than a day carry their weekday.
- An account now has an ID (its config folder's name, which never changes) and a label (what the band shows, yours to set). A folder that carries a name labels the account by it (`.claude-work` is Work, where it was WORK); a folder with none gets a letter. The pane's Now tab has a field to rename the account and a Reset button, and offers a label from the login's organization or e-mail domain to an account that has only a letter. `/vitals account` prints the label, its source and the ID. `$.vitals.snapshot()` carries `account.id`.
- The pane's Now tab opens on what changes (prompt cache, next message, limits); the account and the session stand below.
- The status line script's fallback, before the plugin has written a session's line, no longer prints an account letter: the label is the plugin's to say.

### Added

- A plugin icon.

### Removed

- The old `/cache` command, kept since the rename from Cache Meter. `/vitals` takes every argument it did.

## [0.6.1] - 2026-11-15

### Fixed

- A session Vitals joins late (the plugin installed or reloaded mid-session) no longer reads "Waiting for the first reply": the cache is timed from when the session's transcript was last written. With requests but no figure yet it says "Known after the next reply".
- The Context tab's What Fills It counted tool schemas loaded on demand and the auto-compact reserve, so it summed to far more than the context. It now lists only what is in the window, each as a share of it, and names the deferred schemas and the reserve apart.
- MCP servers from claude.ai connectors read by an id. They are now named from their tools (Notion, or the commonest tool prefixes), and each shows what it has in the window and what loads on demand.
- Meters drew past their share in the desktop app, with an ellipsis. They are now a fixed row of cells.
- The timeline took the app's notes (system reminders) and other sessions' messages for yours. Each entry now says who sent it: you, another session, a finished task, a scheduled prompt or the app, with the notes taken out. Claude's replies show their opening line.

### Added

- `/vitals account [name|reset]` names the account, kept for every session on it. With one account on the machine the band and the status line leave the account out.

### Changed

- The README is written for the public repository: why the plugin exists, install, update and remove, a preview image, a privacy section, the Alfred send marked as optional, and notes for plugin authors.

## [0.6.0] - 2026-11-15

### Renamed

- Cache Meter is now **Vitals**: repo `iameryksadowski/vitals-plugin-claude-code`, plugin `vitals@vitals`, command `/vitals` (`/cache` still works), statusLine script under `plugins/marketplaces/vitals/`. Settings and the fields chosen with `/cache` start fresh under the new name.

### Added

- The pane has five tabs: Now, Context, Cost, Timeline and Settings. `/vitals now|context|cost|timeline|settings` opens it on one.
- Context tab: how full the context is, when auto-compact runs with a switch for it, what fills the context as `/context` counts it (estimated locally, no request) and the heaviest MCP servers.
- A compact hint (`compact` field, on by default): the band says when compacting is worth it, when the cache is cold and the context is over `compactAt` (50%), when auto-compact is within 10 points, or over 80% with auto-compact off. `/vitals compact` and Compact Now compact; `/vitals autocompact on|off` switches Claude Code's auto-compact. Settings `compactHint` and `compactAt`.
- Timeline tab: when each message went and how long each reply took, with its tool count, and the breaks after which the cache went cold.
- In its last minutes the band also says what the next message costs once the cache is cold.
- `$.vitals.snapshot()` for other plugins: this session's account, cache, context with auto-compact and advice, limits and session figures. No e-mail, nothing said in the session.

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
