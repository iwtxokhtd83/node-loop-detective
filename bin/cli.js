#!/usr/bin/env node

'use strict';

const { Detective } = require('../src/detective');
const { Reporter } = require('../src/reporter');
const fs = require('node:fs');
const path = require('node:path');

// Simple arg parser compatible with Node.js 16+
function parseCliArgs(argv) {
  const args = argv.slice(2);
  const values = {
    pid: null,
    host: null,
    port: null,
    duration: '10',
    threshold: '50',
    interval: '100',
    'io-threshold': '500',
    'save-profile': null,
    'no-io': false,
    'list-targets': false,
    target: null,
    json: false,
    watch: false,
    help: false,
    version: false,
  };
  const positionals = [];

  const flagMap = {
    '-p': 'pid', '--pid': 'pid',
    '-H': 'host', '--host': 'host',
    '-P': 'port', '--port': 'port',
    '-d': 'duration', '--duration': 'duration',
    '-t': 'threshold', '--threshold': 'threshold',
    '-i': 'interval', '--interval': 'interval',
    '--io-threshold': 'io-threshold',
    '--save-profile': 'save-profile',
    '--target': 'target',
  };
  const boolMap = {
    '-j': 'json', '--json': 'json',
    '-w': 'watch', '--watch': 'watch',
    '--no-io': 'no-io',
    '--list-targets': 'list-targets',
    '-h': 'help', '--help': 'help',
    '-v': 'version', '--version': 'version',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flagMap[arg]) {
      values[flagMap[arg]] = args[++i] || '';
    } else if (boolMap[arg]) {
      values[boolMap[arg]] = true;
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    } else {
      console.error(`Unknown option: ${arg}\n`);
      printUsage();
      process.exit(1);
    }
  }

  return { values, positionals };
}

const { values, positionals } = parseCliArgs(process.argv);

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
  if (!values['list-targets']) {
    console.error('Error: Please provide a target PID or --port\n');
    printUsage();
    process.exit(1);
  }
}

function printUsage() {
  console.log(`
  loop-detective - Detect event loop blocking in running Node.js apps

  USAGE
    loop-detective <pid>
    loop-detective --pid <pid>
    loop-detective --port <inspector-port>
    loop-detective --host <remote-host> --port <inspector-port>

  OPTIONS
    -p, --pid <pid>          Target Node.js process ID
    -H, --host <host>        Inspector host (default: 127.0.0.1)
    -P, --port <port>        Connect to an already-open inspector port
    -d, --duration <sec>     Profiling duration in seconds (default: 10)
    -t, --threshold <ms>     Event loop lag threshold in ms (default: 50)
    -i, --interval <ms>      Sampling interval in ms (default: 100)
    --io-threshold <ms>      Slow I/O threshold in ms (default: 500)
    --save-profile <path>    Save raw CPU profile to .cpuprofile file
    --no-io                  Disable async I/O tracking
    --list-targets           List available inspector targets and exit
    --target <index>         Connect to a specific target (default: 0)
    -j, --json               Output results as JSON
    -w, --watch              Continuous monitoring mode
    -h, --help               Show this help
    -v, --version            Show version

  EXAMPLES
    loop-detective 12345
    loop-detective --pid 12345 --duration 30 --threshold 100
    loop-detective --port 9229 --watch
    loop-detective --host 192.168.1.100 --port 9229
    loop-detective -p 12345 -d 5 -j
    loop-detective --port 9229 --list-targets
    loop-detective --port 9229 --target 1

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
    inspectorHost: values.host || '127.0.0.1',
    inspectorPort,
    duration: parseInt(values.duration, 10) * 1000,
    threshold: parseInt(values.threshold, 10),
    interval: parseInt(values.interval, 10),
    ioThreshold: parseInt(values['io-threshold'], 10),
    saveProfile: values['save-profile'],
    noIO: values['no-io'],
    targetIndex: values.target ? parseInt(values.target, 10) : 0,
    watch: values.watch,
    json: values.json,
  };

  const reporter = new Reporter(config);
  const detective = new Detective(config);

  // Handle --list-targets: list and exit
  if (values['list-targets']) {
    try {
      detective.on('retry', (data) => {
        console.log('  Connecting... attempt ' + data.attempt + '/' + data.maxRetries);
      });
      const targets = await detective.listTargets();
      if (config.json) {
        console.log(JSON.stringify(targets, null, 2));
      } else {
        console.log('\n  Available inspector targets:\n');
        for (const t of targets) {
          const label = t.title || t.url || 'untitled';
          console.log('  [' + t.index + '] ' + label);
          if (t.url) console.log('      ' + t.url);
        }
        console.log('\n  Use --target <index> to connect to a specific target.\n');
      }
    } catch (err) {
      console.error('\n  \x1b[31m✖ ' + err.message + '\x1b[0m\n');
      process.exit(1);
    }
    process.exit(0);
  }

  // Security warning for remote connections
  if (config.inspectorHost !== '127.0.0.1' && config.inspectorHost !== 'localhost') {
    reporter.onInfo(`⚠ Warning: Connecting to remote host ${config.inspectorHost}. The CDP protocol has no authentication — ensure the network is trusted.`);
  }

  detective.on('connected', () => reporter.onConnected());
  detective.on('retry', (data) => {
    reporter.onInfo('  Connecting to inspector... attempt ' + data.attempt + '/' + data.maxRetries + ' (retry in ' + data.delay + 'ms)');
  });
  detective.on('lag', (data) => reporter.onLag(data));
  detective.on('slowIO', (data) => reporter.onSlowIO(data));
  detective.on('profile', (analysis, rawProfile) => {
    reporter.onProfile(analysis);

    // Save raw CPU profile if requested
    if (config.saveProfile && rawProfile) {
      try {
        const filePath = path.resolve(config.saveProfile);
        fs.writeFileSync(filePath, JSON.stringify(rawProfile));
        if (!config.json) {
          console.log(`\n  \x1b[32m✔\x1b[0m CPU profile saved to ${filePath}`);
          console.log(`    Open in Chrome DevTools: Performance tab → Load profile`);
          console.log(`    Or visit https://www.speedscope.app\n`);
        }
      } catch (err) {
        console.error(`\n  \x1b[31m✖ Failed to save profile: ${err.message}\x1b[0m\n`);
      }
    }
  });
  detective.on('error', (err) => reporter.onError(err));
  detective.on('disconnected', () => reporter.onDisconnected());

  let targetExited = false;

  detective.on('targetExit', (data) => {
    targetExited = true;
    if (config.json) {
      console.log(JSON.stringify({ targetExit: true, message: data.message }));
    } else {
      console.log('\n  \x1b[31m✖ ' + data.message + '\x1b[0m');
      console.log('  \x1b[2m  Any lag or I/O events collected before the exit are shown above.\x1b[0m\n');
    }
  });

  process.on('SIGINT', async () => {
    reporter.onInfo('Shutting down...');
    await detective.stop();
    process.exit(0);
  });

  try {
    await detective.start();
    process.exit(targetExited ? 2 : 0);
  } catch (err) {
    reporter.onError(err);
    process.exit(1);
  }
}

main();
