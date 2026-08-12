import MessageEndpoint from "libs/messaging/MessageEndpoint";

// ==========================================================================================
// The complete wire API between a player's phone and the presenter.
//
// Two things about this file are load-bearing for the GAME, not just for the plumbing:
//
//   1. INTEL IS REDACTED ON THE PRESENTER.  An advisor is only ever SENT the hazards they
//      own, and an explorer is never sent a hazard at all.  Filtering on the phone would put
//      the whole minefield one devtools panel away from any curious player, which is the one
//      thing this game cannot survive.
//
//   2. NOTHING HERE NAMES A CELL.  No bearings, no labels, no grid references - cell ids are
//      opaque integers used for addressing and never shown.  Working out how to describe a
//      cell out loud is the game; shipping a vocabulary would be shipping the answer.
//
// Polygons travel as FLAT integer arrays ([x0,y0,x1,y1,...]) rather than {x,y} objects: it
// is half the bytes for the one payload big enough to care, and the view unpacks it once.
// ==========================================================================================

export type MinefieldRole = "explorer" | "advisor" | "waiting";

/** One mosaic cell, ready to draw. */
export interface MinefieldCellShape {
  id: number;
  poly: number[];
  cx: number;
  cy: number;
}

/** A hazard an advisor has been told about. Never includes invisible mines. */
export interface MinefieldHazardView {
  id: number;
  kind: string;
  cellId: number;
  /** Multi-step mines: the TOTAL allowed. Deliberately never counted down for the advisor. */
  steps: number;
}

export interface MinefieldWallView {
  id: number;
  a: number;
  b: number;
  switchCell: number;
}

/** The whole field as one advisor is allowed to see it. Sent once per round. */
export interface MinefieldFieldView {
  size: number;
  cells: MinefieldCellShape[];
  outline: number[][];
  startCell: number;
  goalCell: number;
  hazards: MinefieldHazardView[];
  walls: MinefieldWallView[];
}

/** All the explorer ever gets: where they stand and what they can step to. */
export interface MinefieldLocalView {
  here: MinefieldCellShape;
  options: (MinefieldCellShape & { walled: boolean; visited: boolean })[];
  onStart: boolean;
  onGoal: boolean;
}

/** A team's live run - the part both roles are allowed to know. */
export interface MinefieldTeamStatus {
  teamId: number;
  cell: number;
  path: number[];
  ghosts: number[][];
  deaths: number;
  steps: number;
  reachedGoal: boolean;
  frozenMsLeft: number;
  /** How many fuses are burning. The room feels the tension without being told where. */
  armedCount: number;
  /** Cell ids the explorer may step to right now - advisors highlight exactly these. */
  options: number[];
}

// ------------------------------------------------------------------------------------------
// Onboard - the client's one-stop request for full state. Called on join, after a refresh,
// and whenever the presenter broadcasts InvalidateState. Everything a phone needs to rebuild
// its screen is in the response, because a phone can miss any individual push.
//
// `field` is present for advisors only, and at the end of a round it arrives UNREDACTED, so
// a team finally gets to see what it was they kept walking into.
// ------------------------------------------------------------------------------------------
export interface MinefieldOnboardResponse {
  gameState: string;
  round: number;
  totalRounds: number;
  role: MinefieldRole;
  teamId: number;
  teamName: string;
  teamColor: string;
  explorerName: string;
  advisorCount: number;
  secondsLeft: number;
  /** True once the round is over and the field has been declassified. */
  revealed: boolean;
  field?: MinefieldFieldView;
  local?: MinefieldLocalView;
  status?: MinefieldTeamStatus;
  standings: { teamId: number; teamName: string; teamColor: string; score: number }[];
}

export const MinefieldOnboardEndpoint: MessageEndpoint<unknown, MinefieldOnboardResponse> = {
  route: "/games/minefield/lifecycle/onboard-client",
  suggestedRetryIntervalMs: 10000,
  suggestedTotalLifetimeMs: 60000,
};

// ------------------------------------------------------------------------------------------
// Move - the explorer's only input, and the only message that changes the game.
//
// `stepSerial` is the explorer's count of steps taken. A retry of a move that already landed
// arrives with a stale serial and is answered with current state instead of being walked
// twice - which on this game's rules would be the difference between life and death.
// ------------------------------------------------------------------------------------------
export interface MinefieldMoveRequest {
  toCellId: number;
  stepSerial: number;
}

export interface MinefieldMoveResponse {
  accepted: boolean;
  outcome: "moved" | "goal" | "blocked" | "frozen" | "dead";
  killedBy?: string;
  local?: MinefieldLocalView;
  status?: MinefieldTeamStatus;
}

export const MinefieldMoveEndpoint: MessageEndpoint<MinefieldMoveRequest, MinefieldMoveResponse> = {
  route: "/games/minefield/actions/move",
  suggestedRetryIntervalMs: 1000,
  suggestedTotalLifetimeMs: 10000,
};

// ------------------------------------------------------------------------------------------
// Team update - a small fire-and-forget delta so an advisor's map tracks their explorer
// live, without either side paying for a full re-onboard on every step.
// ------------------------------------------------------------------------------------------
export interface MinefieldTeamUpdateMessage {
  status: MinefieldTeamStatus;
  event: string;
}

export const MinefieldTeamUpdateEndpoint: MessageEndpoint<MinefieldTeamUpdateMessage, void> = {
  route: "/games/minefield/juice/team-update",
};
