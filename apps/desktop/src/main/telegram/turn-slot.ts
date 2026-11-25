/**
 * The one Telegram turn that may run at a time. A turn takes the slot the
 * moment its message arrives, before the chat or its model is looked up, so a
 * second message sent meanwhile is turned away rather than racing it, and
 * /stop or /new can cancel a turn that is still being set up.
 */
export class TurnSlot<T extends { cancelled: boolean }> {
  private turn: T | null = null;

  get current(): T | null {
    return this.turn;
  }

  /** False when another turn holds the slot. */
  reserve(turn: T): boolean {
    if (this.turn) return false;
    this.turn = turn;
    return true;
  }

  /** Whether `turn` still holds the slot and wasn't cancelled: checked after every wait. */
  owns(turn: T): boolean {
    return this.turn === turn && !turn.cancelled;
  }

  /** Cancels whatever holds the slot and frees it; returns it. */
  cancel(): T | null {
    const turn = this.turn;
    if (turn) turn.cancelled = true;
    this.turn = null;
    return turn;
  }

  /** Frees the slot if `turn` still holds it. */
  release(turn: T): void {
    if (this.turn === turn) this.turn = null;
  }
}
