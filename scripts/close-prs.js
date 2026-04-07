#!/usr/bin/env node
'use strict';

const https = require('https');

const REPO = 'iwtxokhtd83/node-loop-detective';
const TOKEN = process.env.GITHUB_TOKEN;

const prs = [
  { number: 17, comment: 'Closing — this fix is included in v1.2.0 (commit 9487f98) which resolved all 7 bug issues directly on main. See release notes: https://github.com/iwtxokhtd83/node-loop-detective/releases/tag/v1.2.0' },
  { number: 18, comment: 'Closing — the `--no-io` flag was not included in the v1.2.0 bug fix batch, but the underlying I/O tracking has been significantly improved (original functions are now restored on cleanup). This feature request is tracked in issue #11 and can be revisited as a separate PR.' },
];

function apiRequest(method, path, body) {
  const data = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'User-Agent': 'node-loop-detective',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let resBody = '';
      res.on('data', (chunk) => (resBody += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: resBody }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  for (const pr of prs) {
    // Add a comment explaining why
    const commentRes = await apiRequest('POST', `/repos/${REPO}/issues/${pr.number}/comments`, { body: pr.comment });
    if (commentRes.status === 201) {
      console.log(`  ✔ Commented on PR #${pr.number}`);
    } else {
      console.error(`  ✖ Comment failed on #${pr.number}: ${commentRes.body}`);
    }

    // Close the PR
    const closeRes = await apiRequest('PATCH', `/repos/${REPO}/pulls/${pr.number}`, { state: 'closed' });
    if (closeRes.status === 200) {
      console.log(`  ✔ Closed PR #${pr.number}`);
    } else {
      console.error(`  ✖ Close failed on #${pr.number}: ${closeRes.body}`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('\nDone!');
}

main().catch(console.error);
