#!/usr/bin/env bash
# Vitals status line for the terminal.
#
# The plugin draws the line itself (the fields you chose with /plugin configure
# or /cache line ...) and writes it per session to $TMPDIR/vitals/<session>.line.
# This script only prints that file. Before the plugin has written it (the first
# moment of a session, or with the plugin off) it prints a short line from the
# status line JSON Claude Code hands it: account, model, limits and context.
# It sends nothing anywhere.
#
# settings.json of each account:
#   "statusLine": {"type": "command",
#     "command": "bash \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/vitals/bin/statusline.sh\""}
set -u

input="$(cat)"
session="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_.-]*\)".*/\1/p' | head -1)"
dir="${TMPDIR:-/tmp}"
dir="${dir%/}/vitals"
if [ -n "$session" ] && [ -s "$dir/$session.line" ]; then
  cat "$dir/$session.line"
  exit 0
fi

# Fallback: the plugin has not written this session's line yet.
config="${CLAUDE_CONFIG_DIR:-}"
case "$config" in
  ""|"$HOME/.claude"|"$HOME/.claude/") label="A" ;;
  *) label="$(basename "$config" | sed -e 's/^\.claude[-_.]//' -e 's/^\.//' | tr '[:lower:]' '[:upper:]')" ;;
esac
command -v jq >/dev/null 2>&1 || { printf '%s' "$label"; exit 0; }
printf '%s' "$input" | jq -r --arg label "$label" --argjson now "$(date +%s)" '
  def pct: if type == "number" then ((. + 0.5) | floor | tostring) + "%" else empty end;
  def left: if type == "number" then (. - $now) as $s
    | if $s <= 0 then "reset" elif $s >= 86400 then "\(($s / 86400) | floor)d \((($s % 86400) / 3600) | floor)h"
      else "\(($s / 3600) | floor)h \((($s % 3600) / 60) | floor)m" end else empty end;
  def win($name): if . then $name + " " + (.used_percentage | pct) + (if .resets_at then " " + (.resets_at | left) else "" end) else empty end;
  [ $label,
    (.model.display_name // empty),
    (.rate_limits.five_hour | win("5h")),
    (.rate_limits.seven_day | win("7d")),
    (.context_window.used_percentage | if type == "number" then "ctx " + pct else empty end)
  ] | map(select(. != null and . != "")) | join(" · ")' 2>/dev/null || printf '%s' "$label"
