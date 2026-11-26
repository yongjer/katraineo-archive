import { describe, expect, it } from "vitest";
import { WheelStepper, WHEEL_GAP_MS } from "../src/ui/wheel";

/** Feed events of `delta` pixels, `interval` ms apart; returns the moves made, e.g. [1, 1]. */
function scroll(stepper: WheelStepper, deltas: number[], interval: number, start = 0, deltaMode = 0) {
  return deltas.map((d, i) => stepper.step(d, deltaMode, start + i * interval)).filter((s) => s !== 0);
}

describe("scrolling over the board", () => {
  it("moves once per mouse wheel notch, also when the wheel is spun quickly", () => {
    expect(scroll(new WheelStepper(), [100, 100, 100, 100], 30)).toEqual([1, 1, 1, 1]);
    expect(scroll(new WheelStepper(), [-100, -100], 30)).toEqual([-1, -1]);
  });

  it("moves for every separate notch, however small its delta", () => {
    // e.g. a mouse wheel in WebKit on macOS
    expect(scroll(new WheelStepper(), [4, 4, 4], WHEEL_GAP_MS + 100)).toEqual([1, 1, 1]);
  });

  it("moves a few times for a touchpad swipe, not once per event", () => {
    // a swipe of 480 pixels as 60 events, one per frame
    const moves = scroll(new WheelStepper(), Array(60).fill(8), 16);
    expect(moves).toEqual([1, 1, 1, 1, 1]);
  });

  it("moves right away when the direction changes", () => {
    const stepper = new WheelStepper();
    expect(scroll(stepper, [8, 8, 8], 16)).toEqual([1]);
    expect(stepper.step(-8, 0, 3 * 16)).toBe(-1);
  });

  it("counts lines and pages as pixels", () => {
    const stepper = new WheelStepper();
    expect(scroll(stepper, [1, 1, 1, 1], 16, 0, 1)).toEqual([1, 1]); // 40 pixels each: the first, then 120 more
    expect(stepper.step(0.2, 2, 4 * 16)).toBe(1); // 160 pixels
  });

  it("ignores events without vertical movement", () => {
    expect(new WheelStepper().step(0, 0, 0)).toBe(0);
  });
});
