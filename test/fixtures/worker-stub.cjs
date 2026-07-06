#!/usr/bin/env node
/**
 * Stub NIGHTSHIFT_AGENT_BIN for job-runner tests: stands in for a `claude`
 * WORKER session. The runner invokes `<bin> -p <prompt> --session-id <uuid>`
 * with cwd = the job's workdir and env = workerEnv(). Because that env is
 * default-deny, ALL control comes from the prompt text (env knobs would defeat
 * the very seam under test):
 *
 *   MODE=success           write a valid success sentinel, exit 0 (default)
 *   MODE=no-sentinel       exit 0 WITHOUT a sentinel (clean exit ≠ success)
 *   MODE=exit-nonzero      exit 3, no sentinel
 *   MODE=failure-sentinel  write a status:'failure' sentinel, exit 0
 *   MODE=malformed-sentinel  write invalid JSON at the sentinel path, exit 0
 *   MODE=dump-env          write process.env to worker-env.json in cwd, succeed
 *   MODE=dump-args         write our argv to worker-args.json in cwd, succeed
 *   MODE=flaky             fail (no sentinel) on the first run in this workdir,
 *                          succeed on the next (marker file in cwd)
 *   MODE=sleep             sleep SLEEP_MS=<n> (default 60000) then succeed;
 *                          add IGNORE_SIGTERM to survive SIGTERM (grace tests)
 *
 * The sentinel path is parsed from the runner's fixed epilogue phrase
 * "completion sentinel JSON to: <path>". This stubs the worker binary seam,
 * never the runner logic.
 *
 * When invoked with --output-format (a CONVERSATIONAL turn — the app shares
 * one agentBin), it behaves like agent-stub.cjs: reads stdin, emits canned
 * claude-style result JSON.
 */
'use strict';

const fs = require('node:fs');

const args = process.argv.slice(2);

/** Conversational mode (relay/rotation turns in app-level tests). */
function conversationalTurn() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    input += d;
  });
  process.stdin.on('end', () => {
    const resumeIdx = args.indexOf('--resume');
    const sessionIdIdx = args.indexOf('--session-id');
    let sessionId = 'sess-canned-1';
    if (resumeIdx !== -1) sessionId = args[resumeIdx + 1];
    else if (sessionIdIdx !== -1) sessionId = args[sessionIdIdx + 1];
    process.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: `pong: ${input.trim()}`,
        session_id: sessionId,
      })}\n`,
    );
  });
}

/** Worker mode: behavior driven entirely by the prompt text. */
function workerRun() {
  const pIdx = args.indexOf('-p');
  const prompt = pIdx === -1 ? '' : (args[pIdx + 1] ?? '');
  const mode = (prompt.match(/MODE=([a-z-]+)/) ?? [])[1] ?? 'success';
  const sentinelMatch = prompt.match(/completion sentinel JSON to: (\S+)/);
  const sentinelPath = sentinelMatch ? sentinelMatch[1] : null;

  const writeSentinel = (content) => {
    if (sentinelPath === null) throw new Error('worker stub: no sentinel path in prompt epilogue');
    fs.writeFileSync(sentinelPath, typeof content === 'string' ? content : JSON.stringify(content));
  };

  process.stdout.write(`worker stub started mode=${mode} pid=${process.pid}\n`);
  for (let i = 1; i <= 12; i += 1) process.stdout.write(`log line ${i}\n`);

  switch (mode) {
    case 'success':
      writeSentinel({
        schema: 1,
        status: 'success',
        summary: 'stub work complete',
        outputs: ['out.txt'],
      });
      process.exit(0);
      break;
    case 'no-sentinel':
      process.exit(0);
      break;
    case 'exit-nonzero':
      process.stderr.write('worker stub exploding\n');
      process.exit(3);
      break;
    case 'failure-sentinel':
      writeSentinel({ schema: 1, status: 'failure', summary: 'stub could not finish the task' });
      process.exit(0);
      break;
    case 'malformed-sentinel':
      writeSentinel('{this is not json');
      process.exit(0);
      break;
    case 'dump-env':
      // cwd is the job's workdir — the test reads worker-env.json from there.
      fs.writeFileSync('worker-env.json', JSON.stringify(process.env));
      writeSentinel({ schema: 1, status: 'success', summary: 'env dumped' });
      process.exit(0);
      break;
    case 'dump-args':
      // Stage 6: the argv the runner spawned us with (permission-profile pin).
      fs.writeFileSync('worker-args.json', JSON.stringify(args));
      writeSentinel({ schema: 1, status: 'success', summary: 'args dumped' });
      process.exit(0);
      break;
    case 'flaky':
      if (fs.existsSync('flaky-marker')) {
        writeSentinel({ schema: 1, status: 'success', summary: 'flaky succeeded on retry' });
        process.exit(0);
      }
      fs.writeFileSync('flaky-marker', '');
      process.exit(0); // clean exit, no sentinel → failure path
      break;
    case 'sleep': {
      if (/IGNORE_SIGTERM/.test(prompt)) process.on('SIGTERM', () => {});
      const ms = Number.parseInt((prompt.match(/SLEEP_MS=(\d+)/) ?? [])[1] ?? '60000', 10);
      setTimeout(() => {
        writeSentinel({ schema: 1, status: 'success', summary: 'stub slept and finished' });
        process.exit(0);
      }, ms);
      break;
    }
    default:
      process.stderr.write(`worker stub: unknown MODE ${mode}\n`);
      process.exit(9);
  }
}

if (args.includes('--output-format')) conversationalTurn();
else workerRun();
