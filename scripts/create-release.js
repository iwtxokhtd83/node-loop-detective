#!/usr/bin/env node
'use strict';

const https = require('https');

const REPO = 'iwtxokhtd83/node-loop-detective';
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('Error: Set GITHUB_TOKEN environment variable.');
  process.exit(1);
}

const release = {
  tag_name: 'v1.1.0',
  name: 'v1.1.0 — Slow Async I/O Tracking',
  body: `## What's New

### 🌐 Slow Async I/O Tracking

loop-detective can now detect slow network operations that don't block the event loop but cause application-level latency. This is a major addition — previously the tool only caught CPU-bound blocking.

**What it tracks:**
- **HTTP/HTTPS** — outgoing requests with method, target, status code, duration
- **DNS** — lookup resolution time per hostname
- **TCP** — connection time to any host:port (databases, Redis, message queues, etc.)

Every slow I/O event includes the caller stack trace so you know exactly which code initiated it.

\`\`\`
🌐 Slow HTTP: 2340ms GET api.example.com/users → 200
    at processRequest (/app/handlers.js:45:12)
🔌 Slow TCP: 1520ms db-server:3306
    at createConnection (/app/db.js:12:5)

⚠ Slow Async I/O Summary
  Total slow ops: 3
  🌐 HTTP — 2 slow ops, avg 1800ms, max 2340ms
    GET api.example.com/users
      2 calls, total 3600ms, avg 1800ms, max 2340ms
\`\`\`

### New CLI Option

| Flag | Description | Default |
|------|-------------|---------|
| \`--io-threshold <ms>\` | Slow I/O threshold | 500 |

### Programmatic API

\`\`\`javascript
detective.on('slowIO', (data) => {
  // data.type: 'http' | 'dns' | 'tcp'
  // data.target, data.duration, data.stack, ...
});
\`\`\`

---

## Previous Releases in This Changelog

### v1.0.2 — Lag Event Call Stacks
- Lag detector now captures JS call stacks when event loop lag is detected
- Report aggregates lag events by code location (function + file + line)

### v1.0.1 — Node.js 16 Compatibility
- Replaced \`node:util.parseArgs\` (Node 18.3+) with a manual arg parser
- Works on Node.js 16+

### v1.0.0 — Initial Release
- CLI tool: \`loop-detective <pid>\` to profile any running Node.js process
- Connects via V8 Inspector Protocol (SIGUSR1 activation, no restart needed)
- Detects 6 blocking patterns: cpu-hog, json-heavy, regex, gc-pressure, sync-io, crypto
- Reports blocking functions with file paths, line numbers, and call stacks
- Supports \`--watch\` mode, \`--json\` output, and programmatic API

---

## Install / Upgrade

\`\`\`bash
npm install -g node-loop-detective@1.1.0
\`\`\`

**Full Changelog**: https://github.com/iwtxokhtd83/node-loop-detective/compare/v1.0.0...v1.1.0`,
  draft: false,
  prerelease: false,
  generate_release_notes: false,
};

const data = JSON.stringify(release);

const req = https.request(
  {
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
  },
  (res) => {
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
  }
);
req.on('error', console.error);
req.write(data);
req.end();
