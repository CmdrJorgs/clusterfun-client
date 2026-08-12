# Minefield — Design Spec (MVP)

> Designer's source-of-truth spec the implementation follows. Closest shipped cousins:
> **Lexible** (irregular board geometry + two-team state, presenter-owned grid) and
> **OneOhOne** (small round-based loop, pure-logic-first). This game has **no camera and no
> images** — its hard part is generation and asymmetric information, not transport.

A co-operative bomb-disposal game of asymmetric information. One player per team is the
**Explorer**: they walk a mosaic minefield they cannot see, one cell at a time, from a start
cell to a goal. Everyone else on the team is an **Advisor**: each holds a *fragment* of the
map intel and can see the whole field on their phone — but nobody holds all of it. The team
has to **talk out loud**, stitch their partial maps together, and steer a blind explorer
through live ordnance before the clock runs out.

## Core loop

`Host picks difficulty + teams → an explorer is chosen per team → map is generated and intel
is split among the advisors → explorer taps one of the neighbouring cells they can see →
presenter resolves the step (safe / freeze / boom) → trail extends on the big screen →
repeat until GOAL or the round timer expires → score → next round, new map, new explorer.`

Turn-based *per team*, but all teams move **simultaneously and independently** — nobody
waits for anybody.

---

## Open questions I answered myself (overrule any of these)

You didn't pin these down, so the spec below commits to a choice and says why. These are the
four decisions most expensive to change later.

| # | Question | **Decision** | Why |
|---|----------|--------------|-----|
| 1 | What happens on death? | **Respawn at the start cell, same map, keep playing.** Deaths are the score, nobody is eliminated. The dead run stays on the big screen as a faded "ghost trail" with a 💀 at the blast. | Elimination ends a single-team game 20 seconds in, and leaves the whole room watching. Respawn keeps everyone playing and turns each death into *information* — which is the actual fun. It also makes your "number of viable paths" knob meaningful: you're expected to survive mistakes and re-route. |
| 2 | Multi-team map | **All teams share ONE map (same geometry, same hazard placement), but hazard *state* is per-team.** Arming, fuses, and multi-step counts are tracked independently per team, and a detonation only kills the team that caused it. | Teams move asynchronously, so a shared "after two movements" fuse has no defined clock, and cross-team detonations would mean one team can grief another on their first game. Shared geometry keeps the race fair and keeps the presenter overlay (all trails on one shape) working. **Rival trails are visible on the big screen — watching another team die tells you where a mine is. That is intentional.** Cross-team detonation is a deferred variant. |
| 3 | Difficulty UI | **Four presets (Recruit / Sapper / Veteran / Nightmare) plus a collapsed "Advanced" panel** exposing every knob from the pitch. | Presets get a party started in one tap; the knobs are explicitly in your pitch so they stay reachable. Presets are literally named knob-sets in `GameSettings.ts`. |
| 4 | v1 hazard set | **All five mine types, missing cells, and walls+switches are IN**, with switches capped at 3 per map. | Each one is load-bearing for a different reason (below), and the generator's verifier has to exist anyway. The cap is what keeps the solver cheap. |

---

## The shared vocabulary problem (the single most important mechanic)

An explorer who says "there's one up and to the left" and an advisor looking at a map in a
different orientation is a game that does not work. So **both screens name the same cells the
same way**, and that naming is the whole interface:

- The explorer's phone shows their current cell centred, with each **adjacent** cell drawn in
  its **true relative geometry** and labelled with a **compass bearing** (`N`, `NNE`, `NE`, …
  from a 16-point compass, assigned from centroid angles and **guaranteed unique** among the
  neighbours of that cell).
- Every advisor's map highlights the explorer's current cell and labels its neighbours with
  the **identical bearings**.

So "take NE" is unambiguous for everyone, without ever showing the explorer the map.
Cell ID numbers are deliberately **not** shown — reading a list of numbers off a map is not a
conversation, and the bearing keeps the talk spatial.

`assignBearings(center, neighbours) → label[]` is a pure function with a spec asserting
uniqueness and correct quadrants.

---

## Map generation (`minefieldMap.ts`, pure + specced)

No computational-geometry dependency and no Voronoi library. Deterministic from a seed:

1. **Jittered lattice** — a `W×H` grid of vertices, each interior vertex displaced by up to
   ±35% of a cell. Every grid square is now an irregular quad.
2. **Merge** — union-find merges ~35% of quads into a neighbour, producing 6- and 8-sided
   cells. Adjacency is inherited from the lattice, so it is exact and free.
3. **Carve** — delete a few cells outright → **missing cells** (holes), and erode the border
   irregularly so the field is not a rectangle.
4. **Outline** — `boundaryOutline(cells)`: collect every polygon edge, drop the ones appearing
   twice (internal), chain the rest into rings. One function serves both the merged-cell
   outlines and **the map silhouette the presenter draws**.
