# node-loop-detective 🔍

Detect event loop blocking & lag in **running** Node.js apps — without code changes or restarts.

```
$ loop-detective 12345

✔ Connected to Node.js process
  Profiling for 10s with 50ms lag threshold...

⚠ Event loop lag: 312ms at 2025-01-15T10:23:45.123Z
⚠ Event loop lag: 156ms at 2025-01-15T10:23:48.456Z

────────────────────────────────────────────────────────────
  Event Loop Detective Report
────────────────────────────────────────────────────────────
  Duration:  10023ms
  Samples:   4521
  Hot funcs: 12

  Diagnosis
────────────────────────────────────────────────────────────
   HIGH  cpu-hog
         Function "heavyComputation" consumed 62.3% of CPU time (6245ms)
         at /app/server.js:42
         → Consider breaking this into smaller async chunks or moving to a worker thread

   1. heavyComputation
      ██████████████░░░░░░ 6245ms (62.3%)
      /app/server.js:42:1
```

## How It Works

1. Sends `SIGUSR1` to activate the Node.js built-in inspector (or connects to `--port`)
2. Connects via Chrome DevTools Protocol (CDP)
3. Injects a lightweight event loop lag monitor
4. Captures a CPU profile to identify blocking code
5. Analyzes the profile for common blocking patterns
6. Disconnects cleanly — minimal impact on your running app

## Install

```bash
npm install -g node-loop-detective
```

## Usage

```bash
# Basic: profile a running Node.js process by PID
loop-detective <pid>

# Connect to an already-open inspector port
loop-detective --port 9229

# Profile for 30 seconds with 100ms lag threshold
loop-detective -p 12345 -d 30 -t 100

# Continuous monitoring mode
loop-detective -p 12345 --watch

# JSON output (for piping to other tools)
loop-detective -p 12345 --json
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-p, --pid <pid>` | Target Node.js process ID | — |
| `-P, --port <port>` | Inspector port (skip SIGUSR1) | — |
| `-d, --duration <sec>` | Profiling duration in seconds | 10 |
| `-t, --threshold <ms>` | Event loop lag threshold | 50 |
| `-i, --interval <ms>` | Lag sampling interval | 100 |
| `-j, --json` | Output as JSON | false |
| `-w, --watch` | Continuous monitoring | false |

## What It Detects

| Pattern | Description |
|---------|-------------|
| `cpu-hog` | Single function consuming >50% CPU |
| `json-heavy` | Excessive JSON parse/stringify |
| `regex-heavy` | RegExp backtracking |
| `gc-pressure` | High garbage collection time |
| `sync-io` | Synchronous file I/O calls |
| `crypto-heavy` | CPU-intensive crypto operations |

## Programmatic API

```js
const { Detective } = require('node-loop-detective');

const detective = new Detective({
  pid: 12345,
  duration: 10000,
  threshold: 50,
  interval: 100,
});

detective.on('lag', (data) => console.log('Lag:', data.lag, 'ms'));
detective.on('profile', (analysis) => {
  console.log('Heavy functions:', analysis.heavyFunctions);
  console.log('Patterns:', analysis.blockingPatterns);
});

await detective.start();
```

## Requirements

- Node.js >= 16
- Target process must be running Node.js
- On Linux/macOS: permission to send signals to the target process
- On Windows: target must be started with `--inspect` flag (SIGUSR1 not available)

## How is this different from clinic.js / 0x?

Those are great tools, but they require you to **start** your app through them. `loop-detective` attaches to an **already running** process — perfect for production debugging.

## License

MIT
