import type { Command } from 'commander';
import chalk from 'chalk';
import type { SellerAlertsPatch } from '../../../gateway/console-api/types.js';
import { jsonFlag, runMonitorCommand, sellerCommand, sellerMonitorFor } from './monitor.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * A secret from stdin, refused when empty: an unset shell variable piped in
 * (or Ctrl-D) must never clear a saved value. Clearing has its own flag.
 */
export async function readSecretFromStdin(flag: string, hint: string, read: () => Promise<string> = readStdin): Promise<string> {
  const value = await read();
  if (!value) throw new Error(`${flag}: nothing was read from stdin. ${hint}`);
  return value;
}

const SEVERITIES = ['info', 'warning', 'critical'];

/**
 * `antseed seller alerts [show|set|test|find-chat]`: the dashboard's Alerts
 * panel from the command line, through the same SellerMonitor. Secrets are
 * read from stdin (never from argv, which lands in shell history).
 */
export function registerSellerAlertsCommand(sellerCmd: Command): void {
  const alertsCmd = sellerCmd
    .command('alerts')
    .description('Seller alerts (Telegram, webhook): show with no subcommand')
    .option('--json', 'output as JSON', false)
    .action((options: { json: boolean }) => runMonitorCommand(options.json, async () => (await sellerMonitorFor(sellerCmd).settings()).alerts, (alerts) => {
      const telegram = alerts.telegram;
      console.log(`${chalk.bold('Telegram')}  ${telegram.active ? chalk.green('on') : chalk.dim('off')} · chat ${telegram.chatId ?? '—'} · token ${telegram.tokenSource === 'env' ? `from ${telegram.botTokenEnv}` : telegram.tokenSet ? 'saved' : 'not set'}`);
      console.log(`${chalk.bold('Webhook')}   ${alerts.webhook.set ? `posts to ${alerts.webhook.host}` : chalk.dim('off')}`);
      console.log(`Lowest severity ${alerts.minSeverity ?? 'warning'} · quiet alert ${alerts.idleMinutes ? `after ${alerts.idleMinutes} min` : 'off'} · repeat at most every ${alerts.cooldownMinutes ?? 30} min`);
      if (!alerts.writable) console.log(chalk.yellow(alerts.readOnlyReason ?? 'Read-only'));
    }));

  alertsCmd
    .command('set')
    .description('Change alert settings; a running seller applies them within seconds')
    .option('--telegram-token-stdin', 'read the Telegram bot token from stdin')
    .option('--telegram-chat <id>', 'chat id, or "none"')
    .option('--clear-telegram-token', 'remove the saved bot token')
    .option('--webhook-url-stdin', 'read the webhook URL from stdin (it may carry a secret)')
    .option('--clear-webhook', 'remove the webhook')
    .option('--idle <minutes|off>', 'alert when nothing was served this long')
    .option('--cooldown <minutes|default>', 'shortest gap between repeats of one alert')
    .option('--min-severity <info|warning|critical>')
    .option('--json', 'output as JSON', false)
    .action((options: Record<string, string | boolean | undefined>, command: Command) => runMonitorCommand(jsonFlag(command), async () => {
      const patch: SellerAlertsPatch = {};
      // stdin can be read once: one secret per command.
      if (options.telegramTokenStdin && options.webhookUrlStdin) throw new Error('--telegram-token-stdin and --webhook-url-stdin both read stdin; set them in two commands.');
      if (options.telegramTokenStdin) patch.telegramBotToken = await readSecretFromStdin('--telegram-token-stdin', 'Pipe the token in; to remove the saved one, use --clear-telegram-token.');
      if (options.clearTelegramToken) patch.telegramBotToken = null;
      if (options.webhookUrlStdin) patch.webhookUrl = await readSecretFromStdin('--webhook-url-stdin', 'Pipe the URL in; to remove the webhook, use --clear-webhook.');
      if (options.clearWebhook) patch.webhookUrl = null;
      if (typeof options.telegramChat === 'string') patch.telegramChatId = options.telegramChat === 'none' ? null : options.telegramChat;
      if (typeof options.idle === 'string') patch.idleMinutes = options.idle === 'off' ? null : Number(options.idle);
      if (typeof options.cooldown === 'string') patch.cooldownMinutes = options.cooldown === 'default' ? null : Number(options.cooldown);
      if (typeof options.minSeverity === 'string') {
        if (!SEVERITIES.includes(options.minSeverity)) throw new Error('--min-severity: use info, warning or critical');
        patch.minSeverity = options.minSeverity as SellerAlertsPatch['minSeverity'];
      }
      if (Object.keys(patch).length === 0) throw new Error('Nothing to change: pass at least one option (see --help).');
      return sellerMonitorFor(sellerCmd).updateAlerts(patch);
    }, (result) => console.log(chalk.green(`Saved: ${Object.entries(result.changed).map(([key, value]) => `${key} ${value}`).join(', ')}.`))));

  alertsCmd
    .command('test')
    .description('Send a test alert to every configured channel (or one)')
    .option('--channel <telegram|webhook>')
    .option('--json', 'output as JSON', false)
    .action((options: { channel?: string }, command: Command) => runMonitorCommand(jsonFlag(command), async () => {
      if (options.channel && options.channel !== 'telegram' && options.channel !== 'webhook') throw new Error('--channel: use telegram or webhook');
      const result = await sellerMonitorFor(sellerCmd).testAlert(options.channel as 'telegram' | 'webhook' | undefined);
      if (result.errors.length > 0) process.exitCode = 1;
      return result;
    }, ({ sent, errors }) => {
      for (const channel of sent) console.log(chalk.green(`Sent to ${channel}`));
      for (const error of errors) console.log(chalk.red(`Failed: ${error}`));
    }));

  alertsCmd
    .command('find-chat')
    .description('List chats that recently messaged your bot (send it a message, or add it to a group, first)')
    .option('--token-stdin', 'use a bot token from stdin instead of the saved one')
    .option('--json', 'output as JSON', false)
    .action((options: { tokenStdin?: boolean }, command: Command) => runMonitorCommand(jsonFlag(command), async () => sellerMonitorFor(sellerCmd).telegramChats(options.tokenStdin ? await readSecretFromStdin('--token-stdin', 'Pipe the token in, or leave the flag out to use the saved one.') : null), (chats) => {
      if (chats.length === 0) return console.log(chalk.dim('No chats yet. Message the bot or add it to a group and post there, then try again.'));
      for (const chat of chats) console.log(`${chat.id.padEnd(16)} ${chat.type.padEnd(11)} ${chat.title}`);
      console.log(chalk.dim(`Use one with: ${sellerCommand(sellerCmd, 'alerts set')} --telegram-chat <id>`));
    }));
}
