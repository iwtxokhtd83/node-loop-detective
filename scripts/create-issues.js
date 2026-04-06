#!/usr/bin/env node
'use strict';

/**
 * Creates GitHub issues for node-loop-detective.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxxx node scripts/create-issues.js
 */

const https = require('https');

const REPO = 'iwtxokhtd83/node-loop-detective';
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('Error: Set GITHUB_TOKEN environment variable first.');
  console.error('  Create one at: https://github.com/settings/tokens');
  console.error('  Usage: GITHUB_TOKEN=ghp_xxxx node scripts/create-issues.js');
  process.exit(1);
}

const issues = [
  {
    title: 'Bug: I/O monkey-patches are never restored on cleanup',
    body: `## Description

\`_startAsyncIOTracking\` patches \`http.request\`, \`https.request\`, \`dns.lookup\`, and \`net.Socket.connect\` in the target process, but the \`cleanup()\` function only does \`delete globalThis.__loopDetectiveIO\`.

The original functions are **never restored**. After loop-detective disconnects, the patched functions remain in the target process permanently, adding overhead to every subsequent HTTP/DNS/TCP call for the lifetime of the process.

## Expected Behavior

On cleanup, the original functions should be restored:

\`\`\`javascript
// Store originals
const origHttpRequest = http.request;
const origDnsLookup = dns.lookup;
// ...

// On cleanup
cleanup: () => {
  http.request = origHttpRequest;
  dns.lookup = origDnsLookup;
  // ...
  delete globalThis.__loopDetectiveIO;
}
\`\`\`

## Impact

- Memory/CPU overhead on every I/O call after disconnect
- Potential interference with other debugging tools
- Unexpected behavior if loop-detective is run multiple times on the same process`,
    labels: ['bug'],
  },
  {
    title: 'Bug: _watchMode runCycle() has unhandled promise rejections',
    body: `## Description

In \`_watchMode()\`, \`runCycle()\` is called without \`await\`, and the \`setTimeout(runCycle, 1000)\` callback also doesn't handle rejections.

\`\`\`javascript
async _watchMode() {
  // ...
  const runCycle = async () => {
    // If _captureProfile or inspector.send throws here,
    // the error is silently swallowed
    const profile = await this._captureProfile(this.config.duration);
    // ...
    if (this._running) {
      setTimeout(runCycle, 1000); // no .catch() on the returned promise
    }
  };
  runCycle(); // no await, no .catch()
}
\`\`\`

## Expected Behavior

Errors in the watch cycle should be emitted via the \`error\` event and the cycle should attempt to continue (or stop gracefully).

## Impact

- Watch mode silently dies if any CDP command fails
- No error feedback to the user
- Node.js may emit \`UnhandledPromiseRejection\` warnings`,
    labels: ['bug'],
  },
  {
    title: 'Bug: Race condition — stop() can be called during mid-flight CDP commands',
    body: `## Description

If \`SIGINT\` fires during \`_captureProfile()\`, \`stop()\` disconnects the inspector while \`Profiler.stop\` is still pending. Then the \`finally\` block in \`_singleRun()\` calls \`stop()\` again.

There is no guard against:
1. Double-stop (calling \`stop()\` when already stopped)
2. Disconnecting while CDP commands are in-flight
3. The pending \`Profiler.stop\` promise rejecting after disconnect

## Expected Behavior

- \`stop()\` should be idempotent (safe to call multiple times)
- In-flight CDP commands should be cancelled or awaited before disconnect
- Add a \`_stopping\` guard flag

## Impact

- Potential unhandled rejections
- Possible error messages printed during clean shutdown`,
    labels: ['bug'],
  },
  {
    title: 'Bug: Inspector send() timeout leaks on disconnect',
    body: `## Description

The \`send()\` method in \`Inspector\` sets a 30-second timeout per command:

\`\`\`javascript
setTimeout(() => {
  if (this._callbacks.has(id)) {
    this._callbacks.delete(id);
    reject(new Error(\`CDP command timeout: \${method}\`));
  }
}, 30000);
\`\`\`

When \`disconnect()\` is called, \`_callbacks.clear()\` runs, but the \`setTimeout\` is still pending. The timeout callback then tries to operate on a cleared map. More importantly, if \`disconnect()\` races with the timeout, the Promise may never resolve or reject.

## Expected Behavior

- Store timeout references and clear them on disconnect
- Reject all pending callbacks on disconnect with a clear error message

\`\`\`javascript
disconnect() {
  for (const { reject, timer } of this._callbacks.values()) {
    clearTimeout(timer);
    reject(new Error('Inspector disconnected'));
  }
  this._callbacks.clear();
  // ...
}
\`\`\``,
    labels: ['bug'],
  },
  {
    title: 'Bug: _buildCallStacks matches by function name — can produce wrong stacks',
    body: `## Description

The call stack builder in \`Analyzer._buildCallStacks\` finds target nodes by matching \`functionName + url + lineNumber\`:

\`\`\`javascript
if (cf.functionName === fn.functionName &&
    cf.url === (fn.url === '(native)' ? '' : fn.url) &&
    cf.lineNumber === fn.lineNumber - 1) {
  targetNode = node;
  break; // takes the FIRST match
}
\`\`\`

If two different call sites have the same function name at the same line (e.g., minified code, same-named methods in different classes, or recursive calls), it picks the first match, which may be the wrong node.

## Expected Behavior

Match by node ID instead of by function name. The \`timings\` map already uses node IDs — pass those through to \`_buildCallStacks\` instead of re-searching by name.

## Impact

- Incorrect call stacks in the report for minified or complex codebases
- Misleading diagnostic output`,
    labels: ['bug'],
  },
  {
    title: 'Bug: Lag detector stack trace captures timer callback stack, not blocking code stack',
    body: `## Description

The lag detector's \`captureStack()\` is called inside the \`setInterval\` callback:

\`\`\`javascript
const timer = setInterval(() => {
  const lag = now - lastTime - interval;
  if (lag > threshold) {
    lags.push({ lag, timestamp: now, stack: captureStack() });
  }
}, interval);
\`\`\`

By the time the \`setInterval\` callback fires, the blocking code has **already finished executing**. The captured stack trace is the stack of the timer callback itself (internal Node.js timer frames), not the stack of whatever code was blocking the event loop.

The current filter removes \`node:internal\` and \`Timeout.\` frames, which means the resulting stack is often empty or contains only unrelated frames.

## Expected Behavior

This is a fundamental limitation of the \`setInterval\` approach. Possible improvements:
1. Use \`Debugger.pause\` via CDP to capture the actual stack when blocking is detected
2. Correlate lag timestamps with CPU profile samples to identify what was running during the lag period
3. Document this limitation clearly — the CPU profile analysis (heavy functions + call stacks) is the reliable source for identifying blocking code

## Impact

- Lag event stack traces may be misleading or empty
- Users may be confused by irrelevant stack frames`,
    labels: ['bug', 'documentation'],
  },
  {
    title: "Bug: Patched http.get may break callback handling",
    body: `## Description

The patched \`http.get\` in the I/O tracker does:

\`\`\`javascript
mod.get = function patchedGet(...args) {
  const req = mod.request(...args);
  req.end();
  return req;
};
\`\`\`

The original \`http.get\` has specific argument parsing logic — it accepts \`(url, options, callback)\` with various overloads. The patched version passes all args to \`mod.request\` (which is also patched), then calls \`req.end()\`.

If the original \`http.get\` had different argument normalization than \`http.request\`, this could break. Also, if a library passes a body or specific options that \`http.get\` handles differently, the behavior changes.

## Expected Behavior

Patch \`http.get\` by wrapping the original \`http.get\` directly (like we do for \`http.request\`), rather than reimplementing it via \`mod.request\` + \`req.end()\`.

## Impact

- Potential breakage of HTTP GET requests in the target application
- Subtle behavior differences that are hard to debug`,
    labels: ['bug'],
  },
  {
    title: 'Feature: Support --host option for remote inspector connections',
    body: `## Description

Currently \`Inspector\` hardcodes \`host = '127.0.0.1'\`. There's no way to connect to a remote inspector endpoint.

## Use Cases

- Node.js process running in a Docker container with inspector port exposed
- Remote server with inspector port forwarded
- Kubernetes pod with port-forward

## Proposed Solution

Add a \`--host\` / \`-H\` CLI flag:

\`\`\`bash
loop-detective --host 192.168.1.100 --port 9229
loop-detective -H 0.0.0.0 -P 9229
\`\`\`

The \`Inspector\` class already accepts a \`host\` parameter in its constructor, so this is mainly a CLI wiring change.

## Security Note

Should warn users that connecting to a remote inspector over an untrusted network is a security risk (the CDP protocol has no authentication).`,
    labels: ['enhancement'],
  },
  {
    title: 'Feature: Export raw CPU profile to .cpuprofile file',
    body: `## Description

The raw V8 CPU profile data is captured but only analyzed internally. Users who want deeper analysis (flame graphs, bottom-up views) have no way to access the raw data.

## Proposed Solution

Add a \`--save-profile <path>\` option:

\`\`\`bash
loop-detective 12345 --save-profile ./profile.cpuprofile
\`\`\`

This writes the raw V8 CPU profile JSON to disk. The \`.cpuprofile\` format is directly openable in:
- Chrome DevTools (Performance tab → Load profile)
- VS Code (via extensions)
- speedscope.app

## Benefit

Combines the quick CLI diagnosis of loop-detective with the deep visual analysis of Chrome DevTools flame graphs.`,
    labels: ['enhancement'],
  },
  {
    title: 'Feature: Support dns.promises.lookup and global fetch() in I/O tracking',
    body: `## Description

The I/O tracker only patches callback-style \`dns.lookup\`. Modern Node.js code increasingly uses:

1. **\`dns.promises.lookup\`** (Node.js 10.6+) — the promise-based DNS API
2. **\`fetch()\`** (Node.js 18+) — the global Fetch API backed by undici, which does NOT use \`http.request\` internally

These are currently invisible to the I/O tracker.

## Proposed Solution

1. Patch \`dns.promises.lookup\` alongside \`dns.lookup\`
2. Patch \`globalThis.fetch\` if it exists (Node.js 18+)
3. Consider patching undici's \`request\` / \`Client\` for more complete coverage

## Impact

Without this, slow API calls made via \`fetch()\` or promise-based DNS lookups are completely missed in the report.`,
    labels: ['enhancement'],
  },
  {
    title: 'Feature: Add --no-io flag to disable I/O tracking',
    body: `## Description

The monkey-patching approach for I/O tracking is more invasive than the lag detector or CPU profiler. Some users may want to opt out, especially in sensitive production environments.

## Proposed Solution

Add a \`--no-io\` boolean flag:

\`\`\`bash
loop-detective 12345 --no-io
\`\`\`

When set, skip \`_startAsyncIOTracking()\` entirely. The lag detection and CPU profiling still work normally.

## Use Cases

- High-security production environments where monkey-patching is unacceptable
- Debugging CPU-only issues where I/O tracking adds noise
- Reducing risk when attaching to critical processes`,
    labels: ['enhancement'],
  },
  {
    title: 'Feature: Graceful handling when target process exits during profiling',
    body: `## Description

If the target Node.js process crashes or exits while loop-detective is connected, the WebSocket closes and errors are silently caught in the polling intervals. The tool may hang or exit without useful output.

## Expected Behavior

1. Detect the WebSocket close event promptly
2. If a CPU profile was in progress, report whatever partial data is available
3. Print a clear message: "Target process (PID 12345) exited during profiling"
4. Exit with a distinct exit code (e.g., exit code 2)

## Current Behavior

- Polling intervals silently catch errors
- \`_captureProfile\` hangs waiting for \`Profiler.stop\` response that never comes
- No clear feedback to the user`,
    labels: ['enhancement'],
  },
  {
    title: 'Feature: Add connection retry logic with backoff after SIGUSR1',
    body: `## Description

After sending SIGUSR1, the tool waits a fixed 1 second then tries to connect exactly once:

\`\`\`javascript
async _findInspectorPort() {
  await this._sleep(1000);
  return 9229;
}
\`\`\`

On slow or heavily loaded systems, the inspector may take longer than 1 second to start.

## Proposed Solution

Implement retry with exponential backoff:

\`\`\`javascript
async _findInspectorPort() {
  const maxRetries = 5;
  const baseDelay = 500;
  for (let i = 0; i < maxRetries; i++) {
    await this._sleep(baseDelay * Math.pow(2, i));
    try {
      // Try to connect to /json/list
      await this.inspector.getWebSocketUrl();
      return 9229;
    } catch {
      // Retry
    }
  }
  throw new Error('Inspector did not start after SIGUSR1');
}
\`\`\`

## Impact

- More reliable connection on loaded systems
- Better error message when inspector truly fails to start`,
    labels: ['enhancement'],
  },
  {
    title: 'Feature: Support profiling Node.js worker threads',
    body: `## Description

The tool can only profile the main thread. Node.js \`worker_threads\` have their own V8 instances and can also cause performance issues.

## Background

When connecting to the inspector, \`/json/list\` returns all available targets including worker threads. Currently we always pick \`targets[0]\`.

## Proposed Solution

1. Add \`--list-targets\` to show all available inspector targets (main thread + workers)
2. Add \`--target <id>\` to connect to a specific target
3. Default behavior remains connecting to the main thread

\`\`\`bash
loop-detective --port 9229 --list-targets
# Output:
#   [0] Main thread (default)
#   [1] Worker #1 - worker.js
#   [2] Worker #2 - worker.js

loop-detective --port 9229 --target 1
\`\`\``,
    labels: ['enhancement'],
  },
  {
    title: 'Feature: Add HTML report output',
    body: `## Description

The terminal output is useful for quick diagnosis but hard to share with team members or attach to incident reports.

## Proposed Solution

Add a \`--html <path>\` option that generates a self-contained HTML report:

\`\`\`bash
loop-detective 12345 --html report.html
\`\`\`

The HTML report could include:
- Interactive sortable table for heavy functions
- Expandable/collapsible call stacks
- Visual bar charts for CPU percentages
- Timeline of lag events
- Slow I/O operations grouped by target
- All data embedded in the HTML (no external dependencies)

## Benefit

- Easy to share via Slack, email, or issue trackers
- Better visualization than terminal output
- Can be archived for post-incident review`,
    labels: ['enhancement'],
  },
  {
    title: 'Improve test coverage — only Analyzer is currently tested',
    body: `## Description

Current test coverage is minimal:
- ✅ \`Analyzer.analyzeProfile\` — 3 test cases
- ❌ \`Inspector\` — 0 tests
- ❌ \`Detective\` — 0 tests
- ❌ \`Reporter\` — 0 tests
- ❌ CLI arg parser — 0 tests

## Proposed Improvements

### Easy wins (no real Node.js target needed):

1. **Reporter tests** — call \`onLag\`, \`onSlowIO\`, \`onProfile\` with mock data, capture stdout, verify output format
2. **CLI arg parser tests** — test \`parseCliArgs\` with various argument combinations
3. **Inspector unit tests** — mock WebSocket, test \`send()\` timeout behavior, \`disconnect()\` cleanup

### Integration tests (need a real target):

4. **End-to-end test** — start the blocking-app fixture with \`--inspect\`, run Detective against it, verify lag and heavy functions are detected
5. **I/O tracking test** — start a fixture that makes slow HTTP calls, verify slowIO events are emitted

### Infrastructure:

6. Consider adopting a test framework (e.g., \`node:test\` built-in, or \`vitest\`)
7. Add CI via GitHub Actions`,
    labels: ['testing', 'good first issue'],
  },
];

