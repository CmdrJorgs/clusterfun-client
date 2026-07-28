# Sushi Sync — Design Spec (v1)

> Designer's source-of-truth spec. Co-operative, real-time, physically co-located.
> Phones lie face-up in a ring around the shared screen and act as segments of one
> continuous conveyor belt.

## Concept

Players are sushi chefs at stations around a conveyor belt. Empty plates tagged with a
**table number** ride the belt past every phone. The central screen is the **order board** —
it alone says what each table ordered. Each chef owns an exclusive handful of ingredients,
so a finished roll physically must be passed from chef to chef along the belt, in the right
layer order, before the customer's patience runs out.

**The tension is informational, not mechanical.** You can see a plate's stack but not its
recipe; you know your own ingredients but not the order they're needed in. The only way to
resolve that is to look up at the board and talk to each other.

- **Players:** 3–8 (`minPlayers = 3`, `maxPlayers = 8`)
- **Genre:** Local co-op / real-time spatial puzzle. Arcade (continuous), not turn-based.
- **Closest relatives:** Overcooked, Keep Talking and Nobody Explodes.

### Departure from ClusterFun norms (deliberate, flagged)

ClusterFun normally tolerates remote players watching the presenter over a video stream.
**Sushi Sync requires physical co-location** — the belt illusion and the shout-across-the-table
loop both depend on it. This is accepted, not overlooked.

## Core loop

```
Plate spawns empty at Station 0  →  rides the belt  →  a chef taps it into their workstation
  →  they add the layers they own  →  return to belt  →  next chef adds theirs
  →  someone taps SERVE  →  scored against that table's order  →  ¥ into the shared till
```

## Spatial model — assigned stations (swipe-sync deferred)

The belt is one logical loop of `N` station segments, one per player. A plate's position is
a float `beltPos ∈ [0, N)`: integer part = station index, fraction = progress across that
station's zone. `beltPos` wraps at `N`, which is the "plates loop forever" rule.

**Topology is assigned, not discovered.** During `Seating`, the presenter picks the loop
order and each phone shows a large `STATION 3 of 5`, its left/right neighbor names, and a
**Swap with ←/→** button. Players physically arrange themselves to match. This is
deterministic, needs no cross-device clock sync, and is fully drivable in the headless
Test Lobby.

> **Why not the swipe-sync protocol from the original brief:** correlating `SwipeEnd`/
> `SwipeStart` needs tens-of-ms precision, but phone clocks are unsynchronized and the relay
> adds variable latency. It also cannot be verified in the Test Lobby, which the build
> workflow treats as a hard gate. Also note the original brief put this logic on the server —
> the ClusterFun server is a dumb relay with zero game knowledge, so any future version of
> this lives on the **presenter**. Deferred, not discarded.

**Stations are fixed for the whole game.** Nobody wants to physically move mid-shift.
Only ingredient assignments reshuffle between rounds.

## Belt rendering — ordered, per-phone animation

The presenter owns every plate's authoritative `beltPos` and advances it in `handleTick()`.
It broadcasts a small belt snapshot every `BELT_PUSH_INTERVAL_MS` (400ms); each client
extrapolates locally in `gameThink(elapsed_ms)` (`beltPos += speed * elapsed/1000`) and
reconciles on each snapshot. A client renders only plates whose `beltPos` falls inside its
own station segment.

Snapshot cost: ≤12 plates × ~40 bytes ≈ 500 B per push. Well within phone budget.

