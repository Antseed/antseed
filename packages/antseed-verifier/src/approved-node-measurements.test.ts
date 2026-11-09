import { describe, it, expect } from 'vitest'
import { APPROVED_DSTACK_OS } from './approved-node-measurements.js'

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
