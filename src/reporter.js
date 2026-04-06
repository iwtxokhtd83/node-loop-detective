'use strict';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgGreen: '\x1b[42m',
};

class Reporter {
  constructor(config) {
    this.config = config;
    this.lagEvents = [];
  }

  onConnected() {
    if (this.config.json) return;
    this._print(`\n${COLORS.green}✔${COLORS.reset} Connected to Node.js process`);
    this._print(`${COLORS.dim}  Profiling for ${this.config.duration / 1000}s with ${this.config.threshold}ms lag threshold...${COLORS.reset}\n`);
  }

  onLag(data) {
    this.lagEvents.push(data);
    if (this.config.json) return;
    const severity = data.lag > 500 ? COLORS.red : data.lag > 200 ? COLORS.yellow : COLORS.cyan;
    this._print(`${severity}⚠ Event loop lag: ${data.lag}ms${COLORS.reset} ${COLORS.dim}at ${new Date(data.timestamp).toISOString()}${COLORS.reset}`);
  }

  onProfile(analysis) {
    if (this.config.json) {
      this._print(JSON.stringify({ ...analysis, lagEvents: this.lagEvents }, null, 2));
      this.lagEvents = [];
      return;
    }

    this._printSummary(analysis.summary);
    this._printPatterns(analysis.blockingPatterns);
    this._printHeavyFunctions(analysis.heavyFunctions);
    this._printCallStacks(analysis.callStacks);
    this._printLagSummary();

    this.lagEvents = [];
  }

  onError(err) {
    if (this.config.json) {
      this._print(JSON.stringify({ error: err.message }));
    } else {
      this._print(`\n${COLORS.red}✖ Error: ${err.message}${COLORS.reset}`);
    }
  }

  onInfo(msg) {
    if (!this.config.json) {
      this._print(`${COLORS.dim}${msg}${COLORS.reset}`);
    }
  }

  onDisconnected() {
    if (!this.config.json) {
      this._print(`\n${COLORS.green}✔${COLORS.reset} Disconnected cleanly\n`);
    }
  }

  _printSummary(summary) {
    this._print(`\n${'─'.repeat(60)}`);
    this._print(`${COLORS.bold}  Event Loop Detective Report${COLORS.reset}`);
    this._print(`${'─'.repeat(60)}`);
    this._print(`  Duration:  ${summary.totalDurationMs}ms`);
    this._print(`  Samples:   ${summary.samplesCount}`);
    this._print(`  Hot funcs: ${summary.heavyFunctionCount}`);
  }

  _printPatterns(patterns) {
    this._print(`\n${COLORS.bold}  Diagnosis${COLORS.reset}`);
    this._print(`${'─'.repeat(60)}`);

    for (const p of patterns) {
      const icon = p.severity === 'high' ? `${COLORS.bgRed} HIGH ${COLORS.reset}`
        : p.severity === 'medium' ? `${COLORS.bgYellow} MED  ${COLORS.reset}`
        : `${COLORS.bgGreen} LOW  ${COLORS.reset}`;

      this._print(`  ${icon} ${COLORS.bold}${p.type}${COLORS.reset}`);
      this._print(`         ${p.message}`);
      if (p.location) {
        this._print(`         ${COLORS.dim}at ${p.location}${COLORS.reset}`);
      }
      this._print(`         ${COLORS.cyan}→ ${p.suggestion}${COLORS.reset}`);
      this._print('');
    }
  }

  _printHeavyFunctions(functions) {
    if (functions.length === 0) return;

    this._print(`${COLORS.bold}  Top CPU-Heavy Functions${COLORS.reset}`);
    this._print(`${'─'.repeat(60)}`);

    const top = functions.slice(0, 10);
    for (let i = 0; i < top.length; i++) {
      const f = top[i];
      const bar = this._makeBar(f.percentage);
      this._print(`  ${COLORS.bold}${(i + 1).toString().padStart(2)}.${COLORS.reset} ${f.functionName}`);
      this._print(`      ${bar} ${f.selfTimeMs}ms (${f.percentage}%)`);
      this._print(`      ${COLORS.dim}${f.url}:${f.lineNumber}:${f.columnNumber}${COLORS.reset}`);
    }
  }

  _printCallStacks(stacks) {
    if (stacks.length === 0) return;

    this._print(`\n${COLORS.bold}  Call Stacks (top blockers)${COLORS.reset}`);
    this._print(`${'─'.repeat(60)}`);

    for (const s of stacks) {
      this._print(`\n  ${COLORS.yellow}▸ ${s.target}${COLORS.reset} (${s.selfTimeMs}ms)`);
      for (let i = 0; i < s.stack.length; i++) {
        const frame = s.stack[i];
        const indent = '    ' + '  '.repeat(Math.min(i, 5));
        const isTarget = frame.functionName === s.target;
        const color = isTarget ? COLORS.yellow : COLORS.dim;
        this._print(`${indent}${color}${isTarget ? '→' : '│'} ${frame.functionName} ${frame.url}:${frame.lineNumber}${COLORS.reset}`);
      }
    }
  }

  _printLagSummary() {
    if (this.lagEvents.length === 0) {
      this._print(`\n  ${COLORS.green}✔ No event loop lag detected above threshold${COLORS.reset}`);
    } else {
      const maxLag = Math.max(...this.lagEvents.map((e) => e.lag));
      const avgLag = Math.round(this.lagEvents.reduce((s, e) => s + e.lag, 0) / this.lagEvents.length);
      this._print(`\n  ${COLORS.red}⚠ Event Loop Lag Summary${COLORS.reset}`);
      this._print(`    Events: ${this.lagEvents.length}`);
      this._print(`    Max:    ${maxLag}ms`);
      this._print(`    Avg:    ${avgLag}ms`);
    }

    this._print(`\n${'─'.repeat(60)}\n`);
  }

  _makeBar(percentage) {
    const width = 20;
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    const color = percentage > 50 ? COLORS.red : percentage > 20 ? COLORS.yellow : COLORS.green;
    return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)}${COLORS.reset}`;
  }

  _print(msg) {
    console.log(msg);
  }
}

module.exports = { Reporter };
