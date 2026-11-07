import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DSTACK_RUNTIME_EVENT_TYPE, runtimeEventDigest, type DstackEvent } from './dstack-event-log.js'
import type { ApprovedDstackOs, ApprovedNodeBuilds } from './approved-node-measurements.js'

/** Test-only: a conforming dstack TEE seller deployment, built from deploy/tee-seller/docker-compose.json. */

export const TEST_IMAGE = { version: '0.0.0-test', digest: `sha256:${'ee'.repeat(32)}` }

export function testOs(mrtdHex: string): ApprovedDstackOs {
  return { name: 'dstack test', mrtd: mrtdHex, rtmr0: '00'.repeat(48), rtmr1: '00'.repeat(48), rtmr2: '00'.repeat(48) }
}

export function testBuilds(mrtdHex: string): ApprovedNodeBuilds {
  return { os: [testOs(mrtdHex)], images: [TEST_IMAGE] }
}

type Obj = Record<string, any>

/** The reference compose with its placeholders filled in: one openai provider at https://upstream.example. */
export function referenceCompose(): Obj {
  const raw = readFileSync(new URL('../../../deploy/tee-seller/docker-compose.json', import.meta.url), 'utf8')
    .replace('sha256:<release digest>', TEST_IMAGE.digest)
    .replace('<seller peer id, 40 hex, no 0x>', 'f'.repeat(40))
    .replace('https://<upstream host>', 'https://upstream.example')
  return JSON.parse(raw) as Obj
}

/** The seller config inside a compose, parsed. */
export function sellerConfig(compose: Obj): Obj {
  return JSON.parse(compose['configs']['seller-config']['content']) as Obj
}

export function withSellerConfig(compose: Obj, config: Obj): Obj {
  return { ...compose, configs: { 'seller-config': { content: JSON.stringify(config) } } }
}

/** app-compose.json around a compose file, as dstack builds it. */
export function appCompose(compose: Obj, over: Obj = {}): string {
  return JSON.stringify({
    manifest_version: 2,
    name: 'antseed-seller',
    runner: 'docker-compose',
    docker_compose_file: JSON.stringify(compose),
    kms_enabled: true,
    gateway_enabled: true,
    public_logs: false,
    public_sysinfo: true,
    local_key_provider_enabled: false,
    allowed_envs: ['ANTSEED_IDENTITY_HEX', 'OPENAI_API_KEY'],
    no_instance_id: false,
    secure_time: false,
    ...over,
  })
}

export function composeHash(app: string): string {
  return createHash('sha256').update(app, 'utf8').digest('hex')
}

function event(name: string, payloadHex: string): DstackEvent {
  const digest = runtimeEventDigest(name, Buffer.from(payloadHex, 'hex'), 1).toString('hex')
  return { imr: 3, event_type: DSTACK_RUNTIME_EVENT_TYPE, digest, event: name, event_payload: payloadHex }
}

/** The RTMR3 boot events measuring `app`, and the RTMR3 they replay to. */
export function bootEvents(app: string): { eventLog: DstackEvent[]; rtmr3: Uint8Array } {
  const eventLog = [
    event('system-preparing', ''),
    event('app-id', '11'.repeat(20)),
    event('compose-hash', composeHash(app)),
    event('instance-id', '22'.repeat(20)),
    event('boot-mr-done', ''),
  ]
  const rtmr3 = eventLog.reduce((mr, e) => createHash('sha384').update(Buffer.concat([mr, Buffer.from(e.digest, 'hex')])).digest(), Buffer.alloc(48))
  return { eventLog, rtmr3: new Uint8Array(rtmr3) }
}
