/**
 * A submit handler for a form that can open inside another form's dialog (a
 * seller list edited from a key's policy editor): it runs only this form's
 * action. React submit events bubble through the component tree, portals
 * included, so without `stopPropagation` the enclosing form would submit too.
 */
export function submitOnly(run: () => void) {
  return (event: { preventDefault(): void; stopPropagation(): void }): void => {
    event.preventDefault()
    event.stopPropagation()
    run()
  }
}
