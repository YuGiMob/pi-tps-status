# pi-tps-status

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that shows a live tokens-per-second (TPS) widget in the pi status bar while the agent streams a response.

## Features

- **Live TPS meter** with a sliding-window rate, color-coded by speed tiers (`⚡ TPS: 42.1 tok/s [provider]`).
- **TTFT and stats modes.** The status suffix can show time-to-first-token, total tokens / elapsed time, both, or neither.
- **Three counting strategies.** `estimate` (chars/4), `direct` (per chunk), or `provider` (exact usage reported by the provider, back-dated across the stream window).
- **Provider reconciliation.** Final provider token counts are merged with fallback estimates; tool-execution time is paused out of the rate.
- **`/tps` command.** Interactive settings list (display mode, counting strategy, end-of-stream behavior) persisted to `settings.json` with atomic writes and validation.

## Installation

```bash
pi install npm:pi-tps-status
```

## Usage

The widget appears automatically on session start. Run `/tps` to configure it.

Settings are stored under the `tokenSpeed` key in `settings.json` (display, tps thresholds and colors, sliding window, count strategy, end-of-stream behavior).
