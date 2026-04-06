'use strict';

/**
 * Test fixture: a Node.js app that intentionally blocks the event loop.
 * Used for testing loop-detective.
 *
 * Run with: node --inspect=0 test/fixtures/blocking-app.js
 */

const http = require('node:http');

// Simulate CPU-heavy work
function heavyComputation() {
  let result = 0;
  for (let i = 0; i < 1e7; i++) {
    result += Math.sqrt(i) * Math.sin(i);
  }
  return result;
}

// Simulate JSON parsing of large payload
function heavyJsonWork() {
  const big = Array.from({ length: 10000 }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    nested: { a: i, b: i * 2, c: [i, i + 1, i + 2] },
  }));
  const str = JSON.stringify(big);
  return JSON.parse(str);
}

// Simulate regex backtracking
function heavyRegex() {
  const evilRegex = /^(a+)+$/;
  try {
    evilRegex.test('a'.repeat(25) + 'b');
  } catch {
    // timeout
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/block') {
    const result = heavyComputation();
    res.end(`Computed: ${result}\n`);
  } else if (req.url === '/json') {
    const data = heavyJsonWork();
    res.end(`Parsed ${data.length} items\n`);
  } else if (req.url === '/regex') {
    heavyRegex();
    res.end('Regex done\n');
  } else {
    res.end('OK\n');
  }
});

const port = process.env.PORT || 3333;
server.listen(port, () => {
  console.log(`Blocking test app running on port ${port} (PID: ${process.pid})`);
  console.log('Endpoints: /block, /json, /regex');

  // Periodically do some blocking work to make profiling interesting
  setInterval(() => {
    heavyComputation();
  }, 3000);
});
