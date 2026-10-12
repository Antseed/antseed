# @antseed/website

Marketing and documentation website for Antseed.

## Development

```bash
pnpm run dev    # Start dev server
pnpm run build  # Production build with static route generation
```

## Tech Stack

- React 18 + React Router
- Tailwind CSS
- Vite
- TypeScript

## Routes

| Route | Description |
|-------|-------------|
| `/` | Home page |
| `/docs/:section` | Documentation pages |
| `/docs/lightpaper` | Lightpaper |

## Static Routes

Production builds generate static HTML for all routes via `scripts/static-routes.js`, enabling SEO and fast initial loads.
