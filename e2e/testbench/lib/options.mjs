import { DEFAULT_SLOT, validateSlot } from './paths.mjs';
import { assertMode, CONTRACT_LAYOUTS } from './topology.mjs';
import { randomSeed } from './prng.mjs';

export const CHAIN_TARGETS = new Set(['fork', 'local', 'mainnet']);
/** `--run-timeout` default: a backstop against a scenario that hangs. */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 1800;
export const COMMANDS = new Set(['up', 'down', 'status', 'desktop', 'run', 'logs', 'list', 'scenarios', 'report', 'share', 'mainnet', 'help']);
const VALUE_FLAGS = { '--config': 'config', '--deposit-usdc': 'depositUsdc', '--block': 'block', '--slot': 'slot', '--scenario': 'scenario', '--timeout': 'timeout', '--env-file': 'envFile', '--port': 'port', '--host': 'host', '--chain': 'chain', '--mode': 'mode', '--idle': 'idle', '--cdp-port': 'cdpPort', '--seed': 'seed', '--run-timeout': 'runTimeout', '--contracts': 'contracts' };
const BOOL_FLAGS = { '--live': 'live', '--verbose': 'verbose', '--json': 'json', '--env': 'env', '--follow': 'follow', '--keep': 'keep', '--force': 'force', '--strict': 'strict', '--serve': 'serve', '--trace': 'trace', '--open': 'open', '--stop': 'stop', '--fresh': 'fresh', '--no-tailscale': 'noTailscale', '--real-funds': 'realFunds', '--dev': 'dev', '--budgets': 'budgets', '--help': 'help', '-h': 'help' };

export function parseArgs(argv, env = process.env) {
  const args = argv.filter((arg) => arg !== '--');
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'help';
  if (!COMMANDS.has(command)) throw new Error(`Unknown command "${command}". Run pnpm testbench help`);
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
  if (options.chain !== undefined && !CHAIN_TARGETS.has(options.chain)) throw new Error(`--chain must be one of ${[...CHAIN_TARGETS].join(', ')}`);
  if (options.mode !== undefined) {
    assertMode(options.mode, '--mode');
    if (!['up', 'run'].includes(command)) throw new Error('--mode is only for pnpm testbench up and run');
    if (options.chain === 'mainnet') throw new Error('--mode does not apply to --chain mainnet');
  }
  if (options.contracts !== undefined) {
    if (!CONTRACT_LAYOUTS.includes(options.contracts)) throw new Error(`--contracts must be one of ${CONTRACT_LAYOUTS.join(', ')}`);
    if (!['up', 'run'].includes(command)) throw new Error('--contracts is only for pnpm testbench up and run');
    if (options.chain && options.chain !== 'local') throw new Error('--contracts only applies to --chain local');
  }
  if (options.timeout !== undefined && !/^\d+$/.test(options.timeout)) throw new Error('--timeout must be seconds');
  if (options.seed !== undefined) {
    if (!['run', 'up'].includes(command)) throw new Error('--seed is only for pnpm testbench run and up');
    if (!(/^\d+$/.test(options.seed) && Number(options.seed) < 2 ** 32)) throw new Error('--seed must be an integer from 0 to 4294967295');
    options.seedGiven = true;
    options.seed = Number(options.seed);
  } else if (['run', 'up'].includes(command)) options.seed = randomSeed();
  if (options.runTimeout !== undefined) {
    if (command !== 'run') throw new Error('--run-timeout is only for pnpm testbench run');
    if (!(/^\d+$/.test(options.runTimeout) && Number(options.runTimeout) > 0)) throw new Error('--run-timeout must be a positive number of seconds');
  }
  if (command === 'run') options.runTimeout = Number(options.runTimeout ?? DEFAULT_RUN_TIMEOUT_SECONDS);
  if (options.budgets && command !== 'run') throw new Error('--budgets is only for pnpm testbench run');
  if (command === 'run' && env.ANTSEED_TESTBENCH_BUDGETS === '1') options.budgets = true;
  if (command === 'run') {
    if (options.positional.length !== 1) throw new Error('Usage: pnpm testbench run <scenario>');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.positional[0])) throw new Error('Invalid scenario name');
    options.scenario = options.positional[0];
  }
  if (options.scenario !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.scenario)) throw new Error('Invalid scenario name');
  if (options.idle !== undefined && !(/^\d+$/.test(options.idle) && Number(options.idle) >= 5 && Number(options.idle) <= 1440)) throw new Error('--idle must be 5-1440 minutes');
  if (command === 'share' && options.positional.length) throw new Error('Usage: pnpm testbench share [--stop] [--idle MIN] [--fresh] [--no-tailscale] [--scenario NAME] [--chain fork|local]');
  if (command === 'mainnet' && options.positional.length) throw new Error('Usage: pnpm testbench mainnet --real-funds [--dev] [--fresh]');
  if ((command === 'mainnet' || options.chain === 'mainnet') && !options.realFunds) {
    throw new Error('The mainnet target spends real USDC from the test wallet; rerun with --real-funds to confirm');
  }
  if (options.chain === 'mainnet' && !['run', 'mainnet'].includes(command)) throw new Error('--chain mainnet is only for pnpm testbench run (use pnpm testbench mainnet for an interactive desktop)');
  if (options.port !== undefined && !/^\d+$/.test(options.port)) throw new Error('--port must be a port number');
  if (options.cdpPort !== undefined) {
    if (command !== 'desktop') throw new Error('--cdp-port is only for pnpm testbench desktop');
    if (!(/^\d+$/.test(options.cdpPort) && Number(options.cdpPort) >= 1024 && Number(options.cdpPort) <= 65535)) throw new Error('--cdp-port must be a port number 1024-65535');
  }
  if (options.host !== undefined && !/^[0-9a-zA-Z.:-]+$/.test(options.host)) throw new Error('--host must be a hostname or IP');
  if (command === 'report' && options.positional.length > 1) throw new Error('Usage: pnpm testbench report [run-dir-name] [--open] [--serve]');
  if (command === 'logs' && options.positional.length > 1) throw new Error('Usage: pnpm testbench logs [component]');
  return options;
}

