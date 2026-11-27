/** Whether a pointer is a finger. A finger has no cursor, so the seed waits on the ground for it and a tap feeds the mascot. A mouse
 *  and a pen both hover and point, so they carry the seed in hand, on any screen. */
export const isFinger = (pointerType: string): boolean => pointerType === 'touch';
