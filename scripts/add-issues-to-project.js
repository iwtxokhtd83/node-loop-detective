#!/usr/bin/env node
'use strict';

const https = require('https');

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'iwtxokhtd83';
const REPO = 'node-loop-detective';

if (!TOKEN) {
  console.error('Error: Set GITHUB_TOKEN environment variable.');
  process.exit(1);
}

function graphql(query, variables = {}) {
  const data = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'User-Agent': 'node-loop-detective',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const result = JSON.parse(body);
          if (result.errors) {
            reject(new Error(JSON.stringify(result.errors, null, 2)));
          } else {
            resolve(result.data);
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
  // Step 1: Find the existing project
  console.log('Finding project...');
  const projData = await graphql(`
    query {
      user(login: "${OWNER}") {
        projectV2(number: 3) {
          id
          title
          url
        }
      }
    }
  `);
  const project = projData.user.projectV2;
  console.log(`  Found: ${project.title} (${project.url})`);

  // Step 2: Get all open issues
  console.log('\nFetching open issues...');
  const issuesData = await graphql(`
    query {
      repository(owner: "${OWNER}", name: "${REPO}") {
        issues(first: 50, states: OPEN) {
          nodes {
            id
            number
            title
          }
        }
      }
    }
  `);
  const issues = issuesData.repository.issues.nodes;
  console.log(`  Found ${issues.length} open issues`);

  // Step 3: Add each issue using addProjectV2ItemById
  console.log('\nAdding issues to project...');
  for (const issue of issues) {
    try {
      await graphql(`
        mutation {
          addProjectV2ItemById(input: {
            projectId: "${project.id}",
            contentId: "${issue.id}"
          }) {
            item {
              id
            }
          }
        }
      `);
      console.log(`  ✔ #${issue.number} ${issue.title}`);
    } catch (err) {
      console.error(`  ✖ #${issue.number} — ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone! Project: ${project.url}`);
}

main().catch(console.error);