export const HELP = `pnpm testbench <command> [options]

  up        Start this worktree's testbench (reattaches if it is already running)
            --config FILE  --live  --env-file FILE  --deposit-usdc N  --block N  --scenario NAME  --verbose
            --seed N  the run seed (0-4294967295, default random); same seed, same mock and load draws
            --chain fork|local  fork: Base mainnet fork (needs BASE_MAINNET_RPC_URL, default)
                                local: plain Anvil + repo contracts deployed from source (needs forge, no RPC key)
            --mode sdk|cli      sdk: nodes built from the SDK, the buyer inside the supervisor (default)
                                cli: real antseed CLI processes for every seller and the buyer
            --contracts full|payments  local chain only: full: the production stack (default); payments:
                                script/Deploy.s.sol only (overrides the scenario's chain.contracts)
  down      Settle and close channels, then stop only this testbench's processes  [--force]
  status    Ports, wallets, balances, peers, URLs  [--json] [--env]
  run NAME  Run e2e/testbench/scenarios/NAME.mjs and write report.json
            Exits 0 passed, 1 failed, 2 blocked, 3 timeout, 4 error; any other result prints a rerun line
            Starts the testbench with the scenario topology if needed and stops it afterwards unless --keep
            --chain fork|local|mainnet  (default: the running testbench's chain, else the scenario's first target)
                     mainnet runs need --real-funds and only run scenarios that target it
            --mode sdk|cli  (default: the running testbench's mode, else the scenario topology's, else sdk)
            --contracts full|payments  (local chain; default: the scenario topology's chain.contracts, else full)
            --strict  also fail on known issues (recorded in report.json either way)
            --budgets also fail on topology.budgets (recorded either way; ANTSEED_TESTBENCH_BUDGETS=1 sets it)
            --trace   also record a Playwright trace of desktop scenarios (large; npx playwright show-trace)
            --seed N  the run seed (0-4294967295, default random); a running testbench keeps the seed it started with
            --run-timeout SECONDS  fail the run as a timeout after this long (default 1800)
  desktop   Attach-only Electron desktop to this testbench's buyer
            --cdp-port N  also open Chrome DevTools Protocol on 127.0.0.1:N (agent-browser connect N)
  mainnet   Full desktop with its own buyer from this worktree on the REAL network, paying from the test
            wallet (ANTSEED_TESTBENCH_MAINNET_IDENTITY_HEX); isolated profile, mock keychain, no OS proxy
            --real-funds (required)  --dev (Vite hot reload)  --fresh (reset the profile)
  logs      [component] [--follow]  (supervisor, anvil, seller-<id>, buyer in cli mode)
  list      All testbenches on this machine
  scenarios Every scenario with its targets and description  [--json]; the gaps are in e2e/testbench/features/
  report    [run] Print the latest (or named) run's index.html, report.json, video and trace paths
            --open   open the HTML report in the default browser
            --serve  serve this testbench's reports/ over HTTP  [--port N] [--host 127.0.0.1]
                     (loopback by default; on a remote box use ssh -L N:127.0.0.1:N)

  share     Linux server only: run the attach-only desktop on a virtual display and publish it
            (noVNC in the browser) plus reports on your tailnet with tailscale serve; prints the link
            --stop  --idle MIN (default 120, stops without viewers)  --fresh (reset desktop state)
            --no-tailscale (loopback only; use an SSH tunnel)  --scenario NAME  --chain fork|local
            Starts the testbench if needed; pnpm testbench down also stops the share

  ANTSEED_TESTBENCH_IDLE_MINUTES  an up or --keep testbench stops after this many minutes without a control
               request (5-1440, default 120). A run that dies without down stops its testbench within a minute.
  --env-file FILE  load live provider keys (only names used by apiKeyEnv) from a dotenv file;
               defaults to .antseed-testbench.env in the worktree. Shell variables win.
  --slot NAME  run an additional testbench for this worktree (default: "default")
`;
