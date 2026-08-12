# pi-tps-status

Shows a live tokens-per-second (TPS) widget in the [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) status bar while the agent streams a response — configurable display modes, counting strategies, colors and end-of-stream behavior.

## What you get

- **Live TPS meter.** A sliding-window rate updated on every streamed chunk, color-coded by speed tier: `⚡ TPS: 42.1 tok/s [provider]`.
- **TTFT and stats modes.** The status suffix can show time-to-first-token, total tokens / elapsed time, both, or neither.
- **Three counting strategies.** `estimate` (chars ÷ 4), `direct` (one token per chunk), or `provider` (exact usage reported by the provider, back-dated across the stream window).
- **Provider reconciliation.** When the provider reports final usage, the meter merges it with fallback estimates — so the displayed total matches the provider's number, not a guess.
- **Tool time excluded.** While the agent runs a tool, the clock is paused; the rate reflects pure generation, not tool execution.
- **`/tps` command.** An interactive settings list (display mode, counting strategy, end-of-stream behavior) persisted to `config.json` with atomic writes and validation.

## Quick start

The widget appears automatically on session start:

```text
⚡ TPS: 42.1 tok/s [provider]
```

Run `/tps` to configure it:

```text
/tps
```

## Installation

```bash
pi install npm:pi-tps-status
```

From a local checkout:

```bash
pi install /path/to/pi-tps-status
```

## Display modes

| Mode | Status bar shows |
| --- | --- |
| `tps` | `⚡ TPS: 42.1 tok/s [provider]` |
| `ttft` | TPS plus `(TTFT: 812 ms)` |
| `stats` | TPS plus `(1234 tok in 12.3s)` |
| `full` | TPS plus `(1234 tok in 12.3s · TTFT: 812 ms)` |

The source tag after the rate is `[provider]` (exact usage), `[est]` (chars ÷ 4), or `[chunk]` (per-chunk counting).

## Speed tiers

The rate is colored by four configurable thresholds (defaults: slow 0, medium 15, fast 30, blazing 45 tok/s):

| Tier | Default color |
| --- | --- |
| slow | `#ff4444` |
| medium | `#ffaa00` |
| fast | `#00ff88` |
| blazing | `#44ddff` |

## Counting strategies

| Strategy | How tokens are counted |
| --- | --- |
| `estimate` | `ceil(chars / 4)` per streamed delta. |
| `direct` | One token per streamed chunk. |
| `provider` (default) | Only the provider's reported usage counts; fallback estimates are used to fill the gap until the first report. |

`useProviderTokens` (default on) additionally prefers the provider's exact counts whenever they are reported, regardless of strategy. Final provider usage is back-dated across the stream window so the rate curve stays smooth instead of jumping at the end.

## End-of-stream behavior

| Behavior | After streaming stops |
| --- | --- |
| `average` | The widget shows the average rate over the whole generation. |
| `last` | The widget keeps the last live (sliding-window) rate. |

## Settings

Settings live in `~/.config/pi-tps-status/config.json`, created automatically when a setting is changed. On non-Windows platforms, the config directory honors `XDG_CONFIG_HOME` when set (falling back to `~/.config`); on Windows it always uses `~/.config`:

```json
{
  "display": "tps",
  "tpsSlow": 0,
  "tpsMedium": 15,
  "tpsFast": 30,
  "tpsBlazing": 45,
  "colorSlow": "#ff4444",
  "colorMedium": "#ffaa00",
  "colorFast": "#00ff88",
  "colorBlazing": "#44ddff",
  "slidingWindow": 1000,
  "useProviderTokens": true,
  "countStrategy": "provider",
  "endTpsBehavior": "average"
}
```

| Setting | Range / values | Default |
| --- | --- | --- |
| `display` | `tps` \| `ttft` \| `stats` \| `full` | `tps` |
| `tpsSlow` / `tpsMedium` / `tpsFast` / `tpsBlazing` | 0–1,000,000, strictly ascending | 0 / 15 / 30 / 45 |
| `colorSlow` … `colorBlazing` | `#rrggbb` | see above |
| `slidingWindow` | 100–30,000 ms | 1000 |
| `useProviderTokens` | `true` \| `false` | `true` |
| `countStrategy` | `provider` \| `estimate` \| `direct` | `provider` |
| `endTpsBehavior` | `average` \| `last` | `average` |

Writes are atomic (a UUID-named temp file with `0600` permissions, fsynced and renamed over the target, with stale temp files swept on the next write), and invalid values are rejected with a warning notification that names the offending key and the fallback used.

## How the meter works

- **Sliding window.** Token samples are kept for the configured window; the rate is the token delta over the sample span (minimum 250 ms before a rate is shown).
- **Pause/resume.** Tool executions increment a counter; while it is non-zero the clock is paused, so tool time never dilutes the rate.
- **Reconciliation.** At the end of a turn the provider's total output tokens replace the estimate, with any fallback-counted tokens that the provider didn't cover added on top.
- **TTFT.** Measured from the user message to the first streamed delta (text, thinking or tool call).

## Troubleshooting

- **The widget shows `--`.** No stream has started yet, or the stream was shorter than the 250 ms minimum span. Send a message and watch it stream.
- **The rate looks wrong.** Check the counting strategy: `estimate` and `direct` are approximations; `provider` (or `useProviderTokens: true`) uses the provider's exact numbers.
- **Settings were rejected.** The notification lists the invalid keys and the defaults applied — fix the values in `config.json` or re-run `/tps`.
- **Settings moved.** Older versions stored settings under the `tokenSpeed` key in `~/.pi/agent/settings.json`; they now live in `~/.config/pi-tps-status/config.json` and are not migrated automatically.

## Development

Requires [Node.js](https://nodejs.org) ≥ 22.19 and npm.

```bash
npm install
npm test
npm run typecheck
```

## Credits

- [Gabriel Sanhueza](https://github.com/gsanhueza), [pi-token-speed](https://github.com/gsanhueza/pi-token-speed) — this extension is derived from it
- [Anthony Fangqing](https://github.com/AnthonyFangqing), [pi-tps](https://github.com/AnthonyFangqing/pi-tps) — the pi port of the original TPS meter on which pi-token-speed builds
- [Tarquinen](https://github.com/Tarquinen), [oc-tps](https://github.com/Tarquinen/oc-tps) — the original TPS extension this family traces back to
- [badlogic](https://github.com/badlogic), pi-coding-agent and the TUI status-bar APIs

## License

[MIT](LICENSE)
