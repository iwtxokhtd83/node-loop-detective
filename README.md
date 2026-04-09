# node-loop-detective 🔍

Detect event loop blocking, lag, and slow async I/O in **running** Node.js apps — without code changes or restarts.

```
$ loop-detective 12345

✔ Connected to Node.js process
  Profiling for 10s with 50ms lag threshold...

⚠ Event loop lag: 312ms at 2025-01-15T10:23:45.123Z
⚠ Event loop lag: 156ms at 2025-01-15T10:23:48.456Z
🌐 Slow HTTP: 2340ms GET api.example.com/users → 200
🔌 Slow TCP: 1520ms db-server:3306

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

  ⚠ Slow Async I/O Summary
    Total slow ops: 3

    🌐 HTTP — 2 slow ops, avg 1800ms, max 2340ms
      GET api.example.com/users
        2 calls, total 3600ms, avg 1800ms, max 2340ms

    🔌 TCP — 1 slow ops, avg 1520ms, max 1520ms
      db-server:3306
        1 calls, total 1520ms, max 1520ms
```

## How It Works

1. Sends `SIGUSR1` to activate the Node.js built-in inspector (or connects to `--port`)
2. Connects via Chrome DevTools Protocol (CDP)
3. Injects a lightweight event loop lag monitor
4. Tracks slow async I/O (HTTP, DNS, TCP, fetch) via monkey-patching
5. Captures a CPU profile to identify blocking code
6. Analyzes the profile for common blocking patterns
7. Disconnects cleanly — minimal impact on your running app

If the target process exits during profiling, loop-detective detects it immediately, reports any lag/I/O events collected so far, and exits with code 2.

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

# Detect slow I/O with a 1-second threshold
loop-detective -p 12345 --io-threshold 1000

# Connect to a remote inspector (Docker, K8s, remote server)
loop-detective --host 192.168.1.100 --port 9229

# Save raw CPU profile for Chrome DevTools / speedscope
loop-detective -p 12345 --save-profile ./profile.cpuprofile

# Continuous monitoring mode
loop-detective -p 12345 --watch

# JSON output (for piping to other tools)
loop-detective -p 12345 --json
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-p, --pid <pid>` | Target Node.js process ID | — |
| `-H, --host <host>` | Inspector host (remote connections) | 127.0.0.1 |
| `-P, --port <port>` | Inspector port (skip SIGUSR1) | — |
| `-d, --duration <sec>` | Profiling duration in seconds | 10 |
| `-t, --threshold <ms>` | Event loop lag threshold | 50 |
| `-i, --interval <ms>` | Lag sampling interval | 100 |
| `--io-threshold <ms>` | Slow I/O threshold | 500 |
| `--save-profile <path>` | Save raw CPU profile to file | — |
| `--no-io` | Disable async I/O tracking | false |
| `-j, --json` | Output as JSON | false |
| `-w, --watch` | Continuous monitoring | false |

## What It Detects

### CPU / Event Loop Blocking

| Pattern | Description |
|---------|-------------|
| `cpu-hog` | Single function consuming >50% CPU |
| `json-heavy` | Excessive JSON parse/stringify |
| `regex-heavy` | RegExp backtracking |
| `gc-pressure` | High garbage collection time |
| `sync-io` | Synchronous file I/O calls |
| `crypto-heavy` | CPU-intensive crypto operations |

### Slow Async I/O

| Type | What It Tracks |
|------|---------------|
| 🌐 HTTP/HTTPS | Outgoing HTTP requests — method, target, status code, duration |
| 🌐 Fetch | Global `fetch()` calls (Node.js 18+) — method, target, status, duration |
| 🔍 DNS | DNS lookups — callback and promise API (`dns.lookup` + `dns.promises.lookup`) |
| 🔌 TCP | TCP connections — target host:port, connect time (covers databases, Redis, etc.) |

Each slow I/O event includes the caller stack trace, so you know exactly which code initiated the slow operation.

## Programmatic API

```js
const { Detective } = require('node-loop-detective');

const detective = new Detective({
  pid: 12345,
  inspectorHost: '127.0.0.1',  // or remote host
  duration: 10000,
  threshold: 50,
  interval: 100,
  ioThreshold: 500,
});

detective.on('lag', (data) => console.log('Lag:', data.lag, 'ms'));
detective.on('slowIO', (data) => console.log('Slow I/O:', data.type, data.target, data.duration, 'ms'));
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

Those are great tools, but they require you to **start** your app through them. `loop-detective` attaches to an **already running** process — perfect for production debugging. It also tracks slow async I/O (HTTP, DNS, TCP) which those tools don't focus on.

## License

MIT
