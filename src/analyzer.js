'use strict';

class Analyzer {
  constructor(config) {
    this.config = config;
  }

  /**
   * Analyze a V8 CPU profile to find blocking functions
   *
   * V8 CPU profile format:
   * - nodes: array of { id, callFrame: { functionName, url, lineNumber, columnNumber }, hitCount, children }
   * - startTime, endTime: microseconds
   * - samples: array of node IDs (sampled at each tick)
   * - timeDeltas: array of time deltas between samples (microseconds)
   */
  analyzeProfile(profile) {
    const { nodes, samples, timeDeltas, startTime, endTime } = profile;

    const nodeMap = new Map();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    // Calculate total time per node
    const timings = new Map();
    for (let i = 0; i < samples.length; i++) {
      const nodeId = samples[i];
      const delta = timeDeltas[i] || 0;
      timings.set(nodeId, (timings.get(nodeId) || 0) + delta);
    }

    // Build results: find heavy functions
    const totalDuration = endTime - startTime; // microseconds
    const heavyFunctions = [];

    for (const [nodeId, selfTime] of timings) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const { functionName, url, lineNumber, columnNumber } = node.callFrame;

      // Skip internal/idle nodes
      if (!url && !functionName) continue;
      if (functionName === '(idle)' || functionName === '(program)') continue;
      if (functionName === '(garbage collector)') {
        // GC is interesting — keep it
      }

      const selfTimeMs = selfTime / 1000;
      const percentage = totalDuration > 0 ? (selfTime / totalDuration) * 100 : 0;

      if (selfTimeMs < 1) continue; // skip trivial entries

      heavyFunctions.push({
        functionName: functionName || '(anonymous)',
        url: url || '(native)',
        lineNumber: lineNumber + 1, // V8 uses 0-based
        columnNumber: columnNumber + 1,
        selfTimeMs: Math.round(selfTimeMs * 100) / 100,
        percentage: Math.round(percentage * 100) / 100,
      });
    }

    // Sort by self time descending
    heavyFunctions.sort((a, b) => b.selfTimeMs - a.selfTimeMs);

    // Build call tree for the top blockers
    const callStacks = this._buildCallStacks(nodeMap, timings, heavyFunctions.slice(0, 5));

    // Detect event loop blocking patterns
    const blockingPatterns = this._detectPatterns(heavyFunctions, profile);

