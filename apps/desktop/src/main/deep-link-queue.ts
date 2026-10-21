/**
 * Holds the invite from an `antseed://invite` link until a renderer that
 * listens for it is ready. A renderer is ready once it subscribed to
 * `referral:deep-link` and then asked for the held invite; it stops being
 * ready when it navigates, reloads or is destroyed, until it asks again.
 * Kept free of Electron so the handshake can be tested.
 */
export class InviteLinkQueue<Renderer> {
  private pending: string | null = null;
  private ready: Renderer | null = null;

  constructor(private readonly send: (renderer: Renderer, invite: string) => void) {}

  /** A link arrived: push it to `current` when it is ready, else hold it. */
  receive(invite: string, current: Renderer | null): void {
    if (current !== null && current === this.ready) {
      this.send(current, invite);
      this.pending = null;
    } else {
      this.pending = invite;
    }
  }

  /** `renderer` listens now and takes the held invite; later links are pushed to it. */
  take(renderer: Renderer): string | null {
    this.ready = renderer;
    const invite = this.pending;
    this.pending = null;
    return invite;
  }

  /** `renderer` navigated, reloaded or was destroyed: hold links until it asks again. */
  reset(renderer: Renderer): void {
    if (this.ready === renderer) this.ready = null;
  }
}
