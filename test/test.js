'use strict';

const assert = require('node:assert');
const { Analyzer } = require('../src/analyzer');

// Unit test for the Analyzer with a mock V8 CPU profile
function testAnalyzer() {
  console.log('Testing Analyzer...');

  const analyzer = new Analyzer({ threshold: 50 });

  // Mock V8 CPU profile
  const mockProfile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 }, hitCount: 0, children: [2, 3, 4] },
      { id: 2, callFrame: { functionName: 'heavyComputation', url: '/app/server.js', lineNumber: 9, columnNumber: 0 }, hitCount: 50, children: [] },
      { id: 3, callFrame: { functionName: '(idle)', url: '', lineNumber: 0, columnNumber: 0 }, hitCount: 30, children: [] },
      { id: 4, callFrame: { functionName: 'handleRequest', url: '/app/server.js', lineNumber: 25, columnNumber: 0 }, hitCount: 10, children: [5] },
      { id: 5, callFrame: { functionName: 'JSON.parse', url: '', lineNumber: 0, columnNumber: 0 }, hitCount: 8, children: [] },
    ],
    startTime: 0,
    endTime: 10000000, // 10 seconds in microseconds
    samples: [
      2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // heavyComputation: 10 samples
      2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // heavyComputation: 10 more
      2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // heavyComputation: 10 more
      3, 3, 3, 3, 3, 3, 3, 3, 3, 3, // idle: 10 samples
      4, 4, 4, 4, 4,                 // handleRequest: 5 samples
      5, 5, 5, 5, 5, 5, 5, 5,       // JSON.parse: 8 samples
    ],
    timeDeltas: Array(53).fill(0).map((_, i) => {
      if (i < 30) return 200000;  // heavyComputation: 200ms each = 6000ms total
      if (i < 40) return 100000;  // idle: 100ms each
      if (i < 45) return 50000;   // handleRequest: 50ms each
      return 100000;              // JSON.parse: 100ms each = 300ms
    }),
  };

  const result = analyzer.analyzeProfile(mockProfile);

  // Check summary
  assert.ok(result.summary, 'Should have summary');
  assert.strictEqual(result.summary.totalDurationMs, 10000);
  assert.strictEqual(result.summary.samplesCount, 53);

  // Check heavy functions
  assert.ok(result.heavyFunctions.length > 0, 'Should find heavy functions');
  assert.strictEqual(result.heavyFunctions[0].functionName, 'heavyComputation');
  console.log(`  ✔ Top function: ${result.heavyFunctions[0].functionName} (${result.heavyFunctions[0].selfTimeMs}ms)`);

  // Check patterns
  assert.ok(result.blockingPatterns.length > 0, 'Should detect patterns');
  const cpuHog = result.blockingPatterns.find((p) => p.type === 'cpu-hog');
  assert.ok(cpuHog, 'Should detect CPU hog pattern');
  console.log(`  ✔ Pattern detected: ${cpuHog.type} - ${cpuHog.message}`);

  // Check call stacks
  assert.ok(result.callStacks.length > 0, 'Should have call stacks');
  console.log(`  ✔ Call stacks: ${result.callStacks.length} entries`);

  console.log('  ✔ All Analyzer tests passed\n');
}

function testAnalyzerHealthy() {
  console.log('Testing Analyzer (healthy profile)...');

  const analyzer = new Analyzer({ threshold: 50 });

  const healthyProfile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 }, hitCount: 0, children: [2, 3] },
      { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: 0, columnNumber: 0 }, hitCount: 90, children: [] },
      { id: 3, callFrame: { functionName: 'handleReq', url: '/app/server.js', lineNumber: 5, columnNumber: 0 }, hitCount: 5, children: [] },
    ],
    startTime: 0,
    endTime: 5000000,
    samples: [2, 2, 2, 2, 2, 2, 2, 2, 2, 3],
    timeDeltas: Array(10).fill(500000),
  };

  const result = analyzer.analyzeProfile(healthyProfile);
  const healthy = result.blockingPatterns.find((p) => p.type === 'healthy');
  assert.ok(healthy, 'Should report healthy when no blocking detected');
  console.log(`  ✔ Healthy profile: ${healthy.message}`);
  console.log('  ✔ All healthy profile tests passed\n');
}

function testAnalyzerSyncIO() {
  console.log('Testing Analyzer (sync I/O detection)...');

  const analyzer = new Analyzer({ threshold: 50 });

  const syncProfile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 }, hitCount: 0, children: [2] },
      { id: 2, callFrame: { functionName: 'readFileSync', url: 'node:fs', lineNumber: 100, columnNumber: 0 }, hitCount: 20, children: [] },
    ],
    startTime: 0,
    endTime: 2000000,
    samples: Array(20).fill(2),
    timeDeltas: Array(20).fill(100000),
  };

  const result = analyzer.analyzeProfile(syncProfile);
  const syncIO = result.blockingPatterns.find((p) => p.type === 'sync-io');
  assert.ok(syncIO, 'Should detect sync I/O');
  console.log(`  ✔ Sync I/O detected: ${syncIO.message}`);
  console.log('  ✔ All sync I/O tests passed\n');
}

// Run all tests
try {
  testAnalyzer();
  testAnalyzerHealthy();
  testAnalyzerSyncIO();
  console.log('All tests passed ✔');
} catch (err) {
  console.error('Test failed:', err);
  process.exit(1);
}
