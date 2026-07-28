import {
  PAYOUT_BASE,
  PAYOUT_PARTIAL_FRACTION,
  PAYOUT_PER_LAYER,
  PAYOUT_WRONG_ORDER_FRACTION,
  SPEED_TIP_MAX_FRACTION,
  SPEED_TIP_THRESHOLD,
  STRIKE_FOR_FLAWED,
} from "./GameSettings";

// ==========================================================================================
// PURE Sushi Sync rules.  No MobX, no framework, no I/O - everything here is a function of
// its arguments so it can be unit tested directly (see sushiSyncLogic.spec.ts).  The models
// hold state and orchestrate; every DECISION lives in this file.
// ==========================================================================================

// ------------------------------------------------------------------------------------------
// Ingredients
// ------------------------------------------------------------------------------------------

export enum IngredientCategory {
  Base = "Base",
  Binder = "Binder",
  Filling = "Filling",
  Topping = "Topping",
}

/** Layers must be applied in this order.  Applying them out of order is legal but flawed. */
export const LAYER_ORDER: IngredientCategory[] = [
  IngredientCategory.Base,
  IngredientCategory.Binder,
  IngredientCategory.Filling,
  IngredientCategory.Topping,
];

export interface Ingredient {
  id: string;
  name: string;
  category: IngredientCategory;
}

// Two Bases and two Binders exist on purpose.  Ownership is exclusive, so a single mandatory
// ingredient (everything needs rice) would make its owner a hard bottleneck that every plate
// queues behind while the rest of the table idles.  See DESIGN.md.
export const INGREDIENTS: Ingredient[] = [
  { id: "nori", name: "Nori", category: IngredientCategory.Base },
  { id: "soypaper", name: "Soy Paper", category: IngredientCategory.Base },

  { id: "whiterice", name: "White Rice", category: IngredientCategory.Binder },
  { id: "brownrice", name: "Brown Rice", category: IngredientCategory.Binder },

  { id: "salmon", name: "Salmon", category: IngredientCategory.Filling },
  { id: "tuna", name: "Tuna", category: IngredientCategory.Filling },
  { id: "eel", name: "Eel", category: IngredientCategory.Filling },
  { id: "cucumber", name: "Cucumber", category: IngredientCategory.Filling },
  { id: "avocado", name: "Avocado", category: IngredientCategory.Filling },

  { id: "tobiko", name: "Tobiko", category: IngredientCategory.Topping },
  { id: "spicymayo", name: "Spicy Mayo", category: IngredientCategory.Topping },
  { id: "eelsauce", name: "Eel Sauce", category: IngredientCategory.Topping },
  { id: "sesame", name: "Sesame", category: IngredientCategory.Topping },
];

const INGREDIENTS_BY_ID = new Map(INGREDIENTS.map((i) => [i.id, i]));

export function ingredientById(id: string): Ingredient | undefined {
  return INGREDIENTS_BY_ID.get(id);
}

export function ingredientName(id: string): string {
  return INGREDIENTS_BY_ID.get(id)?.name ?? id;
}

export function ingredientsOfCategory(
  pool: Ingredient[],
  category: IngredientCategory,
): Ingredient[] {
  return pool.filter((i) => i.category === category);
}

// ------------------------------------------------------------------------------------------
// Randomness.  Callers pass an rng so tests are deterministic; the models pass the framework's
// randomDouble.  Anything that shuffles or picks takes it explicitly.
// ------------------------------------------------------------------------------------------

export type Rng = () => number; // returns [0, 1)

