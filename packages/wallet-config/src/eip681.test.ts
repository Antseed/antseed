import { describe, expect, it } from 'vitest'
import { buildUsdcPaymentUri as buildPaymentUri, usdcAmountToBaseUnits as amountToBaseUnits } from './index'

const target = { usdcAddress: '0x0000000000000000000000000000000000000101', chainId: 8453, address: '0x0000000000000000000000000000000000000001' }

describe('EIP-681 payment URI', () => {
  it('builds a prefilled USDC transfer', () => {
    expect(buildPaymentUri(target, '12.5')).toBe(
      'ethereum:0x0000000000000000000000000000000000000101@8453/transfer?address=0x0000000000000000000000000000000000000001&uint256=12500000',
    )
  })
  it('omits the amount when blank or invalid', () => {
    const base = 'ethereum:0x0000000000000000000000000000000000000101@8453/transfer?address=0x0000000000000000000000000000000000000001'
    expect(buildPaymentUri(target, '')).toBe(base)
    expect(buildPaymentUri(target, 'abc')).toBe(base)
    expect(buildPaymentUri(target, '0')).toBe(base)
    expect(buildPaymentUri(target, '-3')).toBe(base)
  })
  it('converts dollars to 6-decimal base units exactly', () => {
    expect(amountToBaseUnits('1')).toBe(1_000_000n)
    expect(amountToBaseUnits('0.000001')).toBe(1n)
    expect(amountToBaseUnits('0.1')).toBe(100_000n)
    expect(amountToBaseUnits('19.99')).toBe(19_990_000n)
    expect(amountToBaseUnits(' 5. ')).toBe(5_000_000n)
    expect(amountToBaseUnits('.5')).toBe(500_000n)
    expect(amountToBaseUnits('.')).toBeNull()
    expect(amountToBaseUnits('')).toBeNull()
    expect(amountToBaseUnits('1.0000001')).toBeNull()
    expect(amountToBaseUnits('1e3')).toBeNull()
  })
})
