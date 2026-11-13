#!/usr/bin/env node

import { getDeploymentMigration, parseDeployArgs } from './deployments/index.mjs';

try {
  const options = parseDeployArgs(process.argv.slice(2));
  await getDeploymentMigration(options.migration).run(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
