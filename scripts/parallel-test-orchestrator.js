'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUS_RANK = { CRASH: 0, FAIL: 1, PASS: 2 };
const DOT_COLUMNS = 60;

// ── Config validation ─────────────────────────────────────────────────────────

function validateConfig(config) {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('[orchestrator] config must be an object');
  }

  if (!Array.isArray(config.suites)) {
    throw new TypeError('[orchestrator] config.suites must be an array');
  }

  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new TypeError('[orchestrator] config.concurrency must be an integer >= 1');
  }

  if (typeof config.electronBin !== 'string' || config.electronBin.length === 0) {
    throw new TypeError('[orchestrator] config.electronBin must be a non-empty string');
  }

  if (typeof config.testEntry !== 'string' || config.testEntry.length === 0) {
    throw new TypeError('[orchestrator] config.testEntry must be a non-empty string');
  }

  if (config.baseEnv === null || typeof config.baseEnv !== 'object') {
    throw new TypeError('[orchestrator] config.baseEnv must be an object');
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function getSuiteStem(suite) {
  return String(suite).replace(/\.test$/, '');
}

function getStatus(result) {
  if (result.signal !== null || result.exitCode === null || result.exitCode >= 128) {
    return 'CRASH';
  }

  if (result.exitCode === 0) {
    return 'PASS';
  }

  return 'FAIL';
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Dot renderer ──────────────────────────────────────────────────────────────
// Emits .  F  E characters with automatic column wrapping.
// Must only be driven from the main event-loop thread (no concurrent callers).

function createDotRenderer() {
  let col = 0;
  process.stdout.write('  ');

  return {
    emit(char) {
      process.stdout.write(char);
      col++;
      if (col % DOT_COLUMNS === 0) {
        process.stdout.write('\n  ');
      }
    },

    finish() {
      // End whatever partial line the dots were on.
      process.stdout.write('\n');
    },
  };
}

// ── JSON-stream consumer ──────────────────────────────────────────────────────
// Parses Mocha's built-in `json-stream` reporter output line-by-line.
// Lines that are not valid JSON (e.g. test-main startup logs) are silently
// skipped — they will never match the [event, data] array shape.
//
// Mocha json-stream wire format:
//   ["start",  { total }]
//   ["pass",   { title, fullTitle, duration, currentRetry, speed }]
//   ["fail",   { title, fullTitle, err: <message string>, duration, currentRetry }]
//   ["end",    { suites, tests, passes, pending, failures, start, end, duration }]
//
// Note: the "end" payload IS the stats object — there is no nested `.stats` key.

function createJsonStreamConsumer(onPass, onFail) {
  let buffer = '';
  let endStats = null;
  const failures = [];

  function processLine(raw) {
    const line = raw.trim();
    if (line.length === 0) return;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Non-JSON — skip (test-main/mocha-setup diagnostic lines)
    }

    if (!Array.isArray(parsed) || parsed.length < 2) return;

    const [event, data] = parsed;

    if (event === 'pass') {
      onPass(data);
    } else if (event === 'fail') {
      failures.push(data);
      onFail(data);
    } else if (event === 'end') {
      // `data` IS the stats object; it has no nested `.stats` property.
      endStats = (data && typeof data === 'object') ? data : null;
    }
  }

  return {
    processChunk(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        processLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },

    flush() {
      if (buffer.length > 0) {
        processLine(buffer);
        buffer = '';
      }
    },

    getEndStats() { return endStats; },
    getFailures() { return failures; },
  };
}

// ── Process utilities ─────────────────────────────────────────────────────────

function safeKill(child, signal) {
  if (!child) return;

  // Do NOT use child.killed here: it becomes true as soon as a signal is *sent*,
  // not when the process has actually exited. If we checked child.killed, the
  // SIGKILL escalation after the 10s timeout would silently no-op because
  // SIGTERM already set child.killed = true. Instead, use exitCode/signalCode
  // to determine if the process has actually finished.
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    child.kill(signal);
  } catch {
    // Ignore races where the child already exited.
  }
}

function cleanupTempDir(dirPath) {
  fs.rm(
    dirPath,
    { recursive: true, force: true, maxRetries: 3, retryDelay: 100 },
    (error) => {
      if (error) {
        console.error('[orchestrator] Crash cleanup failed for', dirPath, error.message);
      }
    }
  );
}

// ── Worker ────────────────────────────────────────────────────────────────────

