import MessageEndpoint from "libs/messaging/MessageEndpoint";

// ==========================================================================================
// The complete wire API between a chef's phone (client) and the shared order board
// (presenter).  See DESIGN.md "Message table".
//
// Route format: /games/sushisync/<category>/<action>
//   lifecycle - join / onboard / round transitions
//   actions   - player inputs that change game state
//   push      - presenter -> client broadcasts
//
// The presenter is authoritative for EVERYTHING.  Clients only ever propose.  Keep payloads
// small: eight phones on hotel wifi is the design target.
// ==========================================================================================

// ------------------------------------------------------------------------------------------
// Shared shapes
// ------------------------------------------------------------------------------------------

/** One plate as a phone needs to see it.  Deliberately terse - this ships every 400ms. */
export interface SushiSyncBeltPlate {
  /** Plate id. */
  id: string;
  /** Belt position: integer part is the station index, fraction is progress across it. */
  pos: number;
  /** Customer table number.  The RECIPE is not sent - that lives only on the presenter. */
  table: number;
  /** Ingredient ids applied so far, in the order they were applied. */
  stack: string[];
  /**
   * True when the next layer this plate needs is one the RECIPIENT owns.
   *
   * Only populated when GameSettings.SHOW_MY_TURN_HIGHLIGHT is on - the shipping default is
   * hard mode, where plates never tell you it is your turn.  It has to be computed per
   * recipient on the presenter because the phone deliberately never learns the recipe.
   */
  needsYou?: boolean;
}

export interface SushiSyncIngredientInfo {
  id: string;
  name: string;
  category: string;
}

export interface SushiSyncHeldPlate {
  id: string;
  table: number;
  stack: string[];
}

// ------------------------------------------------------------------------------------------
// Onboard - the client's one-stop request for full state.  Sent on join, on rejoin after a
// refresh, and whenever the presenter broadcasts InvalidateStateEndpoint.  A client can miss
// individual pushes, so this response must be enough to rebuild the whole phone screen.
// ------------------------------------------------------------------------------------------
export interface SushiSyncOnboardClientMessage {
  gameState: string;
  roundNumber: number;
  roundName: string;

  // Where this player sits on the belt loop.
  stationIndex: number;
  stationCount: number;
  leftNeighborName: string;
  rightNeighborName: string;

  // This player's exclusive ingredients for the current round.
  myIngredients: SushiSyncIngredientInfo[];

  // The plate currently in this player's workstation, if any.
  heldPlate: SushiSyncHeldPlate | null;

  beltSpeed: number;
  strikes: number;
  till: number;

  // Legibility switches, resolved by the presenter so both roles always agree.
  showMyTurnHighlight: boolean;
  showNextLayerHint: boolean;
}

export const SushiSyncOnboardClientEndpoint: MessageEndpoint<
  unknown,
  SushiSyncOnboardClientMessage
> = {
  route: "/games/sushisync/lifecycle/onboard-client",
  suggestedRetryIntervalMs: 10000,
  suggestedTotalLifetimeMs: 60000,
};

// ------------------------------------------------------------------------------------------
// Belt push - presenter -> every client, fire and forget.  Safe to drop: the next push (or an
// onboard) re-syncs.  Carries every plate on the belt; phones render only the ones crossing
// their own station segment.
// ------------------------------------------------------------------------------------------
export interface SushiSyncBeltPushMessage {
  plates: SushiSyncBeltPlate[];
  speed: number;
}

export const SushiSyncBeltPushEndpoint: MessageEndpoint<SushiSyncBeltPushMessage, void> = {
  route: "/games/sushisync/push/belt",
};

// ------------------------------------------------------------------------------------------
// Swap station - trade seats with a neighbor during Seating.
// ------------------------------------------------------------------------------------------
export interface SushiSyncSwapStationRequest {
  direction: "left" | "right";
}

export interface SushiSyncSwapStationResponse {
  accepted: boolean;
  stationIndex: number;
  leftNeighborName: string;
  rightNeighborName: string;
}

