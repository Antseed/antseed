import { spawnSync } from 'node:child_process';
import { REPOSITORY_ROOT } from './paths.mjs';

/**
 * Runs a command synchronously and fails loudly on a non-zero exit.
 * `capture` buffers output; `echo: false` keeps that output off the console.
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (options.capture && result.stdout) process.stdout.write(options.echo === false ? '' : result.stdout);
  if (options.capture && result.stderr) process.stderr.write(options.echo === false ? '' : result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return (result.stdout ?? '').trim();
}

export function capture(command, args, options = {}) {
  return run(command, args, { capture: true, echo: false, ...options });
}

export function sourceCommit() {
  return capture('git', ['rev-parse', 'HEAD']);
}

export function gitStatusPorcelain() {
  return capture('git', ['status', '--porcelain']);
}