    return {
      summary: {
        totalDurationMs: Math.round(totalDuration / 1000),
        samplesCount: samples.length,
        heavyFunctionCount: heavyFunctions.length,
      },
      heavyFunctions: heavyFunctions.slice(0, 20),
      callStacks,
      blockingPatterns,
      timestamp: Date.now(),
    };
  }

  /**
   * Build call stacks for the heaviest functions
   */
  _buildCallStacks(nodeMap, timings, topFunctions) {
    const stacks = [];

    // Build parent map
    const parentMap = new Map();
    for (const node of nodeMap.values()) {
      if (node.children) {
        for (const childId of node.children) {
          parentMap.set(childId, node.id);
        }
      }
    }

    for (const fn of topFunctions) {
      // Find the node matching this function
      let targetNode = null;
      for (const node of nodeMap.values()) {
        const cf = node.callFrame;
        if (cf.functionName === fn.functionName &&
            cf.url === (fn.url === '(native)' ? '' : fn.url) &&
            cf.lineNumber === fn.lineNumber - 1) {
          targetNode = node;
          break;
        }
      }

      if (!targetNode) continue;

      // Walk up the call stack
      const stack = [];
      let current = targetNode;
      while (current) {
        const cf = current.callFrame;
        if (cf.functionName || cf.url) {
          stack.push({
            functionName: cf.functionName || '(anonymous)',
            url: cf.url || '(native)',
            lineNumber: cf.lineNumber + 1,
            columnNumber: cf.columnNumber + 1,
          });
        }
        const parentId = parentMap.get(current.id);
        current = parentId ? nodeMap.get(parentId) : null;
      }

      stacks.push({
        target: fn.functionName,
        selfTimeMs: fn.selfTimeMs,
        stack: stack.reverse(),
      });
    }

    return stacks;
  }

  /**
   * Detect common event loop blocking patterns
   */
  _detectPatterns(heavyFunctions, profile) {
    const patterns = [];
    const totalMs = (profile.endTime - profile.startTime) / 1000;

    // Pattern: Single function dominating CPU
    const topFn = heavyFunctions[0];
    if (topFn && topFn.percentage > 50) {
      patterns.push({
        type: 'cpu-hog',
        severity: 'high',
        message: `Function "${topFn.functionName}" consumed ${topFn.percentage}% of CPU time (${topFn.selfTimeMs}ms)`,
        location: `${topFn.url}:${topFn.lineNumber}`,
        suggestion: 'Consider breaking this into smaller async chunks or moving to a worker thread',
      });
    }

    // Pattern: JSON parsing / serialization
    const jsonFns = heavyFunctions.filter(
      (f) => f.functionName.includes('JSON') || f.functionName.includes('parse') || f.functionName.includes('stringify')
    );
    const jsonTime = jsonFns.reduce((sum, f) => sum + f.selfTimeMs, 0);
    if (jsonTime > totalMs * 0.1) {
      patterns.push({
        type: 'json-heavy',
        severity: 'medium',
        message: `JSON operations took ${Math.round(jsonTime)}ms (${Math.round((jsonTime / totalMs) * 100)}% of profile)`,
        suggestion: 'Consider streaming JSON parsing or processing smaller payloads',
      });
    }

    // Pattern: RegExp heavy
    const regexFns = heavyFunctions.filter(
      (f) => f.functionName.includes('RegExp') || f.functionName.includes('exec') || f.functionName.includes('match')
    );
    const regexTime = regexFns.reduce((sum, f) => sum + f.selfTimeMs, 0);
    if (regexTime > totalMs * 0.1) {
      patterns.push({
        type: 'regex-heavy',
        severity: 'medium',
        message: `RegExp operations took ${Math.round(regexTime)}ms`,
        suggestion: 'Check for catastrophic backtracking in regex patterns. Consider simpler string operations.',
      });
    }

    // Pattern: GC pressure
    const gcFns = heavyFunctions.filter((f) => f.functionName.includes('garbage collector'));
    const gcTime = gcFns.reduce((sum, f) => sum + f.selfTimeMs, 0);
    if (gcTime > totalMs * 0.05) {
      patterns.push({
        type: 'gc-pressure',
        severity: 'medium',
        message: `Garbage collection took ${Math.round(gcTime)}ms (${Math.round((gcTime / totalMs) * 100)}% of profile)`,
        suggestion: 'Reduce object allocations. Reuse buffers. Check for memory leaks.',
      });
    }

    // Pattern: Synchronous file I/O
    const syncFns = heavyFunctions.filter(
      (f) => f.functionName.includes('Sync') || f.url.includes('fs.js') || f.url.includes('node:fs')
    );
    if (syncFns.length > 0) {
      const syncTime = syncFns.reduce((sum, f) => sum + f.selfTimeMs, 0);
      patterns.push({
        type: 'sync-io',
        severity: 'high',
        message: `Synchronous I/O detected: ${syncFns.map((f) => f.functionName).join(', ')} (${Math.round(syncTime)}ms)`,
        suggestion: 'Replace synchronous file operations with async alternatives',
      });
    }

    // Pattern: Crypto operations
    const cryptoFns = heavyFunctions.filter(
      (f) => f.url.includes('crypto') || f.functionName.includes('pbkdf') || f.functionName.includes('hash')
    );
    if (cryptoFns.length > 0) {
      const cryptoTime = cryptoFns.reduce((sum, f) => sum + f.selfTimeMs, 0);
      if (cryptoTime > totalMs * 0.1) {
        patterns.push({
          type: 'crypto-heavy',
          severity: 'medium',
          message: `Crypto operations took ${Math.round(cryptoTime)}ms`,
          suggestion: 'Consider offloading heavy crypto to worker threads',
        });
      }
    }

    if (patterns.length === 0) {
      patterns.push({
        type: 'healthy',
        severity: 'low',
        message: 'No obvious event loop blocking patterns detected in this sample',
        suggestion: 'Try profiling for a longer duration or during peak load',
      });
    }

    return patterns;
  }
}

module.exports = { Analyzer };
