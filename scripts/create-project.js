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
  // Step 1: Get the owner (user) ID
  console.log('Fetching user ID...');
  const userData = await graphql(`
    query {
      user(login: "${OWNER}") {
        id
      }
    }
  `);
  const ownerId = userData.user.id;
  console.log(`  Owner ID: ${ownerId}`);

  // Step 2: Create the project
  console.log('\nCreating project...');
  const projectData = await graphql(`
    mutation($ownerId: ID!) {
      createProjectV2(input: {
        ownerId: $ownerId,
        title: "node-loop-detective Roadmap"
      }) {
        projectV2 {
          id
          number
          url
        }
      }
    }
  `, { ownerId });

  const project = projectData.createProjectV2.projectV2;
  console.log(`✔ Project created: ${project.url}`);

  // Step 3: Get all open issues from the repo
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

  // Step 4: Add each issue to the project
  console.log('\nAdding issues to project...');
  for (const issue of issues) {
    try {
      await graphql(`
        mutation($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: {
            projectId: $projectId,
            contentId: $contentId
          }) {
            item {
              id
            }
          }
        }
      `, { projectId: project.id, contentId: issue.id });
      console.log(`  ✔ #${issue.number} ${issue.title}`);
    } catch (err) {
      console.error(`  ✖ #${issue.number} — ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone! Project: ${project.url}`);
}

main().catch(console.error);
