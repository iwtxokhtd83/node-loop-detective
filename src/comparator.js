'use strict';

/**
 * Compare two profiling reports and produce a diff.
 *
 * @param {object} baseline - Previous report (from --json output)
 * @param {object} current  - Current analysis result
 * @returns {object} Comparison result
 */
function compareReports(baseline, current) {
  return {
    summary: compareSummaries(baseline.summary || baseline, current.summary || current),
    functions: compareFunctions(baseline.heavyFunctions || [], current.heavyFunctions || []),
    patterns: comparePatterns(baseline.blockingPatterns || [], current.blockingPatterns || []),
    lagEvents: compareLag(baseline.lagEvents || [], current.lagEvents || []),
    slowIO: compareIO(baseline.slowIOEvents || [], current.slowIOEvents || []),
  };
}

function compareSummaries(b, c) {
  const fields = ['totalDurationMs', 'samplesCount', 'heavyFunctionCount'];
  const result = {};
  for (const f of fields) {
    const bv = b[f] || 0;
    const cv = c[f] || 0;
    result[f] = { before: bv, after: cv, delta: cv - bv };
  }
  return result;
}

function compareFunctions(bFns, cFns) {
  // Key by functionName + url + lineNumber
  const key = (f) => f.functionName + '|' + f.url + ':' + f.lineNumber;

  const bMap = new Map();
  for (const f of bFns) bMap.set(key(f), f);

  const cMap = new Map();
  for (const f of cFns) cMap.set(key(f), f);

  const allKeys = new Set([...bMap.keys(), ...cMap.keys()]);
  const results = [];

  for (const k of allKeys) {
    const b = bMap.get(k);
    const c = cMap.get(k);

    if (b && c) {
      // Exists in both — compare
      const timeDelta = c.selfTimeMs - b.selfTimeMs;
      const pctDelta = c.percentage - b.percentage;
      results.push({
        status: timeDelta < -1 ? 'improved' : timeDelta > 1 ? 'regressed' : 'unchanged',
        functionName: c.functionName,
        url: c.url,
        lineNumber: c.lineNumber,
        before: { selfTimeMs: b.selfTimeMs, percentage: b.percentage },
        after: { selfTimeMs: c.selfTimeMs, percentage: c.percentage },
        delta: { selfTimeMs: Math.round(timeDelta * 100) / 100, percentage: Math.round(pctDelta * 100) / 100 },
      });
    } else if (c && !b) {
      results.push({
        status: 'new',
        functionName: c.functionName,
        url: c.url,
        lineNumber: c.lineNumber,
        before: null,
        after: { selfTimeMs: c.selfTimeMs, percentage: c.percentage },
        delta: null,
      });
    } else if (b && !c) {
      results.push({
        status: 'removed',
        functionName: b.functionName,
        url: b.url,
        lineNumber: b.lineNumber,
        before: { selfTimeMs: b.selfTimeMs, percentage: b.percentage },
        after: null,
        delta: null,
      });
    }
  }

  // Sort: regressed first, then new, then unchanged, then improved, then removed
  const order = { regressed: 0, new: 1, unchanged: 2, improved: 3, removed: 4 };
  results.sort((a, b) => (order[a.status] || 5) - (order[b.status] || 5));

  return results;
}

function comparePatterns(bPats, cPats) {
  const bTypes = new Set(bPats.map(p => p.type));
  const cTypes = new Set(cPats.map(p => p.type));

  const resolved = bPats.filter(p => !cTypes.has(p.type) && p.type !== 'healthy');
  const newIssues = cPats.filter(p => !bTypes.has(p.type) && p.type !== 'healthy');
  const persistent = cPats.filter(p => bTypes.has(p.type) && p.type !== 'healthy');

  return { resolved, newIssues, persistent };
}

function compareLag(bLags, cLags) {
  const bCount = bLags.length;
  const cCount = cLags.length;
  const bMax = bLags.length > 0 ? Math.max(...bLags.map(l => l.lag)) : 0;
  const cMax = cLags.length > 0 ? Math.max(...cLags.map(l => l.lag)) : 0;
  const bAvg = bLags.length > 0 ? Math.round(bLags.reduce((s, l) => s + l.lag, 0) / bLags.length) : 0;
  const cAvg = cLags.length > 0 ? Math.round(cLags.reduce((s, l) => s + l.lag, 0) / cLags.length) : 0;

  return {
    before: { count: bCount, max: bMax, avg: bAvg },
    after: { count: cCount, max: cMax, avg: cAvg },
    delta: { count: cCount - bCount, max: cMax - bMax, avg: cAvg - bAvg },
  };
}

function compareIO(bIO, cIO) {
  const bCount = bIO.length;
  const cCount = cIO.length;
  const bMax = bIO.length > 0 ? Math.max(...bIO.map(o => o.duration)) : 0;
  const cMax = cIO.length > 0 ? Math.max(...cIO.map(o => o.duration)) : 0;

  return {
    before: { count: bCount, maxDuration: bMax },
    after: { count: cCount, maxDuration: cMax },
    delta: { count: cCount - bCount, maxDuration: cMax - bMax },
  };
}

/**
 * Format comparison result for terminal output.
 */
