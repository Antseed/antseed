import { describe, it, expect } from 'vitest'
import { APPROVED_DSTACK_OS, APPROVED_OS_IMAGES, readApprovedNodeBuilds } from './approved-node-measurements.js'

describe('APPROVED_DSTACK_OS', () => {
  it('lists well-formed measurements, one entry per name', () => {
    expect(APPROVED_DSTACK_OS.length).toBeGreaterThan(0)
    for (const os of APPROVED_DSTACK_OS) {
      for (const v of [os.mrtd, os.rtmr0, os.rtmr1, os.rtmr2]) expect(v).toMatch(/^[0-9a-f]{96}$/)
    }
    expect(new Set(APPROVED_DSTACK_OS.map((os) => os.name)).size).toBe(APPROVED_DSTACK_OS.length)
    expect(new Set(APPROVED_DSTACK_OS.map((os) => os.rtmr0)).size).toBe(APPROVED_DSTACK_OS.length)
  })

  it('matches the measurements of a Phala Cloud dstack 0.6.1 tdx.large CVM', () => {
    // From the TCB info of a production Phala Cloud CVM (dstack 0.6.1, 4 vCPU, 8 GiB).
    expect(APPROVED_DSTACK_OS).toContainEqual({
      name: 'dstack 0.6.1 (tdx.large, 4 vCPU, 8 GiB)',
      mrtd: '2a674327c50218dba880066b349b8d559d749ed68dce33fd651c184a877d084b07a9e583767a7ad5da13ed91deec2b70',
      rtmr0: 'fb14dc139f33d6fcf474bc8332cac001259fb31cfbcb6b34d4ceeb552a2c4466884a0cbde45ad98a05c5c060c23ad65a',
      rtmr1: '89ef86c5125b986c325f0a94acfa87718a4ef3a4d4f237dbb72dda3cf777fd2c054555fb4407eb53338d7d67329a7333',
      rtmr2: 'e9000e338f33233e8f51b7fd031e1c158bdcf8572eab041c0bc8eb7fef48b23259a6a556e6c8e2af99999fc39c793179',
    })
  })
})

describe('APPROVED_OS_IMAGES', () => {
  it('lists the dstack 0.6.1 production OS image hash', () => {
    expect(APPROVED_OS_IMAGES).toContainEqual({
      name: 'dstack 0.6.1',
      hash: 'ec43cb8c5e04b6bb6c53b33b16076a01d83d01f7f4b703f2f78a0d947d6247e6',
    })
    for (const image of APPROVED_OS_IMAGES) expect(image.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('readApprovedNodeBuilds', () => {
  it('adds well-formed os and osImages entries and ignores malformed ones', () => {
    const os = {
      name: 'custom os',
      mrtd: '11'.repeat(48),
      rtmr0: '22'.repeat(48),
      rtmr1: '33'.repeat(48),
      rtmr2: '44'.repeat(48),
    }
    const osImage = { name: 'custom image', hash: 'ab'.repeat(32) }
    process.env['ANTSEED_VERIFIER_NODE_BUILDS'] = JSON.stringify({
      os: [os, { name: 'bad os', mrtd: '1' }],
      osImages: [osImage, { name: 'uppercase', hash: 'AB'.repeat(32) }, { name: 'short', hash: 'aa' }, { hash: 'cd'.repeat(32) }],
    })
    try {
      const builds = readApprovedNodeBuilds()
      expect(builds.os).toContainEqual(os)
      expect(builds.os.some((item) => item.name === 'bad os')).toBe(false)
      expect(builds.osImages).toContainEqual(APPROVED_OS_IMAGES[0])
      expect(builds.osImages).toContainEqual(osImage)
      expect(builds.osImages.some((item) => item.name === 'uppercase' || item.name === 'short')).toBe(false)
    } finally {
      delete process.env['ANTSEED_VERIFIER_NODE_BUILDS']
    }
  })
})
