#!/usr/bin/env node

'use strict';

const { parseArgs } = require('node:util');
const { Detective } = require('../src/detective');
const { Reporter } = require('../src/reporter');

const options = {
  pid: { type: 'string', short: 'p' },
  port: { type: 'string', short: 'P', default: '' },
  duration: { type: 'string', short: 'd', default: '10' },
  threshold: { type: 'string', short: 't', default: '50' },
  interval: { type: 'string', short: 'i', default: '100' },
  json: { type: 'boolean', short: 'j', default: false },
  watch: { type: 'boolean', short: 'w', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

let parsed;
try {
  parsed = parseArgs({ options, allowPositionals: true });
} catch (err) {
  console.error(`Error: ${err.message}\n`);
  printUsage();
  process.exit(1);
}

const { values, positionals } = parsed;

if (values.version) {
  const pkg = require('../package.json');
  console.log(pkg.version);
  process.exit(0);
}

if (values.help) {
  printUsage();
  process.exit(0);
}

const pid = values.pid || positionals[0];
const inspectorPort = values.port ? parseInt(values.port, 10) : null;

if (!pid && !inspectorPort) {
  console.error('Error: Please provide a target PID or --port\n');
  printUsage();
  process.exit(1);
}

function printUsage() {
  console.log(`
  loop-detective - Detect event loop blocking in running Node.js apps

  USAGE
    loop-detective <pid>
    loop-detective --pid <pid>
    loop-detective --port <inspector-port>

  OPTIONS
    -p, --pid <pid>          Target Node.js process ID
    -P, --port <port>        Connect to an already-open inspector port
    -d, --duration <sec>     Profiling duration in seconds (default: 10)
    -t, --threshold <ms>     Event loop lag threshold in ms (default: 50)
    -i, --interval <ms>      Sampling interval in ms (default: 100)
    -j, --json               Output results as JSON
    -w, --watch              Continuous monitoring mode
    -h, --help               Show this help
    -v, --version            Show version

  EXAMPLES
    loop-detective 12345
    loop-detective --pid 12345 --duration 30 --threshold 100
    loop-detective --port 9229 --watch
    loop-detective -p 12345 -d 5 -j

  HOW IT WORKS
    1. Sends SIGUSR1 to activate the Node.js inspector (or connects to --port)
    2. Connects via Chrome DevTools Protocol (CDP)
    3. Profiles CPU usage and monitors event loop lag
    4. Reports blocking functions with file locations and durations
    5. Disconnects cleanly — zero impact on your running app
  `);
}

async function main() {
  const config = {
    pid: pid ? parseInt(pid, 10) : null,
    inspectorPort,
    duration: parseInt(values.duration, 10) * 1000,
    threshold: parseInt(values.threshold, 10),
    interval: parseInt(values.interval, 10),
    watch: values.watch,
    json: values.json,
  };

  const reporter = new Reporter(config);
  const detective = new Detective(config);

  detective.on('connected', () => reporter.onConnected());
  detective.on('lag', (data) => reporter.onLag(data));
  detective.on('profile', (data) => reporter.onProfile(data));
  detective.on('error', (err) => reporter.onError(err));
  detective.on('disconnected', () => reporter.onDisconnected());

  process.on('SIGINT', async () => {
    reporter.onInfo('Shutting down...');
    await detective.stop();
    process.exit(0);
  });

  try {
    await detective.start();
  } catch (err) {
    reporter.onError(err);
    process.exit(1);
  }
}

main();
