// ==========================================================================================
// PURE plate-art layout.  No MobX, no React, no DOM - given a plate's stack this works out
// where each layer sits, so the maths can be unit tested directly (see plateArt.spec.ts).
//
// Every number here is expressed in the AUTHORING CANVAS coordinate system described in
// assets/ASSETS.md (512 x 384, y measured down from the top).  The renderer scales design
// units to real pixels; nothing in this file knows or cares what size it ends up on screen.
// ==========================================================================================

import { INGREDIENTS } from "./sushiSyncLogic";

// ------------------------------------------------------------------------------------------
// The authoring canvas
// ------------------------------------------------------------------------------------------

/** Width of every ingredient/dish PNG.  All layers share one canvas so compositing is a
 *  straight stack with no per-asset offset metadata. */
export const PLATE_ART_WIDTH = 512;

/** Height of every ingredient/dish PNG.  4:3 rather than square because the subject - a wide
 *  shallow dish with a modest stack on it - is genuinely wider than it is tall.  A square
 *  canvas spent ~45% of its pixels on empty air above a typical 3-layer plate. */
export const PLATE_ART_HEIGHT = 384;

/** The SEAT LINE: the y at which the bottom-most layer rests on the dish.  Every ingredient
 *  is drawn sitting on this line in its own file, which is what makes the layers stackable in
 *  any order without per-pair registration data. */
export const SEAT_Y = 292;

/** How far above the seat line an ingredient's body may extend.  Chunky ingredients (a rice
 *  mound) use all of it; thin ones (a sesame sprinkle) use a fraction. */
export const BAND_MAX_HEIGHT = 100;

/** Left edge of the layer band.  Ingredients are narrower than the dish, so the dish reads as
 *  a dish rather than as a tray the food is flush with. */
export const BAND_X = 80;

/** Width of the layer band. */
export const BAND_WIDTH = 352;

/** How far below the seat line a sauce or scatter may overhang. */
export const DRIP_DEPTH = 12;

// ------------------------------------------------------------------------------------------
// Per-ingredient rise
// ------------------------------------------------------------------------------------------

/**
 * How much VERTICAL HEIGHT each ingredient contributes to the stack above it.
 *
 * This is deliberately NOT a single constant.  A sesame sprinkle lifting the next layer as far
 * as a rice mound would look absurd, and the stack silhouette is a big part of how a chef
 * recognises a plate at a glance from across the table.  Rise is a property of the ingredient,
 * so it lives next to the ingredient list rather than in the renderer.
 *
 * Rise is SMALLER than the drawn body height on purpose - layers overlap, exactly as a real
 * stack does.  A nori sheet drawn 40px tall with a rise of 18 shows its top 18px once rice
 * lands on it, and that sliver of dark green under the rice is the visual cue.
 */
export const INGREDIENT_RISE: Readonly<Record<string, number>> = {
  // Base - flat sheets, barely lift anything
  nori: 18,
  soypaper: 18,

  // Binder - the mound that gives a roll its bulk
  whiterice: 56,
  brownrice: 56,

  // Filling - slices and batons
  salmon: 34,
  tuna: 34,
  eel: 34,
  cucumber: 30,
  avocado: 30,

  // Topping - scatters and drizzles sit almost flat
  tobiko: 16,
  spicymayo: 12,
  eelsauce: 12,
  sesame: 10,
};

/** Fallback for an ingredient with no tuned rise, so adding one to INGREDIENTS without
 *  touching this table degrades to something sane instead of collapsing the stack. */
export const DEFAULT_RISE = 34;

export function riseFor(ingredientId: string): number {
  return INGREDIENT_RISE[ingredientId] ?? DEFAULT_RISE;
}

/**
 * The tallest cumulative rise we will draw before squashing the stack.
 *
 * Sized so the TOP layer's body still fits on canvas: its seat lands at
 * SEAT_Y - RISE_BUDGET = 100, and it may extend BAND_MAX_HEIGHT (100) above that, reaching
 * y=0 exactly.  Anything taller would be clipped by the frame.
 *
 * For scale: the longest legal recipe (5 layers, nori+rice+two fillings+topping) tops out
 * around 142, so compression never fires on a real order - only on deliberate over-stacking.
 */
export const RISE_BUDGET = SEAT_Y - BAND_MAX_HEIGHT;

// ------------------------------------------------------------------------------------------
// Stack layout
// ------------------------------------------------------------------------------------------

export interface PlateLayer {
  /** Ingredient id, as it appears in INGREDIENTS and as the PNG filename. */
  id: string;
  /** Position in the stack.  Doubles as paint order / z-index. */
  index: number;
  /** Design-space pixels this layer is lifted ABOVE the seat line.  0 for the bottom layer. */
  offsetY: number;
}

export interface PlateLayout {
  layers: PlateLayer[];
  /** True when the stack was too tall for the frame and every rise got scaled down.  Only
   *  reachable via deliberate over-stacking (duplicates are legal up to MAX_STACK_HEIGHT). */
  compressed: boolean;
  /** Design-space height from the seat line to the top layer's seat. */
  stackHeight: number;
}

/**
 * Work out where every layer of a plate sits.
 *
 * PAINT ORDER IS ARRAY ORDER.  This is the single most important rule in the whole art
 * system: `stack` is the sequence the chefs actually applied, out-of-order layering is legal
 * (see DESIGN.md), and the visible stack is what lets an attentive chef notice a mistake
 * before it is served.  Sorting into canonical Base->Binder->Filling->Topping order here would
 * make a flawed plate render identically to a perfect one and quietly delete the game's
 * central feedback loop.  Nori stacked on top of tobiko is SUPPOSED to look wrong.
 *
 * A layer's offset is the sum of the rises BELOW it, so the ingredients themselves decide how
 * tall the tower gets.
 */
export function layoutStack(stack: string[]): PlateLayout {
  if (stack.length === 0) return { layers: [], compressed: false, stackHeight: 0 };

  // Offset of layer i is the total rise of everything under it, so the last entry of this
  // running sum is the height of the whole stack.
  const offsets: number[] = [];
  let running = 0;
  for (let i = 0; i < stack.length; i++) {
    offsets.push(running);
    running += riseFor(stack[i]);
  }
  const rawHeight = offsets[offsets.length - 1];

  // Duplicates are legal, so eight rice is reachable and would tower straight off the top of
  // the frame.  Squash proportionally rather than clipping: a crammed tower still reads as a
  // tower, and every layer stays visible and in order.
  const compressed = rawHeight > RISE_BUDGET;
  const scale = compressed ? RISE_BUDGET / rawHeight : 1;

  return {
    layers: stack.map((id, index) => ({ id, index, offsetY: offsets[index] * scale })),
    compressed,
    stackHeight: rawHeight * scale,
  };
}

/** Every ingredient id that has art, for preloading and for asset-manifest completeness specs. */
export const ART_INGREDIENT_IDS: string[] = INGREDIENTS.map((i) => i.id);
