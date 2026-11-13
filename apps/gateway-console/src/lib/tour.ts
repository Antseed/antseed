import { driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import { canOpen, isOrgAdmin, type PageId, type Viewer } from './nav'

/**
 * The console's first-run walkthrough (driver.js): what each part of the
 * console is for, in the order a new operator needs it. It starts once per
 * member on this browser and can be replayed from the account menu. Steps
 * point at elements marked `data-tour`; a step whose element is not on screen
 * (a narrow window hides the nav) shows as a centred card instead.
 */

const SEEN_PREFIX = 'antseed-console:tour-seen'

export interface TourStep {
  /** `data-tour` value of the element to highlight; none for a centred card. */
  target?: string
  title: string
  description: string
}

const nav = (page: PageId) => `nav-${page}`

/** The steps for this viewer: only pages they can open, buyer settings for org admins. */
export function tourSteps(viewer: Viewer): TourStep[] {
  const page = (id: PageId, step: Omit<TourStep, 'target'>): TourStep[] => (canOpen(id, viewer) ? [{ target: nav(id), ...step }] : [])
  return [
    {
      title: 'Welcome to your gateway',
      description: 'This console runs on your gateway. It decides who can call the API, which sellers on the Antseed network serve those calls, and what they cost. Here is where everything lives.',
    },
    {
      target: 'workspace',
      title: 'Workspaces',
      description: 'Each workspace has its own wallet, members, keys and budgets. Switch between them here.',
    },
    ...page('wallet', {
      title: 'Fund the wallet',
      description: 'Requests are paid in USDC from the workspace wallet. Add funds by card where available or by sending USDC, and authorize the wallet that may withdraw.',
    }),
    ...page('keys', {
      title: 'API keys',
      description: "Create a key for each app or person. Each key can have daily, weekly, monthly and total budgets and its own routing policy. Clients call the gateway's /v1 address with the key.",
    }),
    ...(isOrgAdmin(viewer)
      ? page('settings', {
        title: 'Buyer settings come first',
        description: 'Settings → Buyer is the top of every routing policy: price caps, minimum trust (60 by default) and reputation, verification, payment limits and the RPC endpoint. If sellers you expect are missing, look here first.',
      })
      : []),
    ...page('routing', {
      title: 'Routing policies',
      description: 'Choose which sellers may serve: allow or block sellers, minimum trust, price caps, TEE only, fallback chains. Policies go from the buyer settings to the gateway default, workspaces, members, keys and presets, and each level can only narrow the one above. The route preview shows which sellers a request would use.',
    }),
    ...page('providers', {
      title: 'Providers',
      description: 'Every provider (seller) on the network this gateway sees, with prices, trust and the latency it measured. Open one to copy its models and an API call, or allow, block or prefer it.',
    }),
    ...page('activity', {
      title: 'Usage and logs',
      description: 'Spend and requests by model, key and member, and a searchable log of every request.',
    }),
    ...page('chat', {
      title: 'Try it in Chat',
      description: 'Chat with any model on the network, paid by your own Web chat key. Every answer shows which seller served it and what it cost.',
    }),
    {
      target: 'account',
      title: 'That is the tour',
      description: 'Replay it any time from your account menu.',
    },
  ]
}

function visible(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.getClientRects().length > 0
}

function toDriverStep(step: TourStep): DriveStep {
  const element = step.target ? document.querySelector(`[data-tour="${step.target}"]`) : null
  // Nav steps open beside the menu (never over it); the workspace and account steps below the top bar.
  const side = step.target?.startsWith('nav-') ? 'right' : 'bottom'
  return {
    ...(visible(element) ? { element } : {}),
    popover: { title: step.title, description: step.description, side, align: 'start' },
  }
}

function seenKey(memberId: string): string {
  return `${SEEN_PREFIX}:${memberId}`
}

export function tourSeen(memberId: string): boolean {
  try {
    return localStorage.getItem(seenKey(memberId)) === '1'
  } catch {
    // Storage unavailable (private window): never start on our own.
    return true
  }
}

function markSeen(memberId: string): void {
  try { localStorage.setItem(seenKey(memberId), '1') } catch { /* storage unavailable */ }
}

/** Runs the tour; finishing or closing it marks it seen for this member. */
export function startTour(viewer: Viewer, memberId: string): void {
  const steps = tourSteps(viewer).map(toDriverStep)
  const tour = driver({
    steps,
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    popoverClass: 'gc-tour',
    stagePadding: 4,
    stageRadius: 8,
    onDestroyed: () => markSeen(memberId),
  })
  tour.drive()
}
