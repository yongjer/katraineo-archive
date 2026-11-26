// Scrolling over the board steps through the game, one move per mouse wheel notch. A touchpad instead sends a
// stream of small deltas, and keeps sending them after the fingers lift, which would skip dozens of moves per swipe
// if every event were a move. So the first event of a scroll is a move, and after that every WHEEL_STEP pixels are.

/** Pixels of continuous scrolling per move. A mouse wheel notch is about 100 pixels in Chromium. */
export const WHEEL_STEP = 100;
/** A pause this long (ms) without wheel events ends a scroll, so the next notch moves right away. */
export const WHEEL_GAP_MS = 120;

const LINE_PIXELS = 40;
const PAGE_PIXELS = 800;

export class WheelStepper {
  private accumulated = 0;
  private direction = 0;
  private lastTime = -Infinity;

  /**
   * Feed one wheel event (`deltaMode` as in WheelEvent: 0 pixels, 1 lines, 2 pages; `time` in ms).
   * Returns 1 to go forward a move, -1 to go back one, or 0 to do nothing.
   */
  step(deltaY: number, deltaMode: number, time: number): -1 | 0 | 1 {
    const pixels = deltaY * (deltaMode === 1 ? LINE_PIXELS : deltaMode === 2 ? PAGE_PIXELS : 1);
    const direction = Math.sign(pixels);
    if (!direction) return 0;
    const newScroll = time - this.lastTime > WHEEL_GAP_MS || direction !== this.direction;
    this.lastTime = time;
    this.direction = direction;
    this.accumulated = newScroll ? WHEEL_STEP : this.accumulated + Math.abs(pixels);
    if (this.accumulated < WHEEL_STEP) return 0;
    this.accumulated = 0;
    return direction > 0 ? 1 : -1;
  }
}
