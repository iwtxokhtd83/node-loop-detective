#!/usr/bin/env node
'use strict';

const https = require('https');

const REPO = 'iwtxokhtd83/node-loop-detective';
const TOKEN = process.env.GITHUB_TOKEN;

const release = {
  tag_name: 'v1.2.0',
  name: 'v1.2.0 — Bug Fixes: Stability & Cleanup',
  body: `## Bug Fixes

This release resolves all 7 reported bug issues, significantly improving stability and correctness.

### #1 — I/O monkey-patches are now restored on cleanup
Previously, after loop-detective disconnected, the patched \`http.request\`, \`dns.lookup\`, and \`net.Socket.connect\` remained in the target process permanently. Now all original functions are stored and fully restored when cleanup runs.

### #2 — Watch mode no longer silently dies on errors
\`_watchMode\` now wraps each profiling cycle in try/catch. Errors are emitted via the \`error\` event and the watch loop continues instead of silently stopping.

### #3 — stop() is now idempotent
Added a \`_stopping\` guard flag so \`stop()\` can be safely called multiple times (e.g., from both SIGINT handler and the finally block) without race conditions or double-disconnect errors.

### #4 — Inspector timeout leaks fixed
CDP command timeouts are now stored alongside callbacks. Timeouts are cleared when a response arrives. On disconnect, all pending timeouts are cleared and callbacks are rejected with a clear error message.

### #5 — Call stacks now use node ID instead of function name matching
\`_buildCallStacks\` previously searched for nodes by matching function name + URL + line number, which could produce wrong stacks for minified code or same-named functions. Now uses the V8 profile node ID directly for accurate results.

### #6 — Lag stack trace limitation documented
The \`setInterval\`-based lag detector captures the timer callback's stack, not the blocking code's stack (which has already finished by the time the timer fires). This limitation is now clearly documented. The CPU profile analysis (heavy functions + call stacks) remains the reliable source for identifying blocking code.

### #7 — http.get patching fixed
The patched \`http.get\` previously reimplemented the function via \`mod.request() + req.end()\`, which could break argument handling. Now wraps the original \`http.get\` directly, preserving its exact behavior while adding timing.

---

## Upgrade

\`\`\`bash
npm install -g node-loop-detective@1.2.0
\`\`\`

**Full Changelog**: https://github.com/iwtxokhtd83/node-loop-detective/compare/v1.1.0...v1.2.0`,
  draft: false,
  prerelease: false,
};

const data = JSON.stringify(release);
const req = https.request({
  hostname: 'api.github.com',
  path: `/repos/${REPO}/releases`,
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'User-Agent': 'node-loop-detective',
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.github+json',
    'Content-Length': Buffer.byteLength(data),
  },
}, (res) => {
  let body = '';
  res.on('data', (chunk) => (body += chunk));
  res.on('end', () => {
    if (res.statusCode === 201) {
      const result = JSON.parse(body);
      console.log(`✔ Release created: ${result.name}`);
      console.log(`  ${result.html_url}`);
    } else {
      console.error(`✖ Failed (HTTP ${res.statusCode}): ${body}`);
    }
  });
});
req.on('error', console.error);
req.write(data);
req.end();
