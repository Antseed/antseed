#!/usr/bin/env node

import chalk from 'chalk';
import { loadEnvFromFiles } from '../env/load-env.js';
import { createProgram } from './program.js';

loadEnvFromFiles();

const program = createProgram();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  // Exit like the unhandled rejection this replaces: a failed command may
  // still hold servers or timers open.
  process.exit(1);
}
