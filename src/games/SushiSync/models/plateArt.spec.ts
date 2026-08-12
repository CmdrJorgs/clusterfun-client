import {
  BAND_MAX_HEIGHT,
  DEFAULT_RISE,
  INGREDIENT_RISE,
  PLATE_ART_HEIGHT,
  RISE_BUDGET,
  SEAT_Y,
  layoutStack,
  riseFor,
} from "./plateArt";
import { INGREDIENTS } from "./sushiSyncLogic";
import { MAX_STACK_HEIGHT } from "./GameSettings";

describe("plateArt geometry", () => {
  it("keeps the seat line and layer band inside the canvas", () => {
    expect(SEAT_Y).toBeLessThan(PLATE_ART_HEIGHT);
    expect(SEAT_Y - BAND_MAX_HEIGHT).toBeGreaterThanOrEqual(0);
  });

  it("sizes the rise budget so a maximally tall stack still fits the frame", () => {
    // Top layer seats at SEAT_Y - RISE_BUDGET and extends BAND_MAX_HEIGHT above that.
    expect(SEAT_Y - RISE_BUDGET - BAND_MAX_HEIGHT).toBeGreaterThanOrEqual(0);
  });

  it("has a tuned rise for every ingredient in the game", () => {
    // Art and rules drifting apart is the failure this catches: add an ingredient to
    // INGREDIENTS and forget the rise, and its layers would all pile at one height.
    for (const ingredient of INGREDIENTS) {
      expect(INGREDIENT_RISE[ingredient.id]).toBeGreaterThan(0);
    }
  });

  it("falls back to a sane rise for an unknown ingredient", () => {
    expect(riseFor("wasabi-that-does-not-exist-yet")).toBe(DEFAULT_RISE);
  });
});

describe("layoutStack", () => {
  it("returns nothing for an empty plate", () => {
    const layout = layoutStack([]);
    expect(layout.layers).toEqual([]);
    expect(layout.stackHeight).toBe(0);
    expect(layout.compressed).toBe(false);
  });

  it("seats the bottom layer on the seat line", () => {
    const layout = layoutStack(["nori", "whiterice"]);
    expect(layout.layers[0].offsetY).toBe(0);
  });

  it("lifts each layer by the total rise of everything beneath it", () => {
    const layout = layoutStack(["nori", "whiterice", "salmon"]);
    expect(layout.layers.map((l) => l.offsetY)).toEqual([
      0,
      INGREDIENT_RISE.nori,
      INGREDIENT_RISE.nori + INGREDIENT_RISE.whiterice,
    ]);
  });

  it("PRESERVES STACK ORDER rather than sorting into canonical layer order", () => {
    // This is the load-bearing test for the whole art system.  Out-of-order layering is legal
    // and becomes a flawed serve; if the renderer sorted layers into Base->Binder->Filling
    // order, a wrong plate would look identical to a right one and the player would lose the
    // only cue they get.  See DESIGN.md "Legibility".
    const wrongOrder = layoutStack(["tobiko", "nori"]);
    expect(wrongOrder.layers.map((l) => l.id)).toEqual(["tobiko", "nori"]);
    // ...and the nori genuinely sits above the tobiko, which is what looks wrong on screen.
    expect(wrongOrder.layers[1].offsetY).toBeGreaterThan(wrongOrder.layers[0].offsetY);
  });

  it("keeps index in sync with paint order so it can drive z-index", () => {
    const layout = layoutStack(["nori", "whiterice", "eel", "eelsauce"]);
    expect(layout.layers.map((l) => l.index)).toEqual([0, 1, 2, 3]);
  });

  it("does not compress a realistic five-layer recipe", () => {
    const layout = layoutStack(["nori", "whiterice", "salmon", "avocado", "tobiko"]);
    expect(layout.compressed).toBe(false);
    expect(layout.stackHeight).toBeLessThanOrEqual(RISE_BUDGET);
  });

  it("compresses a deliberate tower so it stays inside the frame", () => {
    // Duplicates are legal (PresenterModel only caps total length), so a chef who owns rice
    // can build a rice skyscraper.  It must squash, not overflow.
    const tower = new Array(MAX_STACK_HEIGHT).fill("whiterice");
    const layout = layoutStack(tower);

    expect(layout.compressed).toBe(true);
    expect(layout.stackHeight).toBeCloseTo(RISE_BUDGET, 5);
    expect(layout.layers).toHaveLength(MAX_STACK_HEIGHT);

    const top = layout.layers[layout.layers.length - 1];
    expect(SEAT_Y - top.offsetY - BAND_MAX_HEIGHT).toBeGreaterThanOrEqual(0);
  });

  it("keeps layers strictly ascending even when compressed", () => {
    const tower = new Array(MAX_STACK_HEIGHT).fill("whiterice");
    const offsets = layoutStack(tower).layers.map((l) => l.offsetY);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
  });

  it("never lets any legal stack escape the top of the canvas", () => {
    // Brute force over the nastiest stacks the rules permit: every ingredient, repeated to the
    // cap.  None may draw above y=0.
    for (const ingredient of INGREDIENTS) {
      const stack = new Array(MAX_STACK_HEIGHT).fill(ingredient.id);
      const layout = layoutStack(stack);
      const top = layout.layers[layout.layers.length - 1];
      expect(SEAT_Y - top.offsetY - BAND_MAX_HEIGHT).toBeGreaterThanOrEqual(0);
    }
  });
});