function startWorker(config, suite, dotRenderer) {
  const suiteStem = getSuiteStem(suite);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `latentmail-test-${suiteStem}-`));
  const workerEnv = Object.assign({}, config.baseEnv, {
    MOCHA_FILE_FILTER: suite,
    LATENTMAIL_TEST_TEMP_DIR: tempDir,
    // Tell mocha-setup to use the machine-readable reporter so we can parse
    // individual test events without displaying anything to the terminal.
    MOCHA_REPORTER: 'json-stream',
  });

  const startTime = Date.now();

  const child = spawn(String(config.electronBin), ['--no-warnings', config.testEntry], {
    env: workerEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Buffer stderr; shown only when the suite crashes entirely.
  let stderrOutput = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderrOutput += chunk; });

  // Parse json-stream from stdout and drive the dot renderer in real time.
  const consumer = createJsonStreamConsumer(
    () => dotRenderer.emit('.'), // pass
    () => dotRenderer.emit('F'), // fail
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => consumer.processChunk(chunk));

  const done = new Promise((resolve) => {
    let settled = false;

    function finalize(exitCode, signal) {
      if (settled) return;
      settled = true;

      consumer.flush();

      const endStats = consumer.getEndStats();
      const failureDetails = consumer.getFailures();
      const duration = Date.now() - startTime;

      const result = { suite, exitCode, signal, duration, endStats, failureDetails, stderrOutput };

      // Worker crashed before Mocha could emit any test output → show E so
      // the crash is visible in the dots line rather than silently absent.
      if (getStatus(result) === 'CRASH' && endStats === null) {
        dotRenderer.emit('E');
      }

      cleanupTempDir(tempDir);
      resolve(result);
    }

    child.on('close', (exitCode, signal) => finalize(exitCode, signal));
    child.on('error', (error) => {
      stderrOutput += `[orchestrator] Failed to launch worker: ${error.message}\n`;
      finalize(1, null);
    });
  });

  return { child, done };
}

// ── Summary ───────────────────────────────────────────────────────────────────