async function createIssue(issue) {
  const data = JSON.stringify({
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/issues`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'User-Agent': 'node-loop-detective-issue-creator',
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github+json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 201) {
            const result = JSON.parse(body);
            resolve(result);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function createLabels() {
  const labels = [
    { name: 'bug', color: 'd73a4a', description: 'Something isn\'t working' },
    { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
    { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
    { name: 'testing', color: 'e4e669', description: 'Testing improvements' },
    { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  ];

  for (const label of labels) {
    const data = JSON.stringify(label);
    try {
      await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'api.github.com',
            path: `/repos/${REPO}/labels`,
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${TOKEN}`,
              'User-Agent': 'node-loop-detective-issue-creator',
              'Content-Type': 'application/json',
              'Accept': 'application/vnd.github+json',
              'Content-Length': Buffer.byteLength(data),
            },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve(res.statusCode));
          }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
      });
    } catch {
      // Label may already exist
    }
  }
}

async function main() {
  console.log('Creating labels...');
  await createLabels();
  console.log('Labels ready.\n');

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    try {
      const result = await createIssue(issue);
      console.log(`✔ #${result.number} ${issue.title}`);
    } catch (err) {
      console.error(`✖ Failed: ${issue.title} — ${err.message}`);
    }
    // Rate limit: wait 1s between requests
    if (i < issues.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
