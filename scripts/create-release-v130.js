#!/usr/bin/env node
'use strict';

const https = require('https');

const REPO = 'iwtxokhtd83/node-loop-detective';
const TOKEN = process.env.GITHUB_TOKEN;

const release = {
  tag_name: 'v1.3.0',
  name: 'v1.3.0 — Remote Inspector Connections',
  body: `## What's New

### Remote Inspector Support (closes #8)

You can now connect to Node.js inspector endpoints on remote machines — Docker containers, Kubernetes pods, remote servers, and more.

\`\`\`bash
# Docker container with exposed inspector port
loop-detective --host 192.168.1.100 --port 9229

# Kubernetes pod via port-forward
kubectl port-forward pod/my-app 9229:9229
loop-detective --port 9229

# Remote server
loop-detective -H 10.0.0.5 -P 9229 -d 30
\`\`\`

### New CLI Option

| Flag | Description | Default |
|------|-------------|---------|
| \`-H, --host <host>\` | Inspector host for remote connections | 127.0.0.1 |

### Security

A warning is automatically printed when connecting to a non-localhost address, since the CDP protocol has no built-in authentication.

### Programmatic API

\`\`\`javascript
const detective = new Detective({
  inspectorHost: '192.168.1.100',
  inspectorPort: 9229,
  duration: 10000,
});
\`\`\`

---

## Upgrade

\`\`\`bash
npm install -g node-loop-detective@1.3.0
\`\`\`

**Full Changelog**: https://github.com/iwtxokhtd83/node-loop-detective/compare/v1.2.0...v1.3.0`,
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
