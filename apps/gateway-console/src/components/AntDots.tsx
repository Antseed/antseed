import { useEffect, useRef } from 'react'
import { isDarkNow } from '../app/theme'
import antIconUrl from '../assets/ant-icon.svg?url'

/*
 * The homepage's dot-grid ant (apps/website/src/components/HomeHero.tsx,
 * HeroDotCanvas), small and calm for the bottom of the nav: a faint dot grid
 * from the window's left edge to the nav's, the ant rising from the bottom
 * edge in stronger dots, and a few of its dots twinkling Antseed green now
 * and then. The grid fades out upwards and to the right (see .gc-antdots). Static under reduced motion; paused
 * while the tab is hidden.
 */

/** The website's grid dot colours, a stronger tone for the ant's own dots, and the sparkle green. */
const DOT_LIGHT = [213, 217, 215] as const
const DOT_DARK = [197, 208, 203] as const
const ANT_LIGHT = [150, 156, 153] as const
const ANT_DARK = [150, 160, 155] as const
const SPARKLE = [16, 185, 129] as const
const STEP = 6
const RADIUS = 1.7
/** The icon's aspect ratio (viewBox 15.27 × 18), rasterized at this height for alpha sampling. */
const ANT_H = 400
const ANT_W = Math.round((15.2738 / 18) * ANT_H)
const SAMPLES = [-3, 0, 3]

interface Dot { x: number; y: number; ant: number; size: number; twinkleAt: number; twinkleEvery: number }

export function AntDots() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return undefined
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let dots: Dot[] = []
    let width = 0
    let height = 0
    let frame = 0
    let disposed = false

    const raster = document.createElement('canvas')
    raster.width = ANT_W
    raster.height = ANT_H
    const rasterCtx = raster.getContext('2d')
    let alpha: Uint8ClampedArray | null = null

    const coverage = (x: number, y: number): number => {
      if (!alpha) return 0
      let hit = 0
      let total = 0
      for (const dy of SAMPLES) {
        const py = Math.round(y + dy)
        if (py < 0 || py >= ANT_H) continue
        for (const dx of SAMPLES) {
          const px = Math.round(x + dx)
          if (px < 0 || px >= ANT_W) continue
          total += 1
          if (alpha[(py * ANT_W + px) * 4 + 3]! > 40) hit += 1
        }
      }
      return total ? hit / total : 0
    }

    const layout = () => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // The ant is centred under the nav column and rises from the bottom
      // edge: its top three quarters show, the rest is cut off below.
      const rail = canvas.parentElement?.getBoundingClientRect()
      const centerX = rail ? rail.left + rail.width / 2 - rect.left : width / 2
      const scale = (0.95 * height) / ANT_H
      const left = centerX - (ANT_W * scale) / 2
      const top = height - 0.75 * ANT_H * scale
      const next: Dot[] = []
      for (let y = STEP / 2; y < height; y += STEP) {
        for (let x = STEP / 2; x < width; x += STEP) {
          const ant = coverage((x - left) / scale, (y - top) / scale)
          next.push({
            x, y, ant,
            size: ant > 0 ? (0.45 + 0.55 * ant) * (0.85 + 0.3 * Math.random()) : 0.8,
            // About one ant dot in twenty twinkles, each on its own slow cycle.
            twinkleAt: ant > 0 && Math.random() < 0.05 ? Math.random() * 600 : -1,
            twinkleEvery: 420 + Math.random() * 480,
          })
        }
      }
      dots = next
    }

    const draw = () => {
      const dark = isDarkNow()
      const grid = dark ? DOT_DARK : DOT_LIGHT
      const antTone = dark ? ANT_DARK : ANT_LIGHT
      ctx.clearRect(0, 0, width, height)
      for (const dot of dots) {
        let pulse = 0
        if (dot.twinkleAt >= 0 && !reducedMotion) {
          const t = (frame - dot.twinkleAt) % dot.twinkleEvery
          if (t >= 0 && t < 40) pulse = Math.sin((t / 40) * Math.PI)
        }
        const radius = RADIUS * dot.size * (1 + 0.5 * pulse)
        if (pulse > 0.02) {
          ctx.beginPath()
          ctx.fillStyle = `rgba(${SPARKLE.join(',')},${0.18 * pulse})`
          ctx.arc(dot.x, dot.y, radius * (1 + 1.4 * pulse), 0, 2 * Math.PI)
          ctx.fill()
        }
        const mix = pulse * 0.8
        const base = dot.ant > 0 ? antTone : grid
        const [r, g, b] = base.map((c, i) => Math.round(c + (SPARKLE[i]! - c) * mix))
        ctx.beginPath()
        ctx.fillStyle = `rgba(${r},${g},${b},${dot.ant > 0 ? 0.85 + 0.15 * pulse : dark ? 0.16 : 0.45})`
        ctx.arc(dot.x, dot.y, radius, 0, 2 * Math.PI)
        ctx.fill()
      }
    }

    let raf = 0
    let last = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      // ~30 fps is plenty for a slow twinkle.
      if (now - last < 33 || document.visibilityState !== 'visible') return
      last = now
      frame += 1
      draw()
    }

    const image = new Image()
    image.onload = () => {
      if (disposed || !rasterCtx) return
      rasterCtx.drawImage(image, 0, 0, ANT_W, ANT_H)
      alpha = rasterCtx.getImageData(0, 0, ANT_W, ANT_H).data
      layout()
      draw()
      if (!reducedMotion) raf = requestAnimationFrame(tick)
    }
    image.src = antIconUrl

    const resize = new ResizeObserver(() => { layout(); draw() })
    resize.observe(canvas)
    // Redraw in the other palette when the theme flips.
    const theme = new MutationObserver(() => draw())
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = window.matchMedia?.('(prefers-color-scheme: dark)')
    scheme?.addEventListener('change', draw)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      resize.disconnect()
      theme.disconnect()
      scheme?.removeEventListener('change', draw)
    }
  }, [])

  return <canvas ref={canvasRef} className="gc-antdots" aria-hidden="true" />
}
