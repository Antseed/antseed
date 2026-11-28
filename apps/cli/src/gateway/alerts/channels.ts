/**
 * Delivery of one alert to one destination: a signed webhook, a Telegram
 * message through the workspace's own bot, or an email through the SMTP
 * server the gateway host configures. Nothing here goes through a service
 * Antseed runs: every destination is the operator's own.
 */
import { createHmac } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { errorMessage } from '../errors.js'
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
  /** For Telegram; webhooks connect through `lookup` instead. */
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
  /** Resolves a webhook host to its addresses. The connection uses only these, once each is checked against link-local and cloud metadata targets. */
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
  const ip = canonicalIp(address)
  if (isIP(ip) === 4) return ip.startsWith('169.254.') || ip === '0.0.0.0'
  return ip === '::' || /^fe[89ab][0-9a-f]:/.test(ip) || ip === 'fd00:ec2::254'
}

/**
 * An address in one spelling: IPv6 compressed and lowercase (via the URL
 * parser), without a zone, and an IPv4-mapped IPv6 address as its IPv4
 * (`::ffff:a9fe:a9fe` and `::ffff:169.254.169.254` are 169.254.169.254).
 */
function canonicalIp(address: string): string {
  let ip = address.trim().toLowerCase().replace(/%.*$/, '')
  if (isIP(ip) === 6) ip = new URL(`http://[${ip}]`).hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (!mapped) return ip
  const high = parseInt(mapped[1]!, 16)
  const low = parseInt(mapped[2]!, 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

export function emailConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env[SMTP_URL_ENV]?.trim() && env[SMTP_FROM_ENV]?.trim())
}

export function emailRecipients(target: string): string[] {
  return target.split(',').map((entry) => entry.trim()).filter(Boolean)
}

class ForbiddenWebhookError extends Error {
  constructor(host: string) {
    super(`Webhooks to ${host} are not allowed.`)
  }
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

  /**
   * The connection's own DNS lookup: it connects only to answers that pass
   * the address check, so a name cannot pass one lookup and connect to
   * another answer. Host and TLS name stay the URL's.
   */
  const checkedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
    void (async () => {
      let addresses: string[]
      try {
        addresses = await lookup(hostname)
      } catch {
        addresses = []
      }
      if (addresses.length === 0) return callback(new Error(`Could not resolve ${hostname}.`), '', 0)
      if (addresses.some(isForbiddenWebhookAddress)) return callback(new ForbiddenWebhookError(hostname), '', 0)
      const entries = addresses.map((address) => ({ address, family: isIP(address) }))
      if (lookupOptions.all) callback(null, entries)
      else callback(null, entries[0]!.address, entries[0]!.family)
    })()
  }

  /** POSTs and answers the status. Redirects are not followed and the receiver's body is never read. */
  function post(url: URL, headers: Record<string, string>, body: string): Promise<number> {
    const request = url.protocol === 'https:' ? https.request : http.request
    return new Promise((resolve, reject) => {
      const req = request(url, {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: checkedLookup,
        // A new connection each time, so every delivery goes through `checkedLookup`.
        agent: false,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      }, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  async function webhook(destination: AlertDestinationRecord, event: AlertEvent): Promise<void> {
    let url: URL
    try {
      url = new URL(destination.target)
    } catch {
      throw new Error('The webhook URL is not valid.')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The webhook URL must use http or https.')
    // An IP host connects without a lookup, so it is checked here; a name is checked by `checkedLookup`.
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) && isForbiddenWebhookAddress(host)) throw new ForbiddenWebhookError(host)
    const body = webhookBody(event)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'antseed-gateway-alerts',
      [WEBHOOK_EVENT_HEADER]: event.type,
      [WEBHOOK_DELIVERY_HEADER]: event.id,
    }
    if (destination.secret) headers[WEBHOOK_SIGNATURE_HEADER] = signWebhook(destination.secret, body, now())
    let status: number
    try {
      status = await post(url, headers, body)
    } catch (error) {
      if (error instanceof ForbiddenWebhookError) throw error
      throw new Error(`The webhook could not be reached: ${errorMessage(error)}`)
    }
    if (status < 200 || status >= 300) throw new Error(`The webhook answered HTTP ${status}.`)
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
      const message = errorMessage(error)
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
      throw new Error(`The email could not be sent: ${errorMessage(error)}`)
    }
  }

  return {
    async send(destination, event) {
      try {
        if (destination.kind === 'webhook') await webhook(destination, event)
        else if (destination.kind === 'telegram') await telegram(destination, event)
        else await email(destination, event)
      } catch (error) {
        throw new Error(clip(errorMessage(error)))
      }
    },
    emailConfigured: () => emailConfigured(env),
  }
}
