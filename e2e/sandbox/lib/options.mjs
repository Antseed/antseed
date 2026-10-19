import { DEFAULT_SLOT, validateSlot } from './paths.mjs';

export const CHAIN_TARGETS = new Set(['fork', 'local', 'mainnet']);
export const COMMANDS = new Set(['up', 'down', 'status', 'desktop', 'run', 'logs', 'list', 'report', 'share', 'mainnet', 'help']);
const VALUE_FLAGS = { '--config': 'config', '--deposit-usdc': 'depositUsdc', '--block': 'block', '--slot': 'slot', '--scenario': 'scenario', '--timeout': 'timeout', '--env-file': 'envFile', '--port': 'port', '--host': 'host', '--chain': 'chain', '--idle': 'idle', '--cdp-port': 'cdpPort' };
const BOOL_FLAGS = { '--live': 'live', '--verbose': 'verbose', '--json': 'json', '--env': 'env', '--follow': 'follow', '--keep': 'keep', '--force': 'force', '--strict': 'strict', '--serve': 'serve', '--trace': 'trace', '--open': 'open', '--stop': 'stop', '--fresh': 'fresh', '--no-tailscale': 'noTailscale', '--real-funds': 'realFunds', '--dev': 'dev', '--help': 'help', '-h': 'help' };

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
  if (options.chain !== undefined && !CHAIN_TARGETS.has(options.chain)) throw new Error(`--chain must be one of ${[...CHAIN_TARGETS].join(', ')}`);
  if (options.timeout !== undefined && !/^\d+$/.test(options.timeout)) throw new Error('--timeout must be seconds');
  if (command === 'run') {
    if (options.positional.length !== 1) throw new Error('Usage: pnpm sandbox run <scenario>');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.positional[0])) throw new Error('Invalid scenario name');
    options.scenario = options.positional[0];
  }
  if (options.scenario !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.scenario)) throw new Error('Invalid scenario name');
  if (options.idle !== undefined && !(/^\d+$/.test(options.idle) && Number(options.idle) >= 5 && Number(options.idle) <= 1440)) throw new Error('--idle must be 5-1440 minutes');
  if (command === 'share' && options.positional.length) throw new Error('Usage: pnpm sandbox share [--stop] [--idle MIN] [--fresh] [--no-tailscale] [--scenario NAME] [--chain fork|local]');
  if (command === 'mainnet' && options.positional.length) throw new Error('Usage: pnpm sandbox mainnet --real-funds [--dev] [--fresh]');
  if ((command === 'mainnet' || options.chain === 'mainnet') && !options.realFunds) {
    throw new Error('The mainnet target spends real USDC from the test wallet; rerun with --real-funds to confirm');
  }
  if (options.chain === 'mainnet' && !['run', 'mainnet'].includes(command)) throw new Error('--chain mainnet is only for pnpm sandbox run (use pnpm sandbox mainnet for an interactive desktop)');
  if (options.port !== undefined && !/^\d+$/.test(options.port)) throw new Error('--port must be a port number');
  if (options.cdpPort !== undefined) {
    if (command !== 'desktop') throw new Error('--cdp-port is only for pnpm sandbox desktop');
    if (!(/^\d+$/.test(options.cdpPort) && Number(options.cdpPort) >= 1024 && Number(options.cdpPort) <= 65535)) throw new Error('--cdp-port must be a port number 1024-65535');
  }
  if (options.host !== undefined && !/^[0-9a-zA-Z.:-]+$/.test(options.host)) throw new Error('--host must be a hostname or IP');
  if (command === 'report' && options.positional.length > 1) throw new Error('Usage: pnpm sandbox report [run-dir-name] [--open] [--serve]');
  if (command === 'logs' && options.positional.length > 1) throw new Error('Usage: pnpm sandbox logs [component]');
  return options;
}

export const HELP = `pnpm sandbox <command> [options]

  up        Start this worktree's sandbox (reattaches if it is already running)
            --config FILE  --live  --env-file FILE  --deposit-usdc N  --block N  --scenario NAME  --verbose
            --chain fork|local  fork: Base mainnet fork (needs BASE_MAINNET_RPC_URL, default)
                                local: plain Anvil + repo contracts deployed from source (needs forge, no RPC key)
  down      Settle and close channels, then stop only this sandbox's processes  [--force]
  status    Ports, wallets, balances, peers, URLs  [--json] [--env]
  run NAME  Run e2e/sandbox/scenarios/NAME.mjs, write report.json, exit nonzero on failure
            Starts the sandbox with the scenario topology if needed and stops it afterwards unless --keep
            --chain fork|local|mainnet  (default: the running sandbox's chain, else the scenario's first target)
                     mainnet runs need --real-funds and only run scenarios that target it
            --strict  also fail on known issues (recorded in report.json either way)
            --trace   also record a Playwright trace of desktop scenarios (large; npx playwright show-trace)
  desktop   Attach-only Electron desktop to this sandbox's buyer
            --cdp-port N  also open Chrome DevTools Protocol on 127.0.0.1:N (agent-browser connect N)
  mainnet   Full desktop with its own buyer from this worktree on the REAL network, paying from the test
            wallet (ANTSEED_SANDBOX_MAINNET_IDENTITY_HEX); isolated profile, mock keychain, no OS proxy
            --real-funds (required)  --dev (Vite hot reload)  --fresh (reset the profile)
  logs      [component] [--follow]  (supervisor, anvil, seller-<id>)
  list      All sandboxes on this machine
  report    [run] Print the latest (or named) run's index.html, report.json, video and trace paths
            --open   open the HTML report in the default browser
            --serve  serve this sandbox's reports/ over HTTP  [--port N] [--host 127.0.0.1]
                     (loopback by default; on a remote box use ssh -L N:127.0.0.1:N)

  share     Linux server only: run the attach-only desktop on a virtual display and publish it
            (noVNC in the browser) plus reports on your tailnet with tailscale serve; prints the link
            --stop  --idle MIN (default 120, stops without viewers)  --fresh (reset desktop state)
            --no-tailscale (loopback only; use an SSH tunnel)  --scenario NAME  --chain fork|local
            Starts the sandbox if needed; pnpm sandbox down also stops the share

  --env-file FILE  load live provider keys (only names used by apiKeyEnv) from a dotenv file;
               defaults to .antseed-sandbox.env in the worktree. Shell variables win.
  --slot NAME  run an additional sandbox for this worktree (default: "default")
`;
