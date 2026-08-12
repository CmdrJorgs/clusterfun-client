---
name: clusterfun-new-game
description: "End-to-end workflow for building a NEW ClusterFun party game in this repo (src/games). Use whenever the user wants to create, scaffold, design, or implement a new game from the TemplateGame, or says /clusterfun-new-game. Covers design interview, scaffolding, thin-slice implementation, the non-obvious repo traps, and live Test-Lobby verification."
---

# Building a new ClusterFun game

This is the repeatable workflow for adding a game under `src/games/`. It wraps the template's
own interview guide with the hard-won repo traps and a real verification loop. Follow the
phases in order; keep the game playable in the Test Lobby after every slice.

**Read these first (don't duplicate them — they are the source of truth):**

- `CLAUDE.md` (repo root) — the presenter/client architecture, framework, Test Lobby.
- `src/games/TemplateGame/CLAUDE.md` — the design-interview script and scaffold steps.
  Phase 1 below _is_ that interview.
- `src/games/TemplateGame/README.md` — manual porting steps.
- A shipped game as the pattern reference. **PartyPix** (`src/games/PartyPix/`) is the best
  match for anything involving **photos, the camera, base64 images over the relay, or a
  continuous/no-rounds loop**; it has a `CLAUDE.md`, a `DESIGN.md`, pure logic + specs, and a
  `PresenterModel.spec.ts`. **Eittris** (`src/games/Eittris/`) is the reference for **arcade,
  per-frame, input-heavy** games and has the repo's most complete spec suite — but read its
  `CLAUDE.md` first, because it deliberately inverts the usual authority rule.
  **OneOhOne** is the smallest complete round-based game. **FaceOff** and **CollageBoard** are
  the newest round-based/photo references and are the closest to current house style.
  Lexible/RetroSpectro are older round-based references with thinner tests.

## Phase 0 — Make the repo buildable (do this once per clone/worktree)

One trap bites before any docs mention it:

```bash
# The build needs a git-ignored secrets file (tests do NOT; the production build does):
cp -n src/secrets.ts.template src/secrets.ts

npm install
```

## Phase 1 — Design (interactive; do not skip)

Run the interview in `src/games/TemplateGame/CLAUDE.md` §"Phase 1". Ask a few questions at a
time about concept, players, flow, the big screen, the phone, rules/scoring, assets, and the
v1 cut-lines. Then write `src/games/<NewGame>/DESIGN.md` in the style of PartyPix's
DESIGN.md: concept, player counts, presenter + client state machines, a
**message table** (endpoint, direction, request→response sketch), rules, and explicit v1
cut-lines. **Show the summary and get an explicit "yes" before writing any code.**

Once the design is approved, the mechanical build (Phases 2–3) can be handed to the
**clusterfun-game-builder** subagent, or done inline. Verification (Phase 4) is the
**clusterfun-testlobby-verify** skill / **clusterfun-verifier** subagent.

## Phase 2 — Scaffold from TemplateGame

1. Pick a PascalCase folder name (e.g. `Quizzo`).
2. `cp -r src/games/TemplateGame src/games/<NewGame>`; **delete the copied `CLAUDE.md`** and
   rewrite `README.md` as a short description + how-to-play.
3. Rename consistently: `Template`→`<NewGame>` in identifiers, `template`→`<newgame>` in
   endpoint **route strings** and file names, **and every serializer type-name string** in
   both type helpers (`getTypeName`/`constructType`/`shouldStringify` switch cases). Missing
   a type-name string silently breaks save/restore.
4. Register the game in **two** places:
   - `src/games/lists/gamesListDebug.ts` — add a `GameDescriptor` (debug list only for now).
   - `src/lobby/LobbyPresentation.ts` — add a `KNOWN` card (category, blurb, players, playTime,
     thumbKind) so the lobby tile reads well.
5. Add its assets import to the descriptor (`assets/Assets.ts` → `images.logo`).
6. Confirm the renamed template still boots and survives a mid-game refresh in the Test Lobby
   **before changing behavior** (`npm test`, then the verify skill).

## Phase 3 — Implement in thin slices

Work in this order, keeping tests green and the game playable after each slice:

1. **Endpoints** (`models/<newgame>Endpoints.ts`) — the message table as typed
   `MessageEndpoint<REQ, RES>` with named interfaces. Keep payloads small (phones on weak
   links). Request/response endpoints get retry hints; fire-and-forget omit them.
2. **Pure rules** (`models/<newgame>Logic.ts` + `.spec.ts`) — all scoring/validation/geometry
   as pure, framework-free functions **with Jest specs written at the same time**. This is
   where the real logic lives; models only orchestrate. (See `oneOhOneLogic.ts` for a small
   clean example — resolve, bot picks, animation math, all pure + fully specced; or
   `partyPixLogic.ts` for economy/slideshow rules.)
3. **Presenter model** — player subclass, state enum matching the design's phases, round
   lifecycle (`prepareFreshGame`/`prepareFreshRound`/`startNextRound`/`handleTick`), one
   handler per endpoint. Update the type helper with **every** new serializable class.
4. **Client model** — thin: input actions + a `requestGameStateFromPresenter` that FULLY
   rebuilds phone state from the onboard response (clients miss individual pushes).
5. **Views** — one sub-screen component per state on each role. Show `PlayerAvatar` beside
   player names everywhere (join list, scoreboards, winner, phone top bar). Wire model events
   to sounds in the view layer.
6. **Assets** — swap logo/sounds via `assets/Assets.ts`.
7. **Add a `models/PresenterModel.spec.ts`** driving the real presenter through its handlers
   with a recording session stub — **copy the pattern from
   `src/games/PartyPix/models/PresenterModel.spec.ts`**, or from whichever of
   `FaceOff` / `CollageBoard` / `PassTheAux` is closest to your game (all four are the same
   shape and all four end in a **serializer round-trip test**). Eittris's is the exhaustive
   one; OneOhOne's is the smallest but covers reconnect only. Always include the
   **serializer round-trip test** — it catches type-helper mistakes that otherwise only
   surface as broken save/restore mid-game.

### Non-obvious traps (these cost real debugging time)

- **MobX player observability.** `ClusterFunPlayer` never calls `makeObservable`, so
  `@observable` fields on a Player subclass are **inert** in MobX 6 unless the subclass calls
  it itself — views then only re-render when the `players` array itself changes. If your
  presenter UI reads per-player fields and they look stale, add
  `constructor() { super(); makeObservable(this); }` to your Player subclass.
  **`FaceOffPlayer` in `src/games/FaceOff/models/PresenterModel.ts` is the worked example** —
  copy it. Most other games sidestep the trap instead, by not rendering per-player fields
  reactively (see the explicit note on `EittrisPlayer` in
  `src/games/Eittris/models/PresenterModel.ts`). Either is fine; what is never fine is an
  `@observable` on a Player subclass with no `makeObservable`.

- **`playerId` is permanent; `connectionId` is not.** Key all game state by `playerId` — it
  never changes, so a reconnecting player comes back to their own board/pieces/photos. Never
  key anything by `connectionId` (the relay address, new on every reconnect). In a presenter
  handler, `sender` is already the stable `playerId`; the base class translates it.
- **`onPlayerReturned` is abstract — your game will not compile without it.** That is
  deliberate. Usually there is nothing to migrate, so an empty body plus a comment saying why
  is the right answer; implement it properly if you have a seat to hand back from a bot (see
  `src/games/Eittris/models/PresenterModel.ts`). The contract is pinned by
  `src/libs/GameModel/PresenterReconnect.spec.ts` — read it before changing reconnect behavior.
- **A dropped player keeps their seat.** They stay in `players` with `isConnected = false` and
  all their state; broadcasts skip them. Only `bootPlayer()` frees a seat. Grey them out in
  the presenter UI rather than removing them.
- **Never serialize base64 images / large caches.** `saveCheckpoint()` writes to localStorage;
  base64 images blow the quota and make the whole checkpoint throw (silently killing ALL saves,
  so even player scores stop surviving a refresh). List those props in the type helper's
  `shouldStringify` skip-list, and cover it with a round-trip spec.
  (PartyPix's `photoStore`, FaceOff's `matchups`, and CollageBoard's collage are the three
  worked examples of exactly this.) Re-pull heavy state on onboard instead.
- **Call `saveCheckpoint()` after meaningful state changes** (commit, score, phase change).
  Verify by refreshing mid-game in the Test Lobby.
- **Headless has no camera.** Any camera game MUST have a file-pick fallback
  (`<input type="file" accept="image/*" capture="environment">`) or it can't be verified in
  the Test Lobby (and desktop players can't play). Feed the fallback and the live camera into
  the same confirm/commit flow.
- **Format and test before committing.** `npm run format` and `npm test` must both pass.
  This repo is also consumed as a **submodule** by the `clusterfun` deployment repo — commit
  the game here, then bump the submodule pointer over there separately when you want the
  deploy to pick it up.

## Phase 4 — Verify (do not declare done on a green suite alone)

```bash
npm test                 # full Jest suite, one pass
npm run format           # prettier --write
npm run build            # catches TS errors the dev server tolerates (needs secrets.ts)
```

Then **drive the real game in the Test Lobby** with the **clusterfun-testlobby-verify** skill
(or dispatch the **clusterfun-verifier** subagent): join a client, start, run the game's core
loop end to end, and confirm the presenter renders it. A green suite is not a played round.
Playtest notes to capture: joined mid-game, refresh-resumed presenter AND a client, dropped
player rejoined by name.

## Phase 5 — Ship

- Move the registry entry from `gamesListDebug.ts` to `gamesListRelease.ts`.
- Remind the user: the game also has to be added to the **server's `game_manifest`**
  (the separate `clusterfun-server` repo) before it appears in production — the lobby
  intersects the client registry with the server manifest.
