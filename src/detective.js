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
    this._stopping = false;
    this._lagTimer = null;
    this._ioTimer = null;
  }

  /**
   * Activate the inspector on the target process via SIGUSR1
   */
  _activateInspector() {
    if (this.config.inspectorPort) return;

    const pid = this.config.pid;
    if (!pid) throw new Error('No PID provided');

    try {
      process.kill(pid, 0);
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
    await this._sleep(1000);
    return 9229;
  }

  /**
   * Start event loop lag detection via CDP Runtime.evaluate
   *
   * Note on stack traces (Issue #6): The setInterval callback fires AFTER
   * blocking code has finished, so captureStack() captures the timer's own
   * stack, not the blocking code's stack. The lag event stacks are best-effort
   * context. For accurate blocking code identification, use the CPU profile
   * analysis (heavyFunctions + callStacks) which is based on V8 sampling and
   * reliably identifies the actual blocking functions.
   */
  async _startLagDetection() {
    const script = `
      (function() {
        if (globalThis.__loopDetective) {
          return { alreadyRunning: true };
        }
        const lags = [];
        let lastTime = Date.now();
        const threshold = ${this.config.threshold};

        function captureStack() {
          const orig = Error.stackTraceLimit;
          Error.stackTraceLimit = 20;
          const err = new Error();
          Error.stackTraceLimit = orig;
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
   * Start slow async I/O detection via CDP Runtime.evaluate
   * Monkey-patches http, https, net, dns to track slow operations
   *
   * Fix for Issue #1: Original functions are stored and restored on cleanup.
   * Fix for Issue #7: http.get is wrapped around the original http.get,
   * not reimplemented via mod.request + req.end().
   */
  async _startAsyncIOTracking() {
    const ioThreshold = this.config.ioThreshold || 500;

    const script = `
      (function() {
        if (globalThis.__loopDetectiveIO) {
          return { alreadyRunning: true };
        }

        const slowOps = [];
        const threshold = ${ioThreshold};
        const originals = {};

        function captureCallerStack() {
          const origLimit = Error.stackTraceLimit;
          Error.stackTraceLimit = 10;
          const stackErr = new Error();
          Error.stackTraceLimit = origLimit;
          return (stackErr.stack || '').split('\\n').slice(2, 6).map(l => l.trim());
        }

        function recordSlowOp(op) {
          slowOps.push(op);
          if (slowOps.length > 200) slowOps.shift();
        }

        // --- Track outgoing HTTP/HTTPS requests ---
        function patchHttp(modName) {
          let mod;
          try { mod = require(modName); } catch { return; }
          const origRequest = mod.request;
          const origGet = mod.get;
          originals[modName + '.request'] = { mod, key: 'request', fn: origRequest };
          originals[modName + '.get'] = { mod, key: 'get', fn: origGet };

          mod.request = function patchedRequest(...args) {
            const startTime = Date.now();
            const opts = typeof args[0] === 'string' ? { href: args[0] } : (args[0] || {});
            const target = opts.href || opts.hostname || opts.host || 'unknown';
            const method = (opts.method || 'GET').toUpperCase();
            const callerStack = captureCallerStack();

            const req = origRequest.apply(this, args);

            req.on('response', (res) => {
              const duration = Date.now() - startTime;
              if (duration >= threshold) {
                recordSlowOp({
                  type: 'http', protocol: modName, method, target,
                  statusCode: res.statusCode, duration, timestamp: Date.now(), stack: callerStack,
                });
              }
            });

            req.on('error', (err) => {
              const duration = Date.now() - startTime;
              if (duration >= threshold) {
                recordSlowOp({
                  type: 'http', protocol: modName, method, target,
                  error: err.message, duration, timestamp: Date.now(), stack: callerStack,
                });
              }
            });

            return req;
          };

          // Fix #7: Wrap original http.get instead of reimplementing
          mod.get = function patchedGet(...args) {
            return origGet.apply(this, args);
          };
          // Add timing to get as well
          const wrappedGet = mod.get;
          mod.get = function patchedGetWithTiming(...args) {
            const startTime = Date.now();
            const opts = typeof args[0] === 'string' ? { href: args[0] } : (args[0] || {});
            const target = opts.href || opts.hostname || opts.host || 'unknown';
            const callerStack = captureCallerStack();

            const req = origGet.apply(this, args);

            req.on('response', (res) => {
              const duration = Date.now() - startTime;
              if (duration >= threshold) {
                recordSlowOp({
                  type: 'http', protocol: modName, method: 'GET', target,
                  statusCode: res.statusCode, duration, timestamp: Date.now(), stack: callerStack,
                });
              }
            });

            req.on('error', (err) => {
              const duration = Date.now() - startTime;
              if (duration >= threshold) {
                recordSlowOp({
                  type: 'http', protocol: modName, method: 'GET', target,
                  error: err.message, duration, timestamp: Date.now(), stack: callerStack,
                });
              }
            });

            return req;
          };
          originals[modName + '.get'].fn = origGet;
        }

        patchHttp('http');
        patchHttp('https');

        // --- Track DNS lookups (callback API) ---
        (function patchDns() {
          let dns;
          try { dns = require('dns'); } catch { return; }
          const origLookup = dns.lookup;
          originals['dns.lookup'] = { mod: dns, key: 'lookup', fn: origLookup };

          dns.lookup = function patchedLookup(hostname, options, callback) {
            const startTime = Date.now();
            if (typeof options === 'function') {
              callback = options;
              options = {};
            }
            const callerStack = captureCallerStack();

            return origLookup.call(dns, hostname, options, function(err, address, family) {
              const duration = Date.now() - startTime;
              if (duration >= threshold) {
                recordSlowOp({
                  type: 'dns', target: hostname, duration,
                  error: err ? err.message : null, timestamp: Date.now(), stack: callerStack,
                });
              }
              if (callback) callback(err, address, family);
            });
          };

          // --- Track DNS lookups (promise API, Node.js 10.6+) ---
          if (dns.promises && dns.promises.lookup) {
            const origPromiseLookup = dns.promises.lookup;
            originals['dns.promises.lookup'] = { mod: dns.promises, key: 'lookup', fn: origPromiseLookup };

            dns.promises.lookup = function patchedPromiseLookup(hostname, options) {
              const startTime = Date.now();
              const callerStack = captureCallerStack();

              return origPromiseLookup.call(dns.promises, hostname, options).then(
                (result) => {
                  const duration = Date.now() - startTime;
                  if (duration >= threshold) {
                    recordSlowOp({
                      type: 'dns', target: hostname, duration,
                      timestamp: Date.now(), stack: callerStack,
                    });
                  }
                  return result;
                },
                (err) => {
                  const duration = Date.now() - startTime;
                  if (duration >= threshold) {
                    recordSlowOp({
                      type: 'dns', target: hostname, duration,
                      error: err.message, timestamp: Date.now(), stack: callerStack,
                    });
                  }
                  throw err;
                }
              );
            };
          }
        })();

        // --- Track TCP socket connections ---
        (function patchNet() {
          let net;
          try { net = require('net'); } catch { return; }
          const origConnect = net.Socket.prototype.connect;
          originals['net.Socket.connect'] = { mod: net.Socket.prototype, key: 'connect', fn: origConnect };

          net.Socket.prototype.connect = function patchedConnect(...args) {
            const startTime = Date.now();
            const opts = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
            const target = (opts.host || '127.0.0.1') + ':' + (opts.port || '?');
            const callerStack = captureCallerStack();

            this.once('connect', () => {
              const duration = Date.now() - startTime;
              if (duration >= threshold) {
                recordSlowOp({ type: 'tcp', target, duration, timestamp: Date.now(), stack: callerStack });
              }
            });

            this.once('error', (err) => {
              const duration = Date.now() - startTime;
              if (duration >= threshold) {
                recordSlowOp({ type: 'tcp', target, error: err.message, duration, timestamp: Date.now(), stack: callerStack });
              }
            });

            return origConnect.apply(this, args);
          };
        })();

        // --- Track global fetch() (Node.js 18+) ---
        (function patchFetch() {
          if (typeof globalThis.fetch !== 'function') return;
          const origFetch = globalThis.fetch;
          originals['globalThis.fetch'] = { mod: globalThis, key: 'fetch', fn: origFetch };

          globalThis.fetch = function patchedFetch(input, init) {
            const startTime = Date.now();
            const callerStack = captureCallerStack();

            // Extract target URL
            let target = 'unknown';
            let method = 'GET';
            if (typeof input === 'string') {
              target = input;
            } else if (input && typeof input === 'object') {
              target = input.url || input.href || String(input);
              method = (input.method || 'GET').toUpperCase();
            }
            if (init && init.method) {
              method = init.method.toUpperCase();
            }
            // Shorten target for display
            try {
              const u = new URL(target);
              target = u.host + u.pathname;
            } catch {}

            return origFetch.call(this, input, init).then(
              (res) => {
                const duration = Date.now() - startTime;
                if (duration >= threshold) {
                  recordSlowOp({
                    type: 'fetch', method, target,
                    statusCode: res.status, duration, timestamp: Date.now(), stack: callerStack,
                  });
                }
                return res;
              },
              (err) => {
                const duration = Date.now() - startTime;
                if (duration >= threshold) {
                  recordSlowOp({
                    type: 'fetch', method, target,
                    error: err.message, duration, timestamp: Date.now(), stack: callerStack,
                  });
                }
                throw err;
              }
            );
          };
        })();

        globalThis.__loopDetectiveIO = {
          getSlowOps: () => slowOps.splice(0),
          cleanup: () => {
            // Restore all original functions
            for (const entry of Object.values(originals)) {
              entry.mod[entry.key] = entry.fn;
            }
            delete globalThis.__loopDetectiveIO;
          }
        };

        return { started: true };
      })()
    `;

    const result = await this.inspector.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      this.emit('error', new Error(`Failed to inject I/O tracker (non-fatal): ${JSON.stringify(result.exceptionDetails)}`));
      return;
    }

    this._ioTimer = setInterval(async () => {
      if (!this._running) return;
      try {
        const pollResult = await this.inspector.send('Runtime.evaluate', {
          expression: 'globalThis.__loopDetectiveIO ? globalThis.__loopDetectiveIO.getSlowOps() : []',
          returnByValue: true,
        });
        const ops = pollResult.result?.value || [];
        for (const op of ops) {
          this.emit('slowIO', op);
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
   * Clean up the injected lag detector and I/O tracker
   */
  async _cleanupInjectedCode() {
    try {
      await this.inspector.send('Runtime.evaluate', {
        expression: 'globalThis.__loopDetective && globalThis.__loopDetective.cleanup()',
        returnByValue: true,
      });
    } catch { /* best effort */ }
    try {
      await this.inspector.send('Runtime.evaluate', {
        expression: 'globalThis.__loopDetectiveIO && globalThis.__loopDetectiveIO.cleanup()',
        returnByValue: true,
      });
    } catch { /* best effort */ }
  }

  /**
   * Start the detective
   */
  async start() {
    this._running = true;
    this._stopping = false;

    this._activateInspector();
    const port = await this._findInspectorPort();

    this.inspector = new Inspector({ host: this.config.inspectorHost, port });
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
      await this._startLagDetection();
      if (!this.config.noIO) {
        await this._startAsyncIOTracking();
      }

      const profile = await this._captureProfile(this.config.duration);
      const analysis = this.analyzer.analyzeProfile(profile);
      this.emit('profile', analysis, profile);
    } finally {
      await this.stop();
    }
  }

  /**
   * Fix for Issue #2: Wrap runCycle in try/catch, emit errors,
   * and continue the watch loop.
   */
  async _watchMode() {
    await this._startLagDetection();
    if (!this.config.noIO) {
      await this._startAsyncIOTracking();
    }

    const runCycle = async () => {
      if (!this._running) return;

      try {
        const profile = await this._captureProfile(this.config.duration);
        const analysis = this.analyzer.analyzeProfile(profile);
        this.emit('profile', analysis, profile);
      } catch (err) {
        this.emit('error', err);
      }

      if (this._running) {
        setTimeout(runCycle, 1000);
      }
    };

    // Await the first cycle and catch its errors
    await runCycle();
  }

  /**
   * Stop the detective and clean up.
   * Fix for Issue #3: Idempotent — safe to call multiple times.
   */
  async stop() {
    if (this._stopping) return;
    this._stopping = true;
    this._running = false;

    if (this._lagTimer) {
      clearInterval(this._lagTimer);
      this._lagTimer = null;
    }

    if (this._ioTimer) {
      clearInterval(this._ioTimer);
      this._ioTimer = null;
    }

    if (this.inspector) {
      await this._cleanupInjectedCode();
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
