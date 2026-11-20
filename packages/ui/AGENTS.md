# @antseed/ui

React primitives, brand marks and the `--as-*` / `.as-*` stylesheet for desktop, gateway-console, payments and ants. It ships as source: `build` only typechecks, and each app compiles it. Apps style `.as-*` classes and Modal and Drawer DOM directly, so no compiler catches a rename. ants loads no stylesheet and restyles Modal in `apps/ants/web/src/styles/_components.scss`.

Private, never published. Browser only (React 18 or 19). Build from these primitives, and extend one with a prop instead of copying it or overriding it with CSS (root `AGENTS.md`, UI).

## Inside

- `src/index.ts` is the only entry and lists every primitive; reuse one before writing a component. `@antseed/ui/styles` is `src/styles/index.scss`.
- A new primitive goes in `src/primitives/`, its styles in `index.scss` under a new `.as-<name>` block, and its exports in `src/index.ts`.
- Tokens are declared in `src/styles/index.scss`; each `--as-*` falls back through an app source variable to a default.
- Brand marks: `src/brand/BrandIcon.tsx` and `src/brand/model-families.ts`.

| Rule | Enforced by |
| --- | --- |
| A model family beats its transport slug. | `apps/desktop/src/renderer/ui/components/brand/BrandIcon.test.ts` |
| Theme through source variables (`--accent`, `--radius-md`). The `--as-*` mapping is also declared on `body` for desktop's `body.dark-theme`, so a `:root` override of those tokens does nothing. | review only |
| Modal renders in place and an open Drawer has a `transform`, so a Modal inside a Drawer is clipped to it. Render it as a sibling. | review only |
| Keep panel, FocusLock, RemoveScroll nesting: `useDialogBehavior` finds focus guards by `parentElement.parentElement`. | review only |
| Escape closes the dialog even with an ActionMenu open inside it. | review only |
| Primitives work on React 18 and 19. The 18 apps need `resolve.dedupe`. `dialogStack` is module state: one copy of this package only. | review only |
| One `<Button variant="brand">` per screen, for its main action. Everything else is neutral. | review only |
| Consumers list it in `devDependencies`: it is private and source-only, and the desktop packs every runtime dependency into its asar. | review only |

## Connections

- Imported by `apps/desktop` (React 19), `apps/gateway-console`, `apps/payments` and `apps/ants` (React 18). gateway-console also compiles ants' web source through its Vite alias.
- Private, so `scripts/npm-publish-plan.mjs` cannot see a change here; it ships only when the apps that bundle it are bumped.
- `ANTSEED_RAINBOWKIT_NEUTRAL` in `packages/wallet-config` reads `--as-accent` and `--as-accent-contrast`. `BrandKey` names match profile names in `packages/connected-apps/src/defaults.ts`; a new tool there usually wants a key here.

## Traps

- The mapping once lived only on `:root`, so desktop's dark theme never reached the primitives. Check both themes after a token change.
- `resolveBrandKey` takes the first matcher that hits (`MATCHERS`), so order is behavior. Short names match whole words only.
- `Alert` tones other than `info` tint the box. A tinted `Alert` is not a calm notice.
- `ActionMenu` closes when the page scrolls but not when its own list scrolls; a long menu used to close under the pointer.
- `Button` with `href` and `disabled` renders a disabled `<button>`, so it can't navigate.
- This package's `typecheck` uses React 18 types while desktop compiles it against 19. Run both.

**Ask first:** renaming a `.as-*` class or `--as-*` token; changing Modal or Drawer DOM; dropping React 18.

**Prove it:** no tests here. Run `typecheck` here, `typecheck` and `test` in gateway-console, payments and ants, and `typecheck:renderer` and `test:renderer` in desktop.
