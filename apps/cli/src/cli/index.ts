#!/usr/bin/env node

import chalk from 'chalk';
import { loadEnvFromFiles } from '../env/load-env.js';
import { notifyIfUpdateAvailable } from '../update/notifier.js';
import { createProgram } from './program.js';
import { getGlobalOptions } from './commands/types.js';
import pkg from '../../package.json' with { type: 'json' };

loadEnvFromFiles();

const program = createProgram();

program.hook('preAction', (_command, actionCommand) => {
  try {
    notifyIfUpdateAvailable({ dataDir: getGlobalOptions(program).dataDir, current: pkg.version, commandName: actionCommand.name() });
  } catch {
    // never let the update notice break a command
  }
});

// No top-level await: the desktop app bundles this entry as CommonJS.
program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  // Exit like the unhandled rejection this replaces: a failed command may
  // still hold servers or timers open.
  process.exit(1);
});
