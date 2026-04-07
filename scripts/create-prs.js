#!/usr/bin/env node
'use strict';

const https = require('https');

const REPO = 'iwtxokhtd83/node-loop-detective';
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('Error: Set GITHUB_TOKEN environment variable.');
  process.exit(1);
}

const prs = [
  {
    title: 'fix: clear CDP command timeouts on disconnect and response',
    head: 'fix/inspector-timeout-leak',
    base: 'main',
    body: `## Summary

Fixes #4 — Inspector \`send()\` timeout leaks on disconnect.

## Changes

- Store timeout reference alongside resolve/reject in the callbacks map
- Clear timeout when a CDP response arrives (prevents timer leak)
- On \`disconnect()\`, iterate all pending callbacks: \`clearTimeout\` + \`reject\` with a clear error message
- Prevents dangling timers and ensures all Promises settle on disconnect

## Before

\`\`\`javascript
// Timeout created but never cleared on disconnect
setTimeout(() => { ... }, 30000);
// disconnect() just did _callbacks.clear() — timers kept running
\`\`\`

## After

\`\`\`javascript
// Timeout stored with callback
this._callbacks.set(id, { resolve, reject, timer });
// On response: clearTimeout(timer)
// On disconnect: clearTimeout + reject for every pending callback
\`\`\`

## Testing

- Existing tests pass
- No new dependencies`,
  },
  {
    title: 'feat: add --no-io flag to disable async I/O tracking',
    head: 'feat/no-io-flag',
    base: 'main',
    body: `## Summary

Closes #11 — Add \`--no-io\` flag to disable I/O tracking.

## Motivation

The monkey-patching approach for I/O tracking (patching \`http.request\`, \`dns.lookup\`, \`net.Socket.connect\`) is more invasive than the lag detector or CPU profiler. Some users may want to opt out, especially in sensitive production environments.

## Changes

- New \`--no-io\` boolean CLI flag
- When set, \`_startAsyncIOTracking()\` is skipped entirely
- Lag detection and CPU profiling work normally
- Help text updated

## Usage

\`\`\`bash
# Profile without I/O tracking
loop-detective 12345 --no-io

# Normal (I/O tracking enabled by default)
loop-detective 12345
\`\`\`

## Testing

- Existing tests pass
- No new dependencies`,
  },
];

async function createPR(pr) {
  const data = JSON.stringify({
    title: pr.title,
    head: pr.head,
    base: pr.base,
    body: pr.body,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/pulls`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'User-Agent': 'node-loop-detective',
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
            resolve(JSON.parse(body));
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

async function main() {
  for (const pr of prs) {
    try {
      const result = await createPR(pr);
      console.log(`✔ PR #${result.number}: ${result.title}`);
      console.log(`  ${result.html_url}`);
    } catch (err) {
      console.error(`✖ Failed: ${pr.title} — ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('\nDone!');
}

main().catch(console.error);