function printSummary(results, interrupted, interruptSignal, dotRenderer, wallClockMs) {
  dotRenderer.finish();

  const out = (str) => process.stdout.write(str);

  // Helper: write a block of text with a fixed indent prefix on every line.
  function writeIndented(text, prefix) {
    for (const line of text.split('\n')) {
      out(prefix + line + '\n');
    }
  }

  // ── 1. Individual failure details ──────────────────────────────────────────

  const allFailures = [];
  for (const result of results) {
    for (const f of result.failureDetails) {
      allFailures.push({ suite: result.suite, f });
    }
  }

  if (allFailures.length > 0) {
    out('\n  Failures:\n\n');

    for (let i = 0; i < allFailures.length; i++) {
      const { suite, f } = allFailures[i];
      out(`  ${i + 1}) [${getSuiteStem(suite)}] ${f.fullTitle || f.title || '(unknown test)'}\n`);

      // In Mocha's json-stream, `f.err` is the error message string; stack
      // frames are not included in the wire format.
      const msg = typeof f.err === 'string' ? f.err : (f.err?.message ?? '(no message)');
      writeIndented(msg, '     ');
      out('\n');
    }
  }

  // ── 2. Crash stderr output ─────────────────────────────────────────────────

  const crashed = results.filter(
    (r) => getStatus(r) === 'CRASH' && r.stderrOutput.trim().length > 0
  );

  if (crashed.length > 0) {
    out('\n  Crash output:\n\n');
    for (const result of crashed) {
      out(`  [${getSuiteStem(result.suite)}]\n`);
      writeIndented(result.stderrOutput.trim(), '    ');
      out('\n');
    }
  }

  // ── 3. Per-suite table ─────────────────────────────────────────────────────

  const rows = results.map((result) => {
    const status = getStatus(result);
    const stats = result.endStats;
    return {
      suite: getSuiteStem(result.suite),
      status,
      passed: stats ? String(stats.passes) : (status === 'CRASH' ? '—' : '?'),
      failed: stats ? String(stats.failures) : (status === 'CRASH' ? '—' : '?'),
      duration: formatDuration(result.duration),
    };
  });

  rows.sort((a, b) => {
    const d = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    return d !== 0 ? d : a.suite.localeCompare(b.suite);
  });

  const w = {
    suite: Math.max('Suite'.length, ...rows.map((r) => r.suite.length)),
    status: 'Status'.length,
    passed: Math.max('Passed'.length, ...rows.map((r) => r.passed.length)),
    failed: Math.max('Failed'.length, ...rows.map((r) => r.failed.length)),
    duration: Math.max('Time'.length, ...rows.map((r) => r.duration.length)),
  };

  const sep = '  ' + '─'.repeat(w.suite + w.status + w.passed + w.failed + w.duration + 10);

  out(`\n${sep}\n`);
  out(
    '  ' +
    'Suite'.padEnd(w.suite) + '  ' +
    'Status'.padEnd(w.status) + '  ' +
    'Passed'.padEnd(w.passed) + '  ' +
    'Failed'.padEnd(w.failed) + '  ' +
    'Time'.padEnd(w.duration) + '\n'
  );
  out(`${sep}\n`);

  for (const row of rows) {
    out(
      '  ' +
      row.suite.padEnd(w.suite) + '  ' +
      row.status.padEnd(w.status) + '  ' +
      row.passed.padEnd(w.passed) + '  ' +
      row.failed.padEnd(w.failed) + '  ' +
      row.duration.padEnd(w.duration) + '\n'
    );
  }

  out(`${sep}\n`);

  // ── 4. Grand totals ────────────────────────────────────────────────────────

  let totalPassed = 0;
  let totalFailed = 0;
  let totalCrashed = 0;

  for (const result of results) {
    if (getStatus(result) === 'CRASH') {
      totalCrashed++;
    } else {
      const stats = result.endStats;
      totalPassed += stats ? (stats.passes || 0) : 0;
      totalFailed += stats ? (stats.failures || 0) : 0;
    }
  }

  const parts = [
    (totalPassed > 0 || (totalFailed === 0 && totalCrashed === 0)) && `${totalPassed} passed`,
    totalFailed > 0 && `${totalFailed} failed`,
    totalCrashed > 0 && `${totalCrashed} crashed`,
  ].filter(Boolean);

  out('\n');
  out(`  Tests:   ${parts.join(', ')}\n`);
  out(`  Suites:  ${results.length} total\n`);
  out(`  Time:    ${formatDuration(wallClockMs)}\n`);

  if (interrupted) {
    out(`\n  Run interrupted by ${interruptSignal}\n`);
  }

  out('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

module.exports = async function runParallelTests(config) {
  validateConfig(config);

  const suites = config.suites.slice();
  const results = new Array(suites.length);
  const activeWorkers = new Set();

  let nextIndex = 0;
  let interrupted = false;
  let interruptSignal = null;
  let finalized = false;
  let resolveRun;

  const wallClockStart = Date.now();

  // Print a one-line header so the user knows something is happening before
  // any dots appear.
  const suitePlural = suites.length === 1 ? 'suite' : 'suites';
  const workerPlural = config.concurrency === 1 ? 'worker' : 'workers';
  process.stdout.write(
    `\n  Running ${suites.length} ${suitePlural} across ${config.concurrency} ${workerPlural}\n\n`
  );

  const dotRenderer = createDotRenderer();

  function tryFinalizeRun() {
    if (finalized) return;

    const allLaunched = nextIndex === suites.length;
    const allDone = activeWorkers.size === 0;

    if ((interrupted || allLaunched) && allDone) {
      finalized = true;

      const wallClockMs = Date.now() - wallClockStart;
      const completedResults = results.filter((r) => r !== undefined);
      printSummary(completedResults, interrupted, interruptSignal, dotRenderer, wallClockMs);

      resolveRun({ results: completedResults, interrupted, interruptSignal });
    }
  }

  function launchWorkers() {
    while (!interrupted && activeWorkers.size < config.concurrency && nextIndex < suites.length) {
      const suiteIndex = nextIndex;
      const suite = suites[suiteIndex];
      const worker = startWorker(config, suite, dotRenderer);

      nextIndex += 1;
      activeWorkers.add(worker);

      worker.done.then((result) => {
        activeWorkers.delete(worker);
        results[suiteIndex] = result;

        if (!interrupted) {
          launchWorkers();
        }

        tryFinalizeRun();
      });
    }

    tryFinalizeRun();
  }

  async function handleInterrupt(signalName) {
    if (interrupted) return;

    interrupted = true;
    interruptSignal = signalName;

    const initialWorkers = Array.from(activeWorkers);
    for (const worker of initialWorkers) {
      safeKill(worker.child, 'SIGTERM');
    }

    if (initialWorkers.length === 0) {
      tryFinalizeRun();
      return;
    }

    const exitedWithinTimeout = await Promise.race([
      Promise.all(initialWorkers.map((worker) => worker.done.then(() => true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
    ]);

    if (!exitedWithinTimeout) {
      const remainingWorkers = Array.from(activeWorkers);
      for (const worker of remainingWorkers) {
        safeKill(worker.child, 'SIGKILL');
      }

      if (remainingWorkers.length > 0) {
        await Promise.all(remainingWorkers.map((worker) => worker.done.then(() => true)));
      }
    }

    tryFinalizeRun();
  }

  const sigintHandler = () => void handleInterrupt('SIGINT');
  const sigtermHandler = () => void handleInterrupt('SIGTERM');

  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  try {
    return await new Promise((resolve) => {
      resolveRun = resolve;
      launchWorkers();
    });
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
  }
};
