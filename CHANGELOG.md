# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-31

### Added

- Band above the prompt: prompt cache warm or cold with time left, next message cost warm and cold, context size, cache hit rate, usage limits with time to reset, session cost. Parts are split by dividers and drop out by priority as the window narrows.
- Usage limits follow the plan: only limits the API reports are shown, so a plan with the weekly limit alone (Ultra) shows no 5-hour one.
- `/cache` and the `Details` button open a pane with the full breakdown in sections: Prompt Cache, Next Message, This Session, Usage Limits.
- Cold send guard: a message sent into a cold cache over 50k tokens is held once with its re-cache price (`guard`: confirm, warn, off).
- `ttl` setting: auto (1h on a subscription, 5m on an API key), 1h or 5m.
- List price table for Fable, Mythos, Opus, Sonnet and Haiku models, October 2026.