> **Cut:** the seamless cross-device hand-off (a plate leaving Alice's right edge at the
> exact instant it enters Bob's left edge) needs a per-phone clock-offset handshake. v1
> accepts a small seam at device boundaries. The handshake is a refinement layered on top
> of this model, not a rewrite of it.

## Ingredients — exclusive ownership

Four layer categories, applied in strict order:

```
Base  →  Binder  →  Filling  →  Topping
```

| Category | Ingredients                           |
| -------- | ------------------------------------- |
| Base     | Nori, Soy Paper                       |
| Binder   | White Rice, Brown Rice                |
| Filling  | Salmon, Tuna, Eel, Cucumber, Avocado  |
| Topping  | Tobiko, Spicy Mayo, Eel Sauce, Sesame |

**Every active ingredient has exactly one owner.** That interdependence is the game.

Assignment rules (pure, in `sushiSyncLogic.ts`):

1. `activeCount = clamp(max(playerCount, roundBaseCount), playerCount, 13)`,
   with `roundBaseCount = [4, 7, 10]` for rounds 1–3.
2. The active set always contains **2 Bases and 2 Binders**. Two reasons: a single Rice owner
   would be a hard bottleneck that every plate queues behind while everyone else idles, _and_
   with only one of each every short recipe is identical. (Playtest, round 1 at 3 players:
   the board filled with three identical "Soy Paper → Brown Rice" tickets and reading the
   shared screen stopped mattering — the exact mechanic this game is built on.)
3. Assign **category-by-category, round-robin over a shuffled player order**, so one player
   rarely holds both Bases or both Binders.
4. Every player ends with ≥1 active ingredient (guaranteed by rule 1).
5. Recipes are generated only from the active set, so every order is always completable by
   the current roster.

**Dropped player mid-round:** their ingredients are immediately reassigned to the adjacent
player holding the fewest, and their station becomes a **pass-through** (plates traverse at
normal speed; nobody can pull there). Without this, an exclusive ingredient disappearing
would make live orders unwinnable.

## Difficulty — 3 fixed rounds

| Parameter              | R1 "Lunch Rush" | R2 "Dinner Service" | R3 "Rush Hour" |
| ---------------------- | --------------- | ------------------- | -------------- |
| Belt speed (station/s) | 0.25            | 0.40                | 0.60           |
| Spawn interval         | 9.0 s           | 6.5 s               | 4.5 s          |
| Customer patience      | 75 s            | 55 s                | 40 s           |
| Recipe length          | 2–3             | 3–4                 | 4–5            |
| Max concurrent orders  | 4               | 6                   | 8              |
| Round length           | 120 s           | 135 s               | 150 s          |

Ingredient assignments **reshuffle between rounds** (the `RoundBriefing` beat), and the
active pool grows as the menu expands.

## Scoring

Shared till (`¥`) and shared strikes. All resolution logic is pure in `sushiSyncLogic.ts`.

`basePayout = 50 + 25 × recipeLength`

| Outcome                    | Condition                             | Payout                             | Strike |
| -------------------------- | ------------------------------------- | ---------------------------------- | ------ |
| **Exact**                  | stack deep-equals the recipe sequence | 100% + speed tip                   | —      |
| **Right set, wrong order** | same multiset, wrong sequence         | 40%                                | +0.34  |
| **Incomplete / wrong**     | otherwise                             | `50% × (matchedPrefix / required)` | +0.34  |
| **Trashed**                | dumped in the bin                     | 0 — order respawns a fresh plate   | —      |
| **Timeout**                | patience hits 0                       | 0                                  | +1.0   |

**Speed tip:** served with >50% patience remaining earns up to +50%, scaled linearly by the
remaining fraction.

**Trashing carries no strike** — it is a legitimate recovery move, and the lost time against
a running order timer is punishment enough.

**Shift ends** when `strikes ≥ 3` (early failure) or all 3 rounds complete. Strikes are a
float rendered as 3 pips.

### End screen — team result + Top Chef

The shift is scored as a team: total ¥ and a 0–5 star rating. Because the ClusterFun end
screen expects a winner, we also crown a **Top Chef** from per-player contribution stats:

```
score = perfectPlates × 3  +  platesServed  +  layersAdded
```

Per-player stats tracked: `layersAdded`, `platesServed`, `perfectPlates`, `platesTimedOut`.

## Legibility — hard mode (with a tuning escape hatch)

Chosen configuration: **plates show their current layer stack, with no "it's your turn"
highlight**, and **the recipe lives only on the presenter**.

This deliberately stacks three simultaneous loads: read the board for table N's recipe,
track the plate's stack, remember your own ingredients. It is the most demanding and most
communicative configuration.

> **Risk, recorded:** this may prove brutal once belt speed hits R3. `GameSettings` therefore
> exposes `SHOW_MY_TURN_HIGHLIGHT` (default `false`) and `SHOW_NEXT_LAYER_HINT` (default
> `false`) so a playtest can soften it without touching game logic.

## State machines

**Presenter**

| State           | Screen                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `Gathering`     | Join code, player list with avatars                                                                   |
| `Seating`       | Ring diagram of assigned stations; host "Start Shift" button                                          |
| `RoundBriefing` | Round name, the who-owns-what ingredient table, countdown (also between rounds)                       |
| `Playing`       | Order board (table / dish / layer sequence / patience bar), belt ring, till, strike pips, round timer |
| `EndOfRound`    | Round report: ¥ earned, served, perfect / flawed / timed out                                          |
| `GameOver`      | Star rating, total ¥, Top Chef with avatar, per-player stat table                                     |

**Client**

| State            | Screen                                                   |
| ---------------- | -------------------------------------------------------- |
| `WaitingToStart` | Framework join/wait                                      |
| `Seating`        | Big `STATION 3 of 5`, neighbor names, Swap ← / → buttons |
| `Briefing`       | "Your ingredients this round: Nori, Tobiko"              |
| `Playing`        | Belt zone (top 25%) + workstation (bottom 75%)           |
| `EndOfRound`     | Hold screen between rounds                               |
| `GameOver`       | Your personal stats                                      |

### Phone layout during `Playing`

```
+---------------------------------------------------+
|  BELT ZONE (25%)  plates crossing MY segment      |
|   ( T3 ▪▪ )  →  ( T1 ▪ )  →  ( T5 )               |
+---------------------------------------------------+
|  WORKSTATION (75%)                                |
|   Active plate: TABLE 3                           |
|   stack: Nori › Rice                              |
|                                                   |
|   MY INGREDIENTS:  [ Eel ]  [ Tobiko ]            |
|                                                   |
|   [ Trash ]   [ Return to Belt ]   [ SERVE ]      |
+---------------------------------------------------+
```

A workstation holds **exactly one** active plate. Tapping ingredients **out of order is
allowed** — it produces the Flawed Serve outcome above rather than being blocked — and the
visible stack is what lets an attentive chef notice the mistake.

## Message table

Route prefix `/games/sushisync/…`. All state is authoritative on the presenter; clients only
propose.

| Endpoint                         | Dir | Kind | Request → Response                                                    |
| -------------------------------- | --- | ---- | --------------------------------------------------------------------- |
| `SushiSyncOnboardClientEndpoint` | C→P | req  | `{}` → full phone state (below)                                       |
| `SushiSyncBeltPushEndpoint`      | P→C | f&f  | `{ plates: [{id, pos, table, stack[]}], speed }`                      |
| `SushiSyncSwapStationEndpoint`   | C→P | req  | `{ direction: "left"\|"right" }` → `{ station, leftName, rightName }` |
| `SushiSyncPullPlateEndpoint`     | C→P | req  | `{ plateId }` → `{ accepted, reason?, plate? }`                       |
| `SushiSyncAddIngredientEndpoint` | C→P | req  | `{ ingredientId }` → `{ accepted, stack[] }`                          |
| `SushiSyncReturnPlateEndpoint`   | C→P | req  | `{}` → `{ accepted }`                                                 |
| `SushiSyncTrashPlateEndpoint`    | C→P | req  | `{}` → `{ accepted }`                                                 |
| `SushiSyncServePlateEndpoint`    | C→P | req  | `{}` → `{ result, payout, strikeDelta }`                              |
| `InvalidateStateEndpoint`        | P→C | f&f  | framework — triggers client re-onboard                                |
| `GameOverEndpoint`               | P→C | req  | framework                                                             |

**Why `PullPlate` is request/response:** two chefs can tap the same plate in the same frame.
The presenter arbitrates and the loser must be told, or their phone shows a plate they don't
have.

**Onboard response** (must fully rebuild the phone — clients miss individual pushes):

```ts
{
  gameState, roundNumber, roundName,
  stationIndex, stationCount, leftNeighborName, rightNeighborName,
  myIngredients: [{ id, name, category }],
  heldPlate: { id, table, stack[] } | null,
  beltSpeed, strikes, till,
  showMyTurnHighlight, showNextLayerHint
}
```

## Implementation notes (traps this design must respect)

- **`SushiSyncPlayer` must call `makeObservable(this)` in its constructor.** The presenter UI
  reads per-player fields (station, ingredients, held plate, live stats); `ClusterFunPlayer`
  does not call it, so `@observable` fields would otherwise be inert in MobX 6 and the board
  would render stale.
- **Serializable classes:** `SushiSyncPresenterModel`, `SushiSyncPlayer`, `SushiSyncPlate`,
  `SushiSyncOrder` — all four registered in the presenter type helper, with `plates`/`orders`
  re-wrapped as MobX observables in `reconstitute`. A serializer round-trip spec is required.
- Payloads are all small scalars/short arrays — no base64, so nothing needs a
  `shouldStringify` skip-list. (The skip-list trap applies to image games, not this one.)
- `saveCheckpoint()` after: serve, trash, strike, round transition, station swap.
- All rules — assignment, recipe generation, plate scoring, top chef, belt advance/wrap — are
  **pure functions in `sushiSyncLogic.ts` with specs written alongside**. Models only
  orchestrate.

## v1 cut-lines

**In:** assigned-station seating with swap; looping belt with per-phone animation; exclusive
ingredient ownership with per-round reshuffle; 3 rounds on the difficulty table; order board
with patience bars; pull / add / return / trash / serve; the full scoring table; strikes;
team result + Top Chef; dropped-player ingredient reassignment; refresh-resume.

**Deferred:** swipe-sync topology discovery; seamless cross-device hand-off (clock-offset
handshake); named dish book beyond generated recipes (Dragon Roll et al. as flavor text);
mid-round joining; custom dish/ingredient art and bespoke sounds (template audio for now);
satisfaction decay as a second meter separate from strikes; spectator mode; endless mode.
