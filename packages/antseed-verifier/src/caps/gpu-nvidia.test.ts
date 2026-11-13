import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from 'jose'
import {
  makeGpuNvidiaCap,
  makeNrasGpuVerify,
  gpuConfigKey,
  localGpuVerify,
  defaultGpuVerify,
  type GpuVerifyFn,
} from './gpu-nvidia.js'
import type { NrasRequest, NvidiaGpuEvidence } from '../nras.js'
import { claimId } from '../shared.js'
import { encodeTeeTdxEvidence, PROVIDER_TEE_CAP_ID } from './tee-tdx.js'
import { noncePubkeySha256V1 } from '../report-data.js'

const CLAIM = claimId('seller-provider-gpu-cc')
const NONCE = randomBytes(32)
const HEX = Buffer.from(NONCE).toString('hex')
const EVIDENCE = new Uint8Array([1, 2, 3])

/** Build a cap with a stub GpuVerifyFn and run one verify round. Evidence is present. */
function verifyWith(stub: GpuVerifyFn, evidence: Uint8Array = EVIDENCE) {
  return makeGpuNvidiaCap(stub).verify({ nonce: NONCE, peerId: 'a'.repeat(40), evidence })
}

describe('seller-provider-gpu-cc cap (injected GpuVerifyFn)', () => {
  it('happy path: claim ok, detail forwarded from the verifier', async () => {
    const stub: GpuVerifyFn = async () => ({ ok: true, detail: '2 NVIDIA GPUs, CC mode enabled, NRAS-verified' })
    const r = await verifyWith(stub)
    expect(r).toMatchObject({ claim: CLAIM, ok: true })
    expect(r.detail).toMatch(/NRAS-verified/)
  })

  it('failure: attestation verdict surfaced as ok:false', async () => {
    const stub: GpuVerifyFn = async () => ({ ok: false, detail: 'NRAS overall attestation result was not success' })
    const r = await verifyWith(stub)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/overall attestation result/)
  })

  it('nonce mismatch surfaces as a failure', async () => {
    const stub: GpuVerifyFn = async () => ({ ok: false, detail: 'NRAS EAR nonce does not match this attestation round' })
    const r = await verifyWith(stub)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/nonce/)
  })

  it('fails closed on missing evidence WITHOUT invoking the verifier', async () => {
    const stub = vi.fn<GpuVerifyFn>(async () => ({ ok: true, detail: 'should not run' }))
    // Build the input directly so evidence is absent. A default parameter would mask it.
    const r = await makeGpuNvidiaCap(stub).verify({ nonce: NONCE, peerId: 'a'.repeat(40) })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/no GPU CC evidence/)
    expect(stub).not.toHaveBeenCalled()
  })

  it('marks network/service errors [transient] in the detail', async () => {
    const stub: GpuVerifyFn = async () => ({ ok: false, transient: true, detail: 'NRAS request failed: fetch error' })
    const r = await verifyWith(stub)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/^\[transient\]/)
  })
})

describe('NRAS nonce derives from the provider quote binding', () => {
  it('submits the derived gpuNonce when the provider quote declares a scheme (Chutes)', async () => {
    const pubkey = Buffer.from(randomBytes(32)).toString('base64')
    const providerEv = encodeTeeTdxEvidence(new Uint8Array(randomBytes(64)), undefined, {
      scheme: 'nonce-pubkey-sha256-v1', ingredients: { e2ePubkey: pubkey },
    })
    let seen: Uint8Array | undefined
    const stub: GpuVerifyFn = async (_ev, nonce) => { seen = nonce; return { ok: true, detail: 'ok' } }
    await makeGpuNvidiaCap(stub).verify({
      nonce: NONCE, peerId: 'a'.repeat(40), evidence: EVIDENCE,
      evidenceBundle: { [PROVIDER_TEE_CAP_ID]: providerEv },
    })
    const derived = noncePubkeySha256V1.gpuNonce(NONCE, { e2ePubkey: pubkey })
    expect(seen && Buffer.from(seen).equals(Buffer.from(derived))).toBe(true)
    expect(seen && Buffer.from(seen).equals(Buffer.from(NONCE))).toBe(false)
  })

  it('submits the raw round nonce when no provider binding scheme is present', async () => {
    let seen: Uint8Array | undefined
    const stub: GpuVerifyFn = async (_ev, nonce) => { seen = nonce; return { ok: true, detail: 'ok' } }
    await makeGpuNvidiaCap(stub).verify({ nonce: NONCE, peerId: 'a'.repeat(40), evidence: EVIDENCE })
    expect(seen && Buffer.from(seen).equals(Buffer.from(NONCE))).toBe(true)
  })
})

