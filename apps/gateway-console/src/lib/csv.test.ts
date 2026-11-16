import { describe, expect, it } from 'vitest'
import { csvCell } from './csv'

describe('csvCell', () => {
  it('keeps text that a spreadsheet would run as a formula as text', () => {
    expect(csvCell('=HYPERLINK("http://x.test","a")')).toBe(`"'=HYPERLINK(""http://x.test"",""a"")"`)
    expect(csvCell('+1+2')).toBe("'+1+2")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('  =1+1')).toBe("'  =1+1")
    expect(csvCell('\t=1')).toBe("'\t=1")
  })

  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('Northwind, Inc.')).toBe('"Northwind, Inc."')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('a\nb')).toBe('"a\nb"')
    expect(csvCell('a\rb')).toBe('"a\rb"')
  })

  it('leaves numbers and amounts alone', () => {
    expect(csvCell(42)).toBe('42')
    expect(csvCell('4.000000')).toBe('4.000000')
    expect(csvCell('-0.010000')).toBe('-0.010000')
    expect(csvCell('qwen3-coder')).toBe('qwen3-coder')
  })
})