export function shuffled<T>(items: T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// ------------------------------------------------------------------------------------------
// Active ingredient set for a round
// ------------------------------------------------------------------------------------------

/**
 * Choose which ingredients are in play this round.
 *
 * Guarantees, in priority order:
 *  1. TWO Bases and TWO Binders whenever the pool can supply them, so that (a) no single chef
 *     is a mandatory bottleneck for every plate on the belt, and (b) recipes actually VARY.
 *     Playtest note: an earlier version used only one of each below 4 players, which made a
 *     3-player round 1 have just two possible orders in total - the board filled with
 *     identical "Soy Paper -> Brown Rice" tickets and the whole read-the-board mechanic
 *     stopped mattering. Variety in the mandatory layers is what keeps the shared screen
 *     worth looking at.
 *  2. At least one Filling and one Topping, so recipes can reach the longer lengths.
 *  3. At least `playerCount` ingredients total, so nobody is left with an empty palette.
 */
export function chooseActiveIngredients(
  playerCount: number,
  ingredientTarget: number,
  rng: Rng,
  pool: Ingredient[] = INGREDIENTS,
): Ingredient[] {
  const bases = shuffled(ingredientsOfCategory(pool, IngredientCategory.Base), rng);
  const binders = shuffled(ingredientsOfCategory(pool, IngredientCategory.Binder), rng);
  const fillings = shuffled(ingredientsOfCategory(pool, IngredientCategory.Filling), rng);
  const toppings = shuffled(ingredientsOfCategory(pool, IngredientCategory.Topping), rng);

  const anchorCount = 2;

  const chosen: Ingredient[] = [];
  chosen.push(...bases.slice(0, Math.min(anchorCount, bases.length)));
  chosen.push(...binders.slice(0, Math.min(anchorCount, binders.length)));
  if (fillings.length > 0) chosen.push(fillings[0]);
  if (toppings.length > 0) chosen.push(toppings[0]);

  // Remaining ingredients as filler, interleaving fillings and toppings so we get variety
  // across both flexible categories rather than draining one before touching the other.
  const chosenIds = new Set(chosen.map((i) => i.id));
  const remainingFillings = fillings.filter((i) => !chosenIds.has(i.id));
  const remainingToppings = toppings.filter((i) => !chosenIds.has(i.id));
  const remainingAnchors = [...bases, ...binders].filter((i) => !chosenIds.has(i.id));
  const rest: Ingredient[] = [];
  for (let i = 0; i < Math.max(remainingFillings.length, remainingToppings.length); i++) {
    if (i < remainingFillings.length) rest.push(remainingFillings[i]);
    if (i < remainingToppings.length) rest.push(remainingToppings[i]);
  }
  rest.push(...remainingAnchors);

  const target = clamp(Math.max(playerCount, ingredientTarget), chosen.length, pool.length);
  while (chosen.length < target && rest.length > 0) {
    chosen.push(rest.shift()!);
  }
  return chosen;
}

// ------------------------------------------------------------------------------------------
// Ingredient assignment - exclusive ownership
// ------------------------------------------------------------------------------------------

/**
 * Assign every active ingredient to exactly one player.
 *
 * Walks the categories in layer order, handing ingredients out round-robin over a shuffled
 * player list with a pointer that CARRIES ACROSS categories.  That continuity is what stops
 * one chef collecting both Bases (or both Binders) - consecutive same-category ingredients
 * always land on different players.
 *
 * Returns playerId -> ingredient ids.  Every player gets at least one entry provided
 * `active.length >= playerIds.length`, which chooseActiveIngredients guarantees.
 */
export function assignIngredients(
  playerIds: string[],
  active: Ingredient[],
  rng: Rng,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (playerIds.length === 0) return result;

  const order = shuffled(playerIds, rng);
  order.forEach((id) => result.set(id, []));

  let pointer = 0;
  for (const category of LAYER_ORDER) {
    for (const ingredient of ingredientsOfCategory(active, category)) {
      const owner = order[pointer % order.length];
      result.get(owner)!.push(ingredient.id);
      pointer++;
    }
  }
  return result;
}

/**
 * Sweep up any active ingredient that no CURRENT player owns and hand it to whichever
 * remaining chef carries the fewest.
 *
 * A chef dropping mid-round would otherwise take their exclusive ingredients with them and
 * every live order needing one becomes literally unwinnable.  This is deliberately stateless -
 * it derives orphans by comparing the active set against who is here right now, rather than
 * tracking departure events - so it is correct no matter HOW a player left (quit, timeout,
 * kicked) and is safe to run repeatedly.
 *
 * Ties break toward the earliest player in `playerIds`, so the result is deterministic.
 */
export function redistributeOrphanedIngredients(
  assignments: Map<string, string[]>,
  activeIngredientIds: string[],
  playerIds: string[],
): Map<string, string[]> {
  const next = new Map<string, string[]>();
  playerIds.forEach((id) => next.set(id, (assignments.get(id) ?? []).slice()));
  if (playerIds.length === 0) return next;

  const owned = new Set<string>();
  next.forEach((ids) => ids.forEach((id) => owned.add(id)));

  for (const ingredientId of activeIngredientIds) {
    if (owned.has(ingredientId)) continue;
    let target = playerIds[0];
    for (const candidate of playerIds) {
      if (next.get(candidate)!.length < next.get(target)!.length) target = candidate;
    }
    next.get(target)!.push(ingredientId);
    owned.add(ingredientId);
  }
  return next;
}

/**
 * Re-number seats to a gapless 0..N-1 ring while PRESERVING relative seating order, so that
 * when someone leaves the remaining chefs keep sitting in the same physical order they are
 * actually sitting in.  Belt math assumes stationCount === players.length with no holes.
 */
export function compactStations(
  entries: { playerId: string; stationIndex: number }[],
): Map<string, number> {
  const ordered = entries
    .slice()
    .sort((a, b) => a.stationIndex - b.stationIndex || a.playerId.localeCompare(b.playerId));
  const result = new Map<string, number>();
  ordered.forEach((entry, index) => result.set(entry.playerId, index));
  return result;
}

// ------------------------------------------------------------------------------------------
// Recipes
// ------------------------------------------------------------------------------------------

function pick<T>(items: T[], rng: Rng): T {
  return items[Math.floor(rng() * items.length)];
}

/**
 * Build a recipe from the ACTIVE set only, so every generated order is completable by the
 * current roster.  Always Base -> Binder first, then Fillings, then Toppings.
 */
export function generateRecipe(
  active: Ingredient[],
  minLength: number,
  maxLength: number,
  rng: Rng,
): string[] {
  const bases = ingredientsOfCategory(active, IngredientCategory.Base);
  const binders = ingredientsOfCategory(active, IngredientCategory.Binder);
  const fillings = shuffled(ingredientsOfCategory(active, IngredientCategory.Filling), rng);
  const toppings = shuffled(ingredientsOfCategory(active, IngredientCategory.Topping), rng);

  const recipe: string[] = [];
  if (bases.length > 0) recipe.push(pick(bases, rng).id);
  if (binders.length > 0) recipe.push(pick(binders, rng).id);

  // How many layers we can actually supply from the active set.
  const capacity = recipe.length + fillings.length + toppings.length;
  const low = clamp(minLength, recipe.length, capacity);
  const high = clamp(maxLength, low, capacity);
  const targetLength = low + Math.floor(rng() * (high - low + 1));
  const extras = targetLength - recipe.length;

  // Prefer at least one filling before reaching for toppings - sauce with no fish reads as a
  // bug rather than a dish.
  const fillingQuota = Math.min(fillings.length, Math.max(1, Math.ceil(extras / 2)));

  const tail: string[] = [];
  let fi = 0;
  let ti = 0;
  while (tail.length < extras) {
    if (fi < fillingQuota) {
      tail.push(fillings[fi++].id);
    } else if (ti < toppings.length) {
      tail.push(toppings[ti++].id);
    } else if (fi < fillings.length) {
      tail.push(fillings[fi++].id);
    } else {
      break;
    }
  }
  recipe.push(...tail);
  return recipe;
}

/** Flavor text for the order board.  Pure lookup over the recipe's contents. */
export function dishNameFor(recipe: string[]): string {
  const has = (id: string) => recipe.includes(id);
  if (has("eel") && has("avocado")) return "Dragon Roll";
  if (has("salmon") && has("avocado")) return "Philadelphia Roll";
  if (has("tuna") && has("spicymayo")) return "Spicy Tuna Roll";
  if (has("eel") && has("eelsauce")) return "Unagi Roll";
  if (has("salmon") && has("tobiko")) return "Sunrise Roll";
  if (has("cucumber") && !has("salmon") && !has("tuna") && !has("eel")) return "Kappa Maki";

  const filling = recipe
    .map(ingredientById)
    .find((i) => i?.category === IngredientCategory.Filling);
  if (filling) return `${filling.name} Roll`;
  return "Hosomaki";
}

// ------------------------------------------------------------------------------------------
// Serving and scoring
// ------------------------------------------------------------------------------------------

export type ServeResult = "exact" | "wrongOrder" | "incomplete";

export interface ScoredServe {
  result: ServeResult;
  payout: number;
  strikeDelta: number;
}

export function basePayoutFor(recipeLength: number): number {
  return PAYOUT_BASE + PAYOUT_PER_LAYER * recipeLength;
}

export function sameSequence(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  a.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1));
  for (const v of b) {
    const c = counts.get(v);
    if (!c) return false;
    counts.set(v, c - 1);
  }
  return true;
}