5. **Place** — start and goal are two random cells at least `MIN_START_GOAL_SPAN` apart, then
   hazards, walls and switches per the difficulty knobs.
6. **Verify, or reject and re-roll** (up to `MAX_GEN_ATTEMPTS`, then relax):
   - **Route count** — `countDisjointRoutes()`: vertex-disjoint start→goal routes on the
     statically-safe subgraph, computed by max-flow on the node-split graph (Menger). This is
     the exact, testable definition of your "number of viable paths" knob: `1` is a tightrope,
     `3` is forgiving.
   - **Dynamic solvability** — a simulator BFS over `(cell, switchMask, armedFuses)` proving a
     living route exists *including* motion/invisible-mine fuses and wall/switch ordering.
     Switch capped at 3 → mask space ≤ 8, so this stays cheap.

## Hazards (all v1)

| Hazard | Rule | Why it's in v1 |
|---|---|---|
| **Standard mine** | Instant kill on step. | The baseline; no game without it. |
| **Multi-step mine** | Survives 2–5 steps; the **total** is shown to advisors and **never counted down**. The Nth step kills. | The most distinctive thing in the pitch. It moves the load from *reading a map* to *remembering* — which is what makes advisors talk to each other. |
| **Freeze mine** | Explorer cannot move for 10s. | Cheap, pure tension, and it can never make a map unwinnable. |
| **Motion mine** | Arms when the explorer enters any cell **adjacent** to it. Detonates after **that explorer's next 2 movements**, killing them if they are then within 1 cell of it. | The reason "viable paths" matters — an armed mine turns a map into a two-move escape problem. |
| **Invisible mine** | **Never** shown to any advisor. Arms when stepped on; same 2-move fuse and blast as a motion mine. | Reuses the motion-mine fuse machinery almost for free, and it's the one hazard advisors cannot solve — only survive. |

**Obstacles:** **walls** block a specific shared *edge* between two cells (drawn as a thick
line) and are removed by stepping on their paired **switch** cell elsewhere on the map;
**missing cells** fall out of step 3 above. Walls are the strongest collaboration mechanic —
they force an advisor to route the explorer *away* from the goal first.

## Intel distribution (`distributeIntel`, pure + specced)

Given a team's advisors and the map's **visible** hazards/obstacles (invisible mines excluded
by definition):

1. Shuffle hazards and deal them round-robin so **every hazard has at least one advisor** —
   full coverage is guaranteed by construction, never by luck.
2. Then reveal each hazard to `overlap × (advisors − 1)` *additional* advisors.

So the knob is genuinely "how much do your intel sets overlap", exactly as pitched. One
advisor ⇒ they see everything, automatically. Spec asserts total coverage at every overlap
value and the expected per-advisor share.

> **Intel is filtered on the presenter, never on the phone.** An advisor's device is only ever
> *sent* the hazards they own, and the explorer's device is never sent any hazard at all — so
> opening devtools reveals nothing. Same principle as FaceOff's opaque `entryId`s.

---

## Players & teams

- **2–16 players.** A team needs 1 explorer + ≥1 advisor, so `minPlayers = 2`.
- **1–4 teams**, host-selected on the setup screen; auto-balanced, capped by player count.
- **Explorer selection is on the presenter**: tap a player on a team, or **Random** (per team
  or all at once). Random prefers someone who has not been explorer yet this game.
- **Join mid-game** → seated as an **advisor** on the smallest team, and gets an intel share
  dealt from the existing pool at the start of the **next** round (mid-round they see only
  what is already public: the trail).
- **Drop** → they keep their seat and their intel (per the platform contract). If the
  *explorer* drops, the team is frozen with an "explorer disconnected" banner and the host
  gets a **Reassign explorer** button; a rejoin-by-name puts them straight back in the boots.

## Round shape / phases

1. **Gathering** — join screen, room code, roster with avatars, difficulty presets +
   Advanced, team count, host **Start**.
2. **Briefing** — map generated, explorers chosen, intel dealt. Big screen shows the
   silhouette, start ★ and goal ⚑, and each team's explorer name. ~8s.
3. **Running** — the game. Explorers step, advisors shout, presenter draws trails. Ends when
   every team has reached the goal, or `ROUND_MS` expires.
4. **RoundScore** — per-team deaths / steps / time, cumulative standings.
5. → next round (new map, new explorer) until `ROUNDS`, then **GameOver** + fanfare.

## State machines

- **Presenter:** `Gathering` → `Briefing` → `Running` → `RoundScore` → (`Briefing` … ) →
  `GameOver`.
- **Client:** `WaitingToStart` → `Briefing` (role reveal: "YOU ARE THE EXPLORER" / "you have
  N pieces of intel") → `Exploring` **or** `Advising` (the two live screens) → `Frozen` (an
  explorer sub-state with a 10s counter) → `RoundScore` → loop → `GameOver`.

