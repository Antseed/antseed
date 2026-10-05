import type { ProviderAdapter, ProviderEvidence } from './index.js'
import type { NvidiaGpuEvidence } from '../nras.js'

/**
 * Chutes provider adapter (in-process). Chutes splits the evidence across two Bearer-authed
 * endpoints. `/e2e/instances/{chute}` returns the per-instance E2E pubkey (the report_data
 * ingredient). `/chutes/{chute}/evidence?nonce={hex}` returns the per-instance TDX quote and
 * GPU evidence, bound to the nonce. The adapter joins them by instance_id, decodes the base64
 * quote, and reshapes the flat GPU evidence into the NRAS shape.
 * ANTSEED_VERIFIER_PROVIDER_ADAPTER=chutes selects it.
 *
 * Env: CHUTES_API_KEY (required), CHUTES_CHUTE (required), CHUTES_API_BASE (default https://api.chutes.ai).
 */

const DEFAULT_BASE = 'https://api.chutes.ai'
const TIMEOUT_MS = 20_000

interface InstancesResponse {
  instances?: { instance_id?: string; e2e_pubkey?: string }[]
}
interface EvidenceResponse {
  evidence?: { instance_id?: string; quote?: string; gpu_evidence?: unknown }[]
}

/** Reshape Chutes' flat GPU evidence [{arch, evidence, certificate}] → NRAS { arch, evidence_list }. */
function reshapeGpu(gpu: unknown): NvidiaGpuEvidence | undefined {
  if (!gpu) return undefined
  if (Array.isArray(gpu)) {
    if (gpu.length === 0) return undefined
    const first = gpu[0] as { arch?: string }
    return {
      arch: String(first.arch),
      evidence_list: gpu.map((g) => {
        const item = g as { evidence?: string; certificate?: string }
        return { evidence: String(item.evidence), certificate: String(item.certificate) }
      }),
    }
  }
  return gpu as NvidiaGpuEvidence
}

async function fetchEvidence(nonce: Uint8Array, env: Record<string, string | undefined>): Promise<ProviderEvidence> {
  const base = (env['CHUTES_API_BASE'] ?? DEFAULT_BASE).replace(/\/+$/, '')
  const key = env['CHUTES_API_KEY']
  const chute = env['CHUTES_CHUTE']
  if (!key) throw new Error('CHUTES_API_KEY is required')
  if (!chute) throw new Error('CHUTES_CHUTE is required')
  const headers = { authorization: `Bearer ${key}` }
  const chuteEnc = encodeURIComponent(chute)

  const get = async (path: string): Promise<unknown> => {
    const resp = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!resp.ok) throw new Error(`chutes ${path.split('?')[0]} HTTP ${resp.status}`)
    return resp.json()
  }

  // E2E pubkey per instance (the report_data binding ingredient).
  const instBody = (await get(`/e2e/instances/${chuteEnc}`)) as InstancesResponse
  const pubkeys = new Map<string, string>()
  for (const i of instBody.instances ?? []) {
    if (i.instance_id && typeof i.e2e_pubkey === 'string' && i.e2e_pubkey.length > 0) pubkeys.set(i.instance_id, i.e2e_pubkey)
  }

  // TDX quote and GPU evidence per instance, bound to this nonce.
  const nonceHex = Buffer.from(nonce).toString('hex')
  const evBody = (await get(`/chutes/${chuteEnc}/evidence?nonce=${nonceHex}`)) as EvidenceResponse
  const inst = (evBody.evidence ?? []).find(
    (e) => typeof e.quote === 'string' && e.quote.length > 0 && !!e.instance_id && pubkeys.has(e.instance_id),
  )
  if (!inst?.quote || !inst.instance_id) throw new Error('no chutes instance had both a quote and an e2e_pubkey')

  const evidence: ProviderEvidence = {
    quote: new Uint8Array(Buffer.from(inst.quote, 'base64')),
    bindingScheme: 'nonce-pubkey-sha256-v1',
    ingredients: { e2ePubkey: pubkeys.get(inst.instance_id) },
  }
  const gpu = reshapeGpu(inst.gpu_evidence)
  if (gpu) evidence.gpuEvidence = gpu
  return evidence
}

const adapter: ProviderAdapter = { id: 'chutes', fetchEvidence }
export default adapter