export const SushiSyncSwapStationEndpoint: MessageEndpoint<
  SushiSyncSwapStationRequest,
  SushiSyncSwapStationResponse
> = {
  route: "/games/sushisync/actions/swap-station",
  suggestedRetryIntervalMs: 2000,
  suggestedTotalLifetimeMs: 10000,
};

// ------------------------------------------------------------------------------------------
// Pull plate - take a plate off the belt into this player's workstation.
//
// Request/response rather than fire-and-forget on purpose: two chefs can tap the same plate in
// the same frame.  The presenter arbitrates and the loser MUST be told, or their phone will
// show a plate they do not actually hold.
// ------------------------------------------------------------------------------------------
export interface SushiSyncPullPlateRequest {
  plateId: string;
}

export interface SushiSyncPullPlateResponse {
  accepted: boolean;
  /** Why it failed, for a brief phone toast: "taken" | "busy" | "outofreach" | "notplaying" */
  reason?: string;
  plate?: SushiSyncHeldPlate;
}

export const SushiSyncPullPlateEndpoint: MessageEndpoint<
  SushiSyncPullPlateRequest,
  SushiSyncPullPlateResponse
> = {
  route: "/games/sushisync/actions/pull-plate",
  suggestedRetryIntervalMs: 1500,
  suggestedTotalLifetimeMs: 6000,
};

// ------------------------------------------------------------------------------------------
// Add ingredient - apply one of this player's exclusive ingredients to the held plate.
// Out-of-order application is ALLOWED (it becomes a flawed serve); the presenter only
// rejects ingredients this player does not own.
// ------------------------------------------------------------------------------------------
export interface SushiSyncAddIngredientRequest {
  ingredientId: string;
}

export interface SushiSyncAddIngredientResponse {
  accepted: boolean;
  reason?: string;
  /** Authoritative stack after the change, so the phone can never drift. */
  stack: string[];
}

export const SushiSyncAddIngredientEndpoint: MessageEndpoint<
  SushiSyncAddIngredientRequest,
  SushiSyncAddIngredientResponse
> = {
  route: "/games/sushisync/actions/add-ingredient",
  suggestedRetryIntervalMs: 1500,
  suggestedTotalLifetimeMs: 6000,
};

// ------------------------------------------------------------------------------------------
// Return to belt - put the held plate back so the next chef can add their layers.
// ------------------------------------------------------------------------------------------
export interface SushiSyncReturnPlateResponse {
  accepted: boolean;
  reason?: string;
}

export const SushiSyncReturnPlateEndpoint: MessageEndpoint<unknown, SushiSyncReturnPlateResponse> =
  {
    route: "/games/sushisync/actions/return-plate",
    suggestedRetryIntervalMs: 1500,
    suggestedTotalLifetimeMs: 6000,
  };

// ------------------------------------------------------------------------------------------
// Trash - bin an unsalvageable plate.  Costs no strike; the order respawns a fresh plate and
// the lost time against a running order timer is punishment enough.
// ------------------------------------------------------------------------------------------
export interface SushiSyncTrashPlateResponse {
  accepted: boolean;
  reason?: string;
}

export const SushiSyncTrashPlateEndpoint: MessageEndpoint<unknown, SushiSyncTrashPlateResponse> = {
  route: "/games/sushisync/actions/trash-plate",
  suggestedRetryIntervalMs: 1500,
  suggestedTotalLifetimeMs: 6000,
};

// ------------------------------------------------------------------------------------------
// Serve - send the held plate to its customer and score it.
// ------------------------------------------------------------------------------------------
export interface SushiSyncServePlateResponse {
  accepted: boolean;
  reason?: string;
  /** "exact" | "wrongOrder" | "incomplete" */
  result?: string;
  payout?: number;
  /** The dish the customer actually wanted - revealed only now, as feedback. */
  dishName?: string;
}

export const SushiSyncServePlateEndpoint: MessageEndpoint<unknown, SushiSyncServePlateResponse> = {
  route: "/games/sushisync/actions/serve-plate",
  suggestedRetryIntervalMs: 1500,
  suggestedTotalLifetimeMs: 6000,
};
