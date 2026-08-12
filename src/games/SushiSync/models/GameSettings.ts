// Game-wide tuning constants.  Keep every magic number here so a game designer can
// re-balance Sushi Sync without hunting through logic files.  See DESIGN.md for the
// reasoning behind the difficulty curve.

export const SushiSyncVersion = "0.0.1";

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;

// ------------------------------------------------------------------------------------------
// Difficulty curve.  One entry per round; TOTAL_ROUNDS is derived from the list, so adding
// a fourth shift here is all it takes to lengthen the game.
// ------------------------------------------------------------------------------------------
export interface RoundConfig {
  name: string;
  beltSpeed: number; // stations traversed per second
  spawnIntervalMs: number; // gap between new orders
  patienceMs: number; // how long a customer waits before a strike
  minRecipeLength: number;
  maxRecipeLength: number;
  maxConcurrentOrders: number;
  durationMs: number;
  // Ingredients active this round, before the "at least one per player" floor is applied.
  ingredientTarget: number;
}

export const ROUNDS: RoundConfig[] = [
  {
    name: "Lunch Rush",
    beltSpeed: 0.25,
    spawnIntervalMs: 9000,
    patienceMs: 75000,
    minRecipeLength: 2,
    maxRecipeLength: 3,
    maxConcurrentOrders: 4,
    durationMs: 120000,
    ingredientTarget: 4,
  },
  {
    name: "Dinner Service",
    beltSpeed: 0.4,
    spawnIntervalMs: 6500,
    patienceMs: 55000,
    minRecipeLength: 3,
    maxRecipeLength: 4,
    maxConcurrentOrders: 6,
    durationMs: 135000,
    ingredientTarget: 7,
  },
  {
    name: "Rush Hour",
    beltSpeed: 0.6,
    spawnIntervalMs: 4500,
    patienceMs: 40000,
    minRecipeLength: 4,
    maxRecipeLength: 5,
    maxConcurrentOrders: 8,
    durationMs: 150000,
    ingredientTarget: 10,
  },
];

export const TOTAL_ROUNDS = ROUNDS.length;

// ------------------------------------------------------------------------------------------
// Belt sync.  The presenter owns authoritative plate positions and pushes a snapshot on this
// interval; phones extrapolate between pushes in gameThink().  Small enough to feel live,
// large enough to stay cheap on a weak phone connection.
// ------------------------------------------------------------------------------------------
export const BELT_PUSH_INTERVAL_MS = 400;

// ------------------------------------------------------------------------------------------
// Failure + payout
// ------------------------------------------------------------------------------------------
export const STRIKES_TO_FAIL = 3;
export const STRIKE_FOR_TIMEOUT = 1.0;
export const STRIKE_FOR_FLAWED = 0.34; // three flawed serves ~= one timeout

// A serve with more than this fraction of patience left earns a tip, scaling linearly from
// 0 at the threshold up to SPEED_TIP_MAX_FRACTION at full patience.
export const SPEED_TIP_THRESHOLD = 0.5;
export const SPEED_TIP_MAX_FRACTION = 0.5;

export const PAYOUT_BASE = 50;
export const PAYOUT_PER_LAYER = 25;
export const PAYOUT_WRONG_ORDER_FRACTION = 0.4;
export const PAYOUT_PARTIAL_FRACTION = 0.5;

// ------------------------------------------------------------------------------------------
// Stage lengths for the non-play beats
// ------------------------------------------------------------------------------------------
export const BRIEFING_MS = 9000;
export const END_OF_ROUND_MS = 10000;

// ------------------------------------------------------------------------------------------
// Legibility escape hatches (see DESIGN.md "hard mode").
//
// Shipping default is the hard configuration the designer asked for: a plate shows its layer
// stack but never tells you it is your turn, and recipes live only on the presenter.  That
// stacks three simultaneous mental loads and may prove brutal at Rush Hour belt speed.  Flip
// either of these to true after a playtest to soften the game WITHOUT touching game logic.
// ------------------------------------------------------------------------------------------
export const SHOW_MY_TURN_HIGHLIGHT = false;
export const SHOW_NEXT_LAYER_HINT = false;

// Customer table numbers are drawn from this range so the order board reads like a restaurant.
export const FIRST_TABLE_NUMBER = 1;
export const LAST_TABLE_NUMBER = 24;

// A safety valve: a plate can never hold more layers than the longest possible recipe plus a
// little slack.  Prevents a stuck client spamming a plate into a giant payload.  The plate-art
// layout also sizes its compression budget against this (see plateArt.ts).
export const MAX_STACK_HEIGHT = 8;
