/**
 * Delivery of one alert to one destination: a signed webhook, a Telegram
 * message through the workspace's own bot, or an email through the SMTP
 * server the gateway host configures. Nothing here goes through a service
 * Antseed runs: every destination is the operator's own.
 */
import { createHmac } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { AlertDestinationRecord } from '../store.js'
import type { AlertEvent } from './events.js'

/** SMTP server alert emails go through, e.g. `smtps://user:pass@smtp.example.com:465`. */
export const SMTP_URL_ENV = 'ANTSEED_GATEWAY_SMTP_URL'
/** Sender of alert emails, e.g. `Antseed Gateway <alerts@example.com>`. */
export const SMTP_FROM_ENV = 'ANTSEED_GATEWAY_SMTP_FROM'
/** Header carrying the webhook signature: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-antseed-signature'
export const WEBHOOK_EVENT_HEADER = 'x-antseed-event'
export const WEBHOOK_DELIVERY_HEADER = 'x-antseed-delivery'
const DELIVERY_TIMEOUT_MS = 10_000
const TELEGRAM_API = 'https://api.telegram.org'
/** Longest error text kept for a failed delivery. */
const MAX_ERROR_LENGTH = 300

export interface AlertTransportOptions {
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
  /** Resolves a webhook host to its addresses, to refuse link-local and cloud metadata targets. */
  lookup?: (host: string) => Promise<string[]>
  now?: () => number
  telegramApi?: string
  /** Sends one email; defaults to nodemailer over `ANTSEED_GATEWAY_SMTP_URL`. */
  sendMail?: (message: { from: string; to: string[]; subject: string; text: string }) => Promise<void>
}

export interface AlertTransport {
  /** Delivers `event` to `destination`; throws an Error whose message says why it failed. */
  send(destination: AlertDestinationRecord, event: AlertEvent): Promise<void>
  /** Whether the host has an SMTP server for alert emails. */
  emailConfigured(): boolean
}

/** The webhook body: stable snake_case JSON a receiver can script against (an auto top-up, a pager). */
export function webhookBody(event: AlertEvent): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    severity: event.severity,
    created_at: new Date(event.createdAt).toISOString(),
    workspace: event.workspace,
    title: event.title,
    message: event.message,
    data: event.data,
  })
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, the scheme Stripe-style receivers verify. */
export function signWebhook(secret: string, body: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000)
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
}

/** Plain text for Telegram and email: the title, the message and a link when there is one. */
export function alertText(event: AlertEvent): string {
  const link = typeof event.data['console_url'] === 'string' ? `\n\n${event.data['console_url']}` : ''
  return `${event.title}\n\n${event.message}${link}`
}

/**
 * Link-local addresses (cloud metadata services live at 169.254.169.254 and
 * fd00:ec2::254) and the unspecified address. Loopback and private networks
 * stay allowed: an auto top-up script next to the gateway is a normal target.
 */
export function isForbiddenWebhookAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, '')
  if (isIP(ip) === 4) return ip.startsWith('169.254.') || ip === '0.0.0.0'
  return ip === '::' || /^fe[89ab][0-9a-f]:/.test(ip) || ip === 'fd00:ec2::254'
}

export function emailConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env[SMTP_URL_ENV]?.trim() && env[SMTP_FROM_ENV]?.trim())
}

export function emailRecipients(target: string): string[] {
  return target.split(',').map((entry) => entry.trim()).filter(Boolean)
}

function clip(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message
}

async function defaultLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map((entry) => entry.address)
}

export function createAlertTransport(options: AlertTransportOptions = {}): AlertTransport {
  const fetchImpl = options.fetch ?? fetch
  const env = options.env ?? process.env
  const lookup = options.lookup ?? defaultLookup
  const now = options.now ?? Date.now
  const telegramApi = options.telegramApi ?? TELEGRAM_API

  async function resolve(host: string): Promise<string[]> {
    if (isIP(host)) return [host]
    try {
      return await lookup(host)
    } catch {
      throw new Error(`Could not resolve ${host}.`)
    }
  }

  async function webhook(destination: AlertDestinationRecord, event: AlertEvent): Promise<void> {
    let url: URL
    try {
      url = new URL(destination.target)
    } catch {
      throw new Error('The webhook URL is not valid.')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The webhook URL must use http or https.')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const addresses = await resolve(host)
    if (addresses.length === 0 || addresses.some(isForbiddenWebhookAddress)) throw new Error(`Webhooks to ${host} are not allowed.`)
    const body = webhookBody(event)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'antseed-gateway-alerts',
      [WEBHOOK_EVENT_HEADER]: event.type,
      [WEBHOOK_DELIVERY_HEADER]: event.id,
    }
    if (destination.secret) headers[WEBHOOK_SIGNATURE_HEADER] = signWebhook(destination.secret, body, now())
    let response: Response
    try {
      // Redirects are not followed: a receiver that moved gets a failed delivery, not a request to wherever it points.
      response = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) })
    } catch (error) {
      throw new Error(`The webhook could not be reached: ${error instanceof Error ? error.message : String(error)}`)
    }
    // The receiver's body is never read or kept: only whether it took the alert.
    await response.body?.cancel().catch(() => undefined)
    if (response.status < 200 || response.status >= 300) throw new Error(`The webhook answered HTTP ${response.status}.`)
  }

  async function telegram(destination: AlertDestinationRecord, event: AlertEvent): Promise<void> {
    if (!destination.secret) throw new Error('No Telegram bot token is set.')
    let response: Response
    try {
      response = await fetchImpl(`${telegramApi}/bot${destination.secret}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: destination.target, text: alertText(event), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      })
    } catch (error) {
      // fetch errors can quote the URL, which carries the bot token.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Telegram could not be reached: ${message.split(destination.secret).join('<token>')}`)
    }
    const body = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null
    if (!response.ok || body?.ok !== true) {
      throw new Error(`Telegram refused the message: ${body?.description ?? `HTTP ${response.status}`}`)
    }
  }

  const sendMail = options.sendMail ?? (async (message: { from: string; to: string[]; subject: string; text: string }) => {
    const { createTransport } = await import('nodemailer')
    const transport = createTransport(env[SMTP_URL_ENV]!.trim())
    try {
      await transport.sendMail(message)
    } finally {
      transport.close()
    }
  })

  async function email(destination: AlertDestinationRecord, event: AlertEvent): Promise<void> {
    if (!emailConfigured(env)) throw new Error(`Email is not set up on the gateway host (${SMTP_URL_ENV} and ${SMTP_FROM_ENV}).`)
    const to = emailRecipients(destination.target)
    if (to.length === 0) throw new Error('No email address is set.')
    try {
      await sendMail({ from: env[SMTP_FROM_ENV]!.trim(), to, subject: `[Antseed] ${event.title}`, text: alertText(event) })
    } catch (error) {
      throw new Error(`The email could not be sent: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    async send(destination, event) {
      try {
        if (destination.kind === 'webhook') await webhook(destination, event)
        else if (destination.kind === 'telegram') await telegram(destination, event)
        else await email(destination, event)
      } catch (error) {
        throw new Error(clip(error instanceof Error ? error.message : String(error)))
      }
    },
    emailConfigured: () => emailConfigured(env),
  }
}
