import { DEFAULT_SLOT, validateSlot } from './paths.mjs';

export const COMMANDS = new Set(['up', 'down', 'status', 'desktop', 'run', 'logs', 'list', 'help']);
const VALUE_FLAGS = { '--config': 'config', '--deposit-usdc': 'depositUsdc', '--block': 'block', '--slot': 'slot', '--scenario': 'scenario', '--timeout': 'timeout', '--env-file': 'envFile' };
const BOOL_FLAGS = { '--live': 'live', '--verbose': 'verbose', '--json': 'json', '--env': 'env', '--follow': 'follow', '--keep': 'keep', '--force': 'force', '--strict': 'strict', '--help': 'help', '-h': 'help' };

export function parseArgs(argv) {
  const args = argv.filter((arg) => arg !== '--');
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'help';
  if (!COMMANDS.has(command)) throw new Error(`Unknown command "${command}". Run pnpm sandbox help`);
  const options = { command, slot: DEFAULT_SLOT, positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (BOOL_FLAGS[flag]) { options[BOOL_FLAGS[flag]] = true; continue; }
    if (VALUE_FLAGS[flag]) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      options[VALUE_FLAGS[flag]] = value;
      index += 1;
      continue;
    }
    if (flag.startsWith('-')) throw new Error(`Unknown option ${flag}`);
    options.positional.push(flag);
  }
  validateSlot(options.slot);
  if (options.block !== undefined && !/^\d+$/.test(options.block)) throw new Error('--block must be a block number');
  if (options.depositUsdc !== undefined && !(/^\d+(\.\d{1,6})?$/.test(options.depositUsdc) && Number(options.depositUsdc) > 0 && Number(options.depositUsdc) <= 1000)) {
    throw new Error('--deposit-usdc must be a USDC amount between 0 and 1000');
  }
  if (options.timeout !== undefined && !/^\d+$/.test(options.timeout)) throw new Error('--timeout must be seconds');
  if (command === 'run') {
    if (options.positional.length !== 1) throw new Error('Usage: pnpm sandbox run <scenario>');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.positional[0])) throw new Error('Invalid scenario name');
    options.scenario = options.positional[0];
  }
  if (options.scenario !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.scenario)) throw new Error('Invalid scenario name');
  if (command === 'logs' && options.positional.length > 1) throw new Error('Usage: pnpm sandbox logs [component]');
  return options;
}

export const HELP = `pnpm sandbox <command> [options]

  up        Start this worktree's sandbox (reattaches if it is already running)
            --config FILE  --live  --env-file FILE  --deposit-usdc N  --block N  --scenario NAME  --verbose
  down      Settle and close channels, then stop only this sandbox's processes  [--force]
  status    Ports, wallets, balances, peers, URLs  [--json] [--env]
  run NAME  Run e2e/sandbox/scenarios/NAME.mjs, write report.json, exit nonzero on failure
            Starts the sandbox with the scenario topology if needed and stops it afterwards unless --keep
            --strict  also fail on known issues (recorded in report.json either way)
  desktop   Attach-only Electron desktop to this sandbox's buyer
  logs      [component] [--follow]  (supervisor, anvil, seller-<id>)
  list      All sandboxes on this machine

  --env-file FILE  load live provider keys (only names used by apiKeyEnv) from a dotenv file;
               defaults to .antseed-sandbox.env in the worktree. Shell variables win.
  --slot NAME  run an additional sandbox for this worktree (default: "default")
`;