## Message table

| Endpoint | Dir | Request → Response |
|---|---|---|
| `MinefieldOnboardEndpoint` | C→P req | `{}` → `{state, round, totalRounds, role, teamId, teamColor, …}` **plus a role-shaped payload**: advisor gets `{cells[], outline, myIntel[], explorer{cell,bearings[]}, trail[]}`; explorer gets `{here, neighbours[{cellId,bearing,poly,visited,walled}], frozenMsLeft, deaths}`. Full phone rebuild. |
| `MinefieldMoveEndpoint` | C→P req | `{toCellId, stepSerial}` → `{accepted, outcome: "moved"\|"frozen"\|"blocked"\|"dead", frozenMsLeft?, neighbours[], deaths}` — the explorer's only input. `stepSerial` makes a retried move idempotent. |
| `MinefieldTeamUpdateEndpoint` | P→C f&f | `{teamId, explorerCell, bearings[], trailTail, event?: "step"\|"death"\|"freeze"\|"goal"\|"armed"}` — small delta so advisor maps track the explorer live without a full re-onboard. |
| `MinefieldRevealEndpoint` | P→C f&f | `{teamId, hazards[]}` — post-mortem reveal after a death/round end, so a team learns what killed them. |
| `InvalidateStateEndpoint` | P→C f&f | (shared) phase change → every client re-onboards. |
| Join/Quit/Ping/GameOver/Pause/Resume/Terminate | shared | base framework endpoints. |

**Sizing:** the mosaic geometry (~80 cells, quantised to integers in a 0…1000 space) is sent
**once per round** in an advisor's onboard, ≈5 KB. Everything after that is a delta of a few
bytes. The explorer's onboard is only their local neighbourhood — tiny.

## The big screen

Deliberately **information-free about the field**: a large map **silhouette only** — no cells,
no hazards — with start ★, goal ⚑, and per team a coloured marker, a live coloured trail, and
faded ghost trails of previous runs with 💀 at each blast. Plus the round clock, per-team
death counts, and a "⚠ MINE ARMED — 2" pip when a team has a live fuse (tension for the room
without telling anybody where it is). Host controls: Pause, Reassign explorer, Skip round.

## Rules & scoring (v1)

- Reaching the goal: `GOAL_POINTS` (1000) + `TIME_BONUS_PER_SEC` (5) × seconds left.
- Each death: −`DEATH_PENALTY` (150), team score floored at 0.
- Round rank breaks ties by fewest deaths, then fewest steps.
- Every rule (step resolution, fuse ticking, multi-step counting, wall/switch state, scoring)
  lives in pure `minefieldLogic.ts` + `minefieldMap.ts` with Jest specs. Models only
  orchestrate.

## Persistence & MobX

- Map geometry, hazards, per-team state and scores **all serialize** — a presenter refresh
  mid-round resumes the same field. There are no images here, so the localStorage-quota trap
  that bites the photo games does not apply; the checkpoint stays small because geometry is
  quantised integers. Covered by a serializer round-trip spec.
- `MinefieldPlayer` calls `makeObservable(this)` in its constructor (the presenter renders
  per-player `role` / `teamId` / `isConnected`, and the base `ClusterFunPlayer` never calls
  it — so without this those fields are inert in MobX 6). Pattern copied from `FaceOffPlayer`.

## Visual (Sapper's Desk)

Charcoal `#0b0d0a` field, phosphor-green vector linework (a night-scope / ordnance-map look),
amber for armed warnings, red for detonation. Team colours saturated and clearly distinct at
across-the-room distance. Stencil display face for headings, mono for counts and the clock.
Avatars beside every player name — roster, explorer callout, scoreboards, winner, phone
header. Reduced-motion respected.

## MVP cut-lines

**In:** join + roster + avatars + host start gate; difficulty presets + Advanced knobs; 1–4
teams on a shared map; irregular mosaic generation with missing cells, verified for route
count and dynamic solvability; all five mine types; walls + switches (≤3); guaranteed-coverage
intel split with an overlap knob; presenter-side intel filtering; explorer local-neighbourhood
view with unique compass bearings; advisor full-map view with live explorer tracking;
respawn-on-death with ghost trails; 3 rounds with rotating explorers; scoring + scoreboard +
fanfare; full checkpoint/resume; Sapper's Desk styling.

**Deferred (later):** cross-team detonations (one team's blunder killing another's explorer);
per-team mirrored hazard layouts; >4 teams; advisor annotation/ping tools (drawing on the map
for other advisors); a text-chat fallback for remote play; hazard variety beyond the five
types (chain mines, decoys, timed gates); escalating per-round difficulty within a game;
sound design beyond the template's score/fanfare set; pinch-zoom on the advisor map (v1 fits
the field to the 1080×1920 canvas with tap-to-inspect instead); QR join code.