function formatComparison(diff) {
  const lines = [];
  const G = '\x1b[32m'; // green
  const R = '\x1b[31m'; // red
  const Y = '\x1b[33m'; // yellow
  const D = '\x1b[2m';  // dim
  const B = '\x1b[1m';  // bold
  const X = '\x1b[0m';  // reset

  lines.push('');
  lines.push('\u2500'.repeat(60));
  lines.push(B + '  Comparison Report (before → after)' + X);
  lines.push('\u2500'.repeat(60));

  // Patterns
  const p = diff.patterns;
  if (p.resolved.length > 0) {
    lines.push('');
    lines.push('  ' + G + '\u2714 Resolved issues:' + X);
    for (const pat of p.resolved) {
      lines.push('    ' + G + '- ' + pat.type + X + D + ' (' + pat.severity + ')' + X);
    }
  }
  if (p.newIssues.length > 0) {
    lines.push('');
    lines.push('  ' + R + '\u2716 New issues:' + X);
    for (const pat of p.newIssues) {
      lines.push('    ' + R + '+ ' + pat.type + X + ': ' + pat.message);
    }
  }
  if (p.persistent.length > 0) {
    lines.push('');
    lines.push('  ' + Y + '\u25CF Persistent issues:' + X);
    for (const pat of p.persistent) {
      lines.push('    ' + Y + '~ ' + pat.type + X + ': ' + pat.message);
    }
  }
  if (p.resolved.length === 0 && p.newIssues.length === 0 && p.persistent.length === 0) {
    lines.push('');
    lines.push('  ' + G + '\u2714 No blocking patterns in either report' + X);
  }

  // Functions
  const fns = diff.functions;
  const regressed = fns.filter(f => f.status === 'regressed');
  const improved = fns.filter(f => f.status === 'improved');
  const newFns = fns.filter(f => f.status === 'new');

  if (regressed.length > 0 || improved.length > 0 || newFns.length > 0) {
    lines.push('');
    lines.push(B + '  Function Changes' + X);
    lines.push('\u2500'.repeat(60));

    for (const f of regressed.slice(0, 5)) {
      lines.push('  ' + R + '\u25B2' + X + ' ' + f.functionName + '  ' + f.before.selfTimeMs + 'ms \u2192 ' + f.after.selfTimeMs + 'ms ' + R + '(+' + f.delta.selfTimeMs + 'ms)' + X);
      lines.push('    ' + D + f.url + ':' + f.lineNumber + X);
    }
    for (const f of newFns.slice(0, 3)) {
      lines.push('  ' + R + '+' + X + ' ' + f.functionName + '  ' + f.after.selfTimeMs + 'ms (' + f.after.percentage + '%) ' + D + 'NEW' + X);
      lines.push('    ' + D + f.url + ':' + f.lineNumber + X);
    }
    for (const f of improved.slice(0, 5)) {
      lines.push('  ' + G + '\u25BC' + X + ' ' + f.functionName + '  ' + f.before.selfTimeMs + 'ms \u2192 ' + f.after.selfTimeMs + 'ms ' + G + '(' + f.delta.selfTimeMs + 'ms)' + X);
      lines.push('    ' + D + f.url + ':' + f.lineNumber + X);
    }
  }

  // Lag
  const lag = diff.lagEvents;
  lines.push('');
  lines.push(B + '  Event Loop Lag' + X);
  lines.push('\u2500'.repeat(60));
  const lagColor = lag.delta.count <= 0 ? G : R;
  lines.push('  Events: ' + lag.before.count + ' \u2192 ' + lag.after.count + ' ' + lagColor + '(' + (lag.delta.count >= 0 ? '+' : '') + lag.delta.count + ')' + X);
  lines.push('  Max:    ' + lag.before.max + 'ms \u2192 ' + lag.after.max + 'ms');
  lines.push('  Avg:    ' + lag.before.avg + 'ms \u2192 ' + lag.after.avg + 'ms');

  // I/O
  const io = diff.slowIO;
  lines.push('');
  lines.push(B + '  Slow I/O' + X);
  lines.push('\u2500'.repeat(60));
  const ioColor = io.delta.count <= 0 ? G : R;
  lines.push('  Slow ops: ' + io.before.count + ' \u2192 ' + io.after.count + ' ' + ioColor + '(' + (io.delta.count >= 0 ? '+' : '') + io.delta.count + ')' + X);
  lines.push('  Max dur:  ' + io.before.maxDuration + 'ms \u2192 ' + io.after.maxDuration + 'ms');

  // Verdict
  lines.push('');
  lines.push('\u2500'.repeat(60));
  const totalRegressed = regressed.length + newFns.length + p.newIssues.length;
  const totalImproved = improved.length + p.resolved.length;
  if (totalRegressed === 0 && totalImproved > 0) {
    lines.push('  ' + G + B + '\u2714 Overall: IMPROVED' + X + G + ' (' + totalImproved + ' improvements)' + X);
  } else if (totalRegressed > 0 && totalImproved === 0) {
    lines.push('  ' + R + B + '\u2716 Overall: REGRESSED' + X + R + ' (' + totalRegressed + ' regressions)' + X);
  } else if (totalRegressed > 0 && totalImproved > 0) {
    lines.push('  ' + Y + B + '~ Overall: MIXED' + X + Y + ' (' + totalImproved + ' improved, ' + totalRegressed + ' regressed)' + X);
  } else {
    lines.push('  ' + D + '~ Overall: NO SIGNIFICANT CHANGE' + X);
  }
  lines.push('\u2500'.repeat(60));
  lines.push('');

  return lines.join('\n');
}

module.exports = { compareReports, formatComparison };
