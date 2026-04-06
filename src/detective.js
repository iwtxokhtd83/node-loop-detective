'use strict';

const { EventEmitter } = require('node:events');
const { Inspector } = require('./inspector');
const { Analyzer } = require('./analyzer');

class Detective extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.inspector = null;
    this.analyzer = new Analyzer(config);
    this._running = false;
    this._lagTimer = null;
  }

  /**
   * Activate the inspector on the target process via SIGUSR1
   */
  _activateInspector() {
    if (this.config.inspectorPort) return; // already specified

    const pid = this.config.pid;
    if (!pid) throw new Error('No PID provided');

    try {
      process.kill(pid, 0); // check process exists
    } catch (err) {
      throw new Error(`Process ${pid} not found or not accessible: ${err.message}`);
    }

    try {
      process.kill(pid, 'SIGUSR1');
    } catch (err) {
      throw new Error(
        `Failed to send SIGUSR1 to process ${pid}: ${err.message}\n` +
        'Try running with elevated permissions, or start the target with --inspect'
      );
    }
  }

  /**
   * Discover which port the inspector opened on
   */
  async _findInspectorPort() {
    if (this.config.inspectorPort) return this.config.inspectorPort;

    // After SIGUSR1, Node.js opens inspector on 9229 by default
    // Give it a moment to start
    await this._sleep(1000);
    return 9229;
  }

  /**
   * Start event loop lag detection via CDP Runtime.evaluate
   * We inject a tiny lag-measuring snippet into the target process
   */
  async _startLagDetection() {
    // Inject a lag detector that also captures stack traces
    const script = `
      (function() {
        if (globalThis.__loopDetective) {
          return { alreadyRunning: true };
        }
        const lags = [];
        let lastTime = Date.now();
        const threshold = ${this.config.threshold};

        // Capture stack trace at the point of lag detection
        function captureStack() {
          const orig = Error.stackTraceLimit;
          Error.stackTraceLimit = 20;
          const err = new Error();
          Error.stackTraceLimit = orig;
          // Parse the stack into structured frames
          const frames = (err.stack || '').split('\\n').slice(2).map(line => {
            const m = line.match(/at\\s+(?:(.+?)\\s+\\()?(.+?):(\\d+):(\\d+)\\)?/);
            if (m) return { fn: m[1] || '(anonymous)', file: m[2], line: +m[3], col: +m[4] };
            const m2 = line.match(/at\\s+(.+)/);
            if (m2) return { fn: m2[1], file: '', line: 0, col: 0 };
            return null;
          }).filter(Boolean).filter(f =>
            !f.file.includes('loopDetective') &&
            !f.fn.includes('Timeout.') &&
            !f.file.includes('node:internal')
          );
          return frames;
        }

        const timer = setInterval(() => {
          const now = Date.now();
          const delta = now - lastTime;
          const lag = delta - ${this.config.interval};
          if (lag > threshold) {
            lags.push({ lag, timestamp: now, stack: captureStack() });
            if (lags.length > 100) lags.shift();
          }
          lastTime = now;
        }, ${this.config.interval});

        // Make sure our timer doesn't keep the process alive
        if (timer.unref) timer.unref();

        globalThis.__loopDetective = {
          timer,
          getLags: () => {
            const result = lags.splice(0);
            return result;
          },
          cleanup: () => {
            clearInterval(timer);
            delete globalThis.__loopDetective;
          }
        };
        return { started: true };
      })()
    `;

    await this.inspector.send('Runtime.enable');
    const result = await this.inspector.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`Failed to inject lag detector: ${JSON.stringify(result.exceptionDetails)}`);
    }

    // Poll for lag events
    this._lagTimer = setInterval(async () => {
      if (!this._running) return;
      try {
        const pollResult = await this.inspector.send('Runtime.evaluate', {
          expression: 'globalThis.__loopDetective ? globalThis.__loopDetective.getLags() : []',
          returnByValue: true,
        });
        const lags = pollResult.result?.value || [];
        for (const lag of lags) {
          this.emit('lag', lag);
        }
      } catch {
        // Inspector may have disconnected
      }
    }, 1000);
  }

  /**
   * Take a CPU profile to identify blocking code
   */
  async _captureProfile(duration) {
    await this.inspector.send('Profiler.enable');
    await this.inspector.send('Profiler.setSamplingInterval', { interval: 100 });
    await this.inspector.send('Profiler.start');

    await this._sleep(duration);

    const { profile } = await this.inspector.send('Profiler.stop');
    await this.inspector.send('Profiler.disable');

    return profile;
  }

  /**
   * Clean up the injected lag detector
   */
  async _cleanupLagDetector() {
    try {
      await this.inspector.send('Runtime.evaluate', {
        expression: 'globalThis.__loopDetective && globalThis.__loopDetective.cleanup()',
        returnByValue: true,
      });
    } catch {
      // Best effort cleanup
    }
  }

  /**
   * Start the detective
   */
  async start() {
    this._running = true;

    // Step 1: Activate inspector
    this._activateInspector();
    const port = await this._findInspectorPort();

    // Step 2: Connect
    this.inspector = new Inspector({ port });
    await this.inspector.connect();
    this.emit('connected');

    if (this.config.watch) {
      await this._watchMode();
    } else {
      await this._singleRun();
    }
  }

  async _singleRun() {
    try {
      // Step 3: Start lag detection
      await this._startLagDetection();

      // Step 4: Capture CPU profile
      const profile = await this._captureProfile(this.config.duration);

      // Step 5: Analyze
      const analysis = this.analyzer.analyzeProfile(profile);
      this.emit('profile', analysis);
    } finally {
      await this.stop();
    }
  }

  async _watchMode() {
    await this._startLagDetection();

    const runCycle = async () => {
      if (!this._running) return;

      const profile = await this._captureProfile(this.config.duration);
      const analysis = this.analyzer.analyzeProfile(profile);
      this.emit('profile', analysis);

      if (this._running) {
        setTimeout(runCycle, 1000);
      }
    };

    runCycle();
  }

  /**
   * Stop the detective and clean up
   */
  async stop() {
    this._running = false;

    if (this._lagTimer) {
      clearInterval(this._lagTimer);
      this._lagTimer = null;
    }

    if (this.inspector) {
      await this._cleanupLagDetector();
      await this.inspector.disconnect();
      this.inspector = null;
    }

    this.emit('disconnected');
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { Detective };
