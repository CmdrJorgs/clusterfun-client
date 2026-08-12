# Sushi Sync

A co-operative, real-time ClusterFun game for **3–8 players** who are **in the same room**.

Lay your phones face-up in a ring around the shared screen. Together they form one conveyor
belt: plates ride off the right edge of one phone and onto the left edge of the next. You are
sushi chefs, and the customers are getting impatient.

See [DESIGN.md](DESIGN.md) for the full spec.

## How to play

1. **Seat up.** Everyone joins, then the big screen assigns each player a **station number**.
   Arrange yourselves physically so the ring matches. Use the **Swap** buttons on your phone
   if you'd rather trade places with a neighbor.
2. **Learn your ingredients.** Each round you get an exclusive handful of ingredients — if you
   own the Eel, you are the _only_ person who can put eel on a plate.
3. **Work the belt.** Empty plates tagged with a table number roll across the top of your
   phone. Tap one to pull it into your workstation.
4. **Look up.** Your phone shows the plate's _table number_, not its recipe. Only the big
   screen knows Table 3 ordered a Dragon Roll. Read the board, or ask whoever can see it.
5. **Build in order.** Layers go on as `Base → Binder → Filling → Topping`. You almost
   certainly don't own every layer, so add what you can and **Return to Belt** so the next
   chef can add theirs.
6. **Serve it.** When the plate is done, hit **SERVE**. Perfect plates pay full price plus a
   speed tip. Wrong order or missing layers pay partial and cost you.

Three strikes and the shift is over. Three rounds — Lunch Rush, Dinner Service, Rush Hour —
each faster than the last, with ingredients reshuffled in between.

## Notes

- **Trashing a plate is free.** If a plate is unsalvageable, bin it — the order respawns a
  fresh plate. You only lose time, which is punishment enough.
- **Talking is the game.** The information is deliberately split across the room. A quiet
  table will fail.
- **Physical co-location is required**, unlike most ClusterFun games, which tolerate remote
  players watching over a video call.

## Development

Registered in `gamesListDebug.ts`, so it's dev-only until it's added to `gamesListRelease.ts`
and the server's `game_manifest`. Run `npm start` and pick **Sushi Sync** in the Test Lobby.

Tuning constants live in `models/GameSettings.ts`. If playtests find the game too punishing,
`SHOW_MY_TURN_HIGHLIGHT` and `SHOW_NEXT_LAYER_HINT` (both `false` by default) soften the
information load without touching game logic.

### Plate art

Every ingredient is a separate PNG layered onto the plate in the order the chefs applied it,
so a plate always shows exactly what is on it — including when it has gone wrong.
**[assets/ASSETS.md](assets/ASSETS.md)** is the drawing contract: canvas, seat line, layer
band, per-ingredient rise, and how to add an ingredient. Layout maths is pure and tested in
`models/plateArt.ts`; the renderer is `views/SushiPlate.tsx`.

The art in `assets/images/ingredients/` is currently **placeholder** — drawn to the exact
spec geometry so real art can replace it one file at a time.
