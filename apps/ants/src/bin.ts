// Standalone entry: `node dist/bin.js`. Kept out of index.ts so importing
// @antseed/ants as a library (the CLI, and the desktop's bundled CLI) never
// starts a server.
import { createAntsServer } from './server.js';

const DEFAULT_PORT = 3119;

const port = Number(process.env['ANTSEED_ANTS_PORT']) || DEFAULT_PORT;
createAntsServer({ port, dataDir: process.env['ANTSEED_DATA_DIR'] || undefined }).then(async (server) => {
  const url = await server.listen();
  console.log(`[ants] Dashboard running at ${url}`);
}).catch((error) => {
  console.error('[ants] Failed to start:', error);
  process.exit(1);
});
