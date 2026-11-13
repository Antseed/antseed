# @antseed/ui

React primitives, brand marks and the `--as-*` / `.as-*` stylesheet for desktop, gateway-console, payments and ants. It ships as source: `build` only typechecks, and each app compiles it. Apps style `.as-*` classes and Modal and Drawer DOM directly, so no compiler catches a rename. ants loads no stylesheet and restyles Modal in `apps/ants/web/src/styles/_components.scss`.

| Rule | Enforced by |
| --- | --- |
| A model family beats its transport slug. | `apps/desktop/src/renderer/ui/components/brand/BrandIcon.test.ts` |
| Theme through source variables (`--accent`, `--radius-md`). The `--as-*` mapping is also declared on `body` for desktop's `body.dark-theme`, so a `:root` override of those tokens does nothing. | review only |
| Modal renders in place and an open Drawer has a `transform`, so a Modal inside a Drawer is clipped to it. Render it as a sibling. | review only |
| Keep panel, FocusLock, RemoveScroll nesting: `useDialogBehavior` finds focus guards by `parentElement.parentElement`. | review only |
| Escape closes the dialog even with an ActionMenu open inside it. | review only |
| Primitives work on React 18 and 19. The 18 apps need `resolve.dedupe`. `dialogStack` is module state: one copy of this package only. | review only |

**Ask first:** renaming a `.as-*` class or `--as-*` token; changing Modal or Drawer DOM; dropping React 18.

**Prove it:** no tests here. Run `typecheck` here, `typecheck` and `test` in gateway-console, payments and ants, and `typecheck:renderer` and `test:renderer` in desktop.
