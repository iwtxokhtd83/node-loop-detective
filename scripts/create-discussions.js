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

const discussions = [
  {
    categoryName: 'Announcements',
    title: '🎉 Welcome to node-loop-detective!',
    body: `Hey everyone, welcome to the node-loop-detective community!

## What is this project?

node-loop-detective is a diagnostic tool that attaches to a **running** Node.js process and detects event loop blocking, lag, and slow async I/O — without code changes or restarts.

## What can it do?

- 🔍 Detect event loop blocking and identify the exact function/file/line causing it
- 🌐 Track slow HTTP requests, DNS lookups, and TCP connections
- 📊 Identify 6 common blocking patterns (CPU hog, JSON heavy, RegExp, GC, Sync I/O, Crypto)
- 📍 Provide full call stacks for both blocking events and lag events

## Quick start

\`\`\`bash
npm install -g node-loop-detective
loop-detective <pid>
\`\`\`

## Get involved

- 🐛 Found a bug? [Open an issue](https://github.com/iwtxokhtd83/node-loop-detective/issues)
- 💡 Have an idea? Start a discussion here
- 🔧 Want to contribute? Check out the [good first issues](https://github.com/iwtxokhtd83/node-loop-detective/issues?q=label%3A%22good+first+issue%22)

Looking forward to building this together!`,
  },
  {
    categoryName: 'Ideas',
    title: '💡 What blocking patterns should we detect next?',
    body: `Currently node-loop-detective detects 6 blocking patterns:

| Pattern | Description |
|---------|-------------|
| \`cpu-hog\` | Single function consuming >50% CPU |
| \`json-heavy\` | Excessive JSON parse/stringify |
| \`regex-heavy\` | RegExp backtracking |
| \`gc-pressure\` | High garbage collection time |
| \`sync-io\` | Synchronous file I/O calls |
| \`crypto-heavy\` | CPU-intensive crypto operations |

**What other patterns would be useful to detect?**

Some ideas I've been thinking about:
- **Buffer allocation heavy** — excessive \`Buffer.alloc\` / \`Buffer.from\` calls
- **Promise microtask flooding** — too many resolved promises starving the event loop
- **Tight async loops** — \`while(true) { await something() }\` patterns that never yield
- **Template literal / string concatenation heavy** — building large strings in loops

What patterns have you encountered in production that would be helpful to auto-detect? Share your war stories! 🔥`,
  },
  {
    categoryName: 'Q&A',
    title: '❓ FAQ: Common questions about using loop-detective in production',
    body: `This thread collects frequently asked questions about using loop-detective in production environments. Feel free to ask your own questions below!

---

### Is it safe to use in production?

Yes, with minimal impact:
- **SIGUSR1** only opens the inspector port, virtually no overhead
- **CPU profiling** uses V8's sampling profiler, typical overhead < 5%
- **I/O tracking** adds lightweight monkey-patches, only records operations above threshold
- Everything is cleaned up after profiling

### Does it work with Docker / Kubernetes?

Yes. Either expose the inspector port or run inside the container:
\`\`\`bash
# Expose port
docker run -p 9229:9229 my-app node --inspect=0.0.0.0:9229 app.js
loop-detective --port 9229

# Or run inside container
kubectl exec -it <pod> -- npx loop-detective <pid>
\`\`\`

### Does it work with PM2 / cluster mode?

Yes. Each worker is a separate process:
\`\`\`bash
loop-detective $(pm2 pid app-name)
\`\`\`

### The report says "healthy" but my app is slow?

Check the **Slow Async I/O Summary** section — your bottleneck might be slow database queries or API calls rather than CPU blocking. Try \`--io-threshold 200\` for more sensitive detection.

---

Drop your questions below! 👇`,
  },
];

async function main() {
  // Step 1: Get repo ID and discussion categories
  console.log('Fetching repo info and discussion categories...');
  const repoData = await graphql(`
    query {
      repository(owner: "${OWNER}", name: "${REPO}") {
        id
        discussionCategories(first: 20) {
          nodes {
            id
            name
          }
        }
      }
    }
  `);

  const repoId = repoData.repository.id;
  const categories = repoData.repository.discussionCategories.nodes;
  console.log(`  Repo ID: ${repoId}`);
  console.log(`  Categories: ${categories.map(c => c.name).join(', ')}`);

  // Step 2: Create discussions
  console.log('\nCreating discussions...');
  for (const disc of discussions) {
    const category = categories.find(c => c.name === disc.categoryName);
    if (!category) {
      console.error(`  ✖ Category "${disc.categoryName}" not found, skipping: ${disc.title}`);
      continue;
    }

    try {
      const result = await graphql(`
        mutation {
          createDiscussion(input: {
            repositoryId: "${repoId}",
            categoryId: "${category.id}",
            title: ${JSON.stringify(disc.title)},
            body: ${JSON.stringify(disc.body)}
          }) {
            discussion {
              number
              url
            }
          }
        }
      `);
      const d = result.createDiscussion.discussion;
      console.log(`  ✔ #${d.number} ${disc.title}`);
      console.log(`    ${d.url}`);
    } catch (err) {
      console.error(`  ✖ ${disc.title} — ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('\nDone!');
}

main().catch(console.error);