describe('gpu mode dispatch', () => {
  it('localGpuVerify returns a clear not-implemented error (offline path reserved)', async () => {
    const r = await localGpuVerify(EVIDENCE, NONCE)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/offline GPU verification not yet implemented/)
  })

  it('defaultGpuVerify honours ANTSEED_VERIFIER_GPU_MODE=local', async () => {
    const prev = process.env.ANTSEED_VERIFIER_GPU_MODE
    process.env.ANTSEED_VERIFIER_GPU_MODE = 'local'
    try {
      const r = await defaultGpuVerify(EVIDENCE, NONCE)
      expect(r.detail).toMatch(/not yet implemented/)
    } finally {
      if (prev === undefined) delete process.env.ANTSEED_VERIFIER_GPU_MODE
      else process.env.ANTSEED_VERIFIER_GPU_MODE = prev
    }
  })
})

describe('collect (evidence off the provider route)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('throws (cap not offered) when url or field is unconfigured', async () => {
    const cap = makeGpuNvidiaCap()
    await expect(cap.collect!({ nonce: NONCE, peerId: 'a'.repeat(40), config: {} })).rejects.toThrow(/not offered/)
  })

  it('fetches the GPU field and preserves its JSON shape (with {nonce} substitution)', async () => {
    const gpuEvidence: NvidiaGpuEvidence = { arch: 'HOPPER', evidence_list: [{ evidence: 'e', certificate: 'c' }] }
    let seenUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      seenUrl = u
      return { ok: true, status: 200, json: async () => ({ gpu_evidence: gpuEvidence }) }
    }))
    const cap = makeGpuNvidiaCap()
    const out = await cap.collect!({
      nonce: NONCE,
      peerId: 'a'.repeat(40),
      config: { [gpuConfigKey('url')]: 'https://prov.example/ev/{nonce}', [gpuConfigKey('field')]: 'gpu_evidence' },
    })
    expect(seenUrl).toBe(`https://prov.example/ev/${HEX}`)
    expect(JSON.parse(new TextDecoder().decode(out))).toEqual(gpuEvidence)
  })
})

/**
 * Exercise the NRAS seam without the network. A real evidence blob passes through
 * buildNrasRequest, the injected submit, and real jose EAR verification with a test key.
 * This proves the submit is mockable and the request shape is correct, and it exercises
 * the real signature, claim, and nonce path.
 */
describe('makeNrasGpuVerify (injected submit + getKey)', () => {
  let priv: CryptoKey
  let pub: CryptoKey
  let getKey: JWTVerifyGetKey

  beforeAll(async () => {
    ;({ privateKey: priv, publicKey: pub } = await generateKeyPair('ES256'))
    getKey = (async () => pub) as unknown as JWTVerifyGetKey
  })

  it('submits the built request and verifies the returned EAR', async () => {
    const evidence: NvidiaGpuEvidence = { arch: 'HOPPER', evidence_list: [{ evidence: 'ev', certificate: 'ce' }] }
    const evidenceBytes = new TextEncoder().encode(JSON.stringify(evidence))

    let submitted: NrasRequest | undefined
    const submit = async (_url: string, body: NrasRequest) => {
      submitted = body
      const overall = await new SignJWT({ 'x-nvidia-overall-att-result': true, eat_nonce: body.nonce })
        .setProtectedHeader({ alg: 'ES256' }).sign(priv)
      const device = await new SignJWT({ measres: 'success', eat_nonce: body.nonce })
        .setProtectedHeader({ alg: 'ES256' }).sign(priv)
      return [overall, { 'GPU-0': device }]
    }

    const verify = makeNrasGpuVerify({ submit, getKey })
    const r = await verify(evidenceBytes, NONCE)
    expect(r.ok).toBe(true)
    expect(submitted).toMatchObject({ nonce: HEX, arch: 'HOPPER' })
    expect(submitted!.evidence_list).toEqual(evidence.evidence_list)
  })

  it('marks a NRAS submit failure as transient', async () => {
    const evidence = new TextEncoder().encode(JSON.stringify({ arch: 'HOPPER', evidence_list: [{ evidence: 'e', certificate: 'c' }] }))
    const submit = async () => { throw new Error('ECONNREFUSED') }
    const r = await makeNrasGpuVerify({ submit, getKey })(evidence, NONCE)
    expect(r.ok).toBe(false)
    expect(r.transient).toBe(true)
    expect(r.detail).toMatch(/NRAS request failed/)
  })

  it('fails closed on malformed GPU evidence before any submit', async () => {
    const submit = vi.fn(async () => 'unused')
    const r = await makeNrasGpuVerify({ submit, getKey })(new TextEncoder().encode('not json'), NONCE)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/invalid GPU evidence/)
    expect(submit).not.toHaveBeenCalled()
  })
})