export function matchingPrefixLength(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Linear from 0 at the threshold up to SPEED_TIP_MAX_FRACTION of base at full patience. */
export function speedTip(basePayout: number, patienceFraction: number): number {
  const f = clamp(patienceFraction, 0, 1);
  if (f <= SPEED_TIP_THRESHOLD) return 0;
  const scaled = (f - SPEED_TIP_THRESHOLD) / (1 - SPEED_TIP_THRESHOLD);
  return basePayout * SPEED_TIP_MAX_FRACTION * scaled;
}

/**
 * Score a served plate.
 *
 * `patienceFraction` is how much of the customer's timer is LEFT (1 = just sat down, 0 = out
 * of patience).  Only exact matches earn the speed tip - there is no reward for being quickly
 * wrong.
 */
export function scorePlate(
  stack: string[],
  recipe: string[],
  patienceFraction: number,
): ScoredServe {
  const base = basePayoutFor(recipe.length);

  if (sameSequence(stack, recipe)) {
    return {
      result: "exact",
      payout: Math.round(base + speedTip(base, patienceFraction)),
      strikeDelta: 0,
    };
  }

  if (sameMultiset(stack, recipe)) {
    return {
      result: "wrongOrder",
      payout: Math.round(base * PAYOUT_WRONG_ORDER_FRACTION),
      strikeDelta: STRIKE_FOR_FLAWED,
    };
  }

  const matched = matchingPrefixLength(stack, recipe);
  return {
    result: "incomplete",
    payout: Math.round(base * PAYOUT_PARTIAL_FRACTION * (matched / Math.max(1, recipe.length))),
    strikeDelta: STRIKE_FOR_FLAWED,
  };
}

/**
 * Which layer the recipe wants next given what is already stacked.  Returns undefined once the
 * plate is finished or has already gone off the rails.  Used only by the optional hint.
 */
export function nextRequiredIngredient(stack: string[], recipe: string[]): string | undefined {
  if (matchingPrefixLength(stack, recipe) !== stack.length) return undefined;
  return recipe[stack.length];
}

// ------------------------------------------------------------------------------------------
// Belt geometry
// ------------------------------------------------------------------------------------------

export function wrapBelt(pos: number, stationCount: number): number {
  if (stationCount <= 0) return 0;
  return ((pos % stationCount) + stationCount) % stationCount;
}

/** Advance a plate along the loop, wrapping past the last station back to the first. */
export function advanceBelt(
  pos: number,
  speed: number,
  elapsedMs: number,
  stationCount: number,
): number {
  if (stationCount <= 0) return 0;
  return wrapBelt(pos + (speed * elapsedMs) / 1000, stationCount);
}

/** Which station's zone a plate is currently crossing. */
export function stationAt(pos: number, stationCount: number): number {
  if (stationCount <= 0) return 0;
  return Math.floor(wrapBelt(pos, stationCount));
}

/** How far across that station's zone the plate is: 0 entering, 1 leaving. */
export function progressAcrossStation(pos: number, stationCount: number): number {
  const wrapped = wrapBelt(pos, stationCount);
  return wrapped - Math.floor(wrapped);
}

/** A chef can only pull plates currently crossing their own segment. */
export function isPlateInReach(pos: number, stationIndex: number, stationCount: number): boolean {
  return stationAt(pos, stationCount) === stationIndex;
}

// ------------------------------------------------------------------------------------------
// Seating
// ------------------------------------------------------------------------------------------

export interface SeatNeighbors {
  leftIndex: number;
  rightIndex: number;
}

export function neighborsOf(stationIndex: number, stationCount: number): SeatNeighbors {
  if (stationCount <= 0) return { leftIndex: 0, rightIndex: 0 };
  return {
    leftIndex: (stationIndex - 1 + stationCount) % stationCount,
    rightIndex: (stationIndex + 1) % stationCount,
  };
}

// ------------------------------------------------------------------------------------------
// Results
// ------------------------------------------------------------------------------------------

export interface ChefStats {
  playerId: string;
  layersAdded: number;
  platesServed: number;
  perfectPlates: number;
}

export function chefScore(stats: ChefStats): number {
  return stats.perfectPlates * 3 + stats.platesServed + stats.layersAdded;
}

/** Highest contribution wins; ties return every tied chef so the view can show a shared crown. */
export function findTopChefs<T extends ChefStats>(stats: T[]): T[] {
  if (stats.length === 0) return [];
  const best = Math.max(...stats.map(chefScore));
  if (best <= 0) return [];
  return stats.filter((s) => chefScore(s) === best);
}

/** Par earnings for one completed round - the yardstick the star rating measures against. */
export const PAR_PER_ROUND = 600;

/**
 * A 0-5 star rating for the shift.  Earnings are measured against a par that scales with how
 * much of the shift was actually played, so failing out early cannot look like a good night.
 */
export function starRating(till: number, strikes: number, roundsCompleted: number): number {
  if (roundsCompleted <= 0) return 0;
  const par = roundsCompleted * PAR_PER_ROUND;
  const earned = clamp(till / par, 0, 1);
  const strikePenalty = clamp(strikes / 3, 0, 1);
  return clamp(Math.round(earned * 5 - strikePenalty * 2), 0, 5);
}
