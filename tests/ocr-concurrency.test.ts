import { describe, expect, it } from "vitest";
import { runPool } from "../src/lib/pipeline/extract";

describe("bounded page pool", () => {
  it("runs every item and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield so other workers can start; this is what would expose an
      // unbounded Promise.all.
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(n);
      inFlight -= 1;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  it("stays sequential at a limit of one", async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool([1, 2, 3], 1, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  it("handles an empty page list and a bad limit", async () => {
    await expect(runPool([], 4, async () => {})).resolves.toBeUndefined();
    await expect(runPool([1], 0, async () => {})).resolves.toBeUndefined();
  });
});
