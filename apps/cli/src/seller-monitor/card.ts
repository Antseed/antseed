import type { SellerPromote } from '../gateway/console-api/types.js'

const CARD_SERVICES = 5

/** "$0.70", "Free", sub-cent with two significant digits, like the console. */
export function cardPrice(value: number | null): string {
  if (value === null) return '—'
  if (value === 0) return 'Free'
  if (value < 0.01) return `$${value.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 3 : 2 })}`
}

/**
 * The shareable seller card: a self-contained SVG (no external fonts or
 * images) with the seller's name, trust score and first models with prices.
 * The dashboard shows and downloads it; `antseed seller promote --card` writes it.
 */
export function sellerCardSvg(data: Pick<SellerPromote, 'displayName' | 'peerId' | 'services' | 'trustScore'>): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!))
  const name = escape(data.displayName || 'Antseed seller')
  const peer = data.peerId ? `${data.peerId.slice(0, 6)}…${data.peerId.slice(-4)}` : ''
  const rows = data.services.slice(0, CARD_SERVICES).map((service, index) => {
    const y = 150 + index * 30
    const price = `${cardPrice(service.inputUsdPerMillion)} in · ${cardPrice(service.outputUsdPerMillion)} out`
    return `<text x="40" y="${y}" font-size="17" fill="#f2f2f2">${escape(service.service)}</text><text x="560" y="${y}" font-size="15" fill="#a3a3a3" text-anchor="end">${escape(price)}</text>`
  }).join('')
  const more = data.services.length > CARD_SERVICES ? `<text x="40" y="${150 + CARD_SERVICES * 30}" font-size="14" fill="#8a8a8a">+ ${data.services.length - CARD_SERVICES} more models</text>` : ''
  const trust = data.trustScore === null ? '' : `<text x="560" y="62" font-size="36" font-weight="600" fill="#f2f2f2" text-anchor="end">${Math.round(data.trustScore)}</text><text x="560" y="84" font-size="13" fill="#8a8a8a" text-anchor="end">trust score</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="340" viewBox="0 0 600 340" font-family="Inter, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">`
    + `<rect width="600" height="340" rx="20" fill="#0d0d0d"/>`
    + `<text x="40" y="58" font-size="26" font-weight="600" fill="#f2f2f2">${name}</text>`
    + `<text x="40" y="84" font-size="13" fill="#8a8a8a">${escape(peer)}${peer ? ' · ' : ''}sells on Antseed</text>`
    + trust
    + `<line x1="40" y1="110" x2="560" y2="110" stroke="#262626"/>`
    + rows + more
    + `<text x="40" y="312" font-size="12" fill="#8a8a8a">USD per million tokens · antseed.com</text>`
    + `</svg>`
}
