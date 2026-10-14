import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { defaultRehypePlugins, type StreamdownProps } from 'streamdown'

type RehypePlugins = NonNullable<StreamdownProps['rehypePlugins']>
type RehypePlugin = Extract<RehypePlugins[number], (...args: never[]) => unknown>

// Mermaid and CJK plugins dropped to keep the console bundle small (the gateway serves it):
// the mermaid library is never bundled and mermaid fences render as code. The build still
// emits `mermaid-*` assets, but those are Shiki's mermaid grammar (highlighting) and
// Streamdown's own shared chunk, which Rollup names after its lazy Mermaid wrapper.
export const streamdownPlugins = { code, math }

const [harden, hardenOptions] = defaultRehypePlugins['harden'] as [RehypePlugin, object]

/**
 * Streamdown's default rehype chain, except no remote or data: images: chat
 * markdown comes from a seller, and an `<img>` pointing at its server would
 * beacon whatever the model put in the URL out of the console.
 */
export const streamdownRehypePlugins: RehypePlugins = [
  defaultRehypePlugins['raw']!,
  defaultRehypePlugins['sanitize']!,
  [harden, { ...hardenOptions, allowedImagePrefixes: [], allowDataImages: false }],
]
