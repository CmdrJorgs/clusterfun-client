# Visual design standards

What every ClusterFun screen owes the room it is played in.

These are not style preferences. Each rule below exists because a specific thing goes wrong
without it — a player who cannot join because the code is 18px on a television, a phone that
letterboxes black while the TV beside it letterboxes teal, a host who cannot tell whether the
game is paused because they paused it or because somebody's phone went to sleep. Where a rule
has a number in it, the number is derived from the canvas arithmetic in
[Measurement](#0-measurement-the-canvas-is-the-unit), not from taste.

**Read [the fixed virtual canvas](../CLAUDE.md) first.** Everything here is expressed in canvas
pixels and assumes you know why the canvas is fixed.

Language: **MUST** is a rule a reviewer should block on. **SHOULD** is a rule you may break with
a comment saying why — the comment is the price. **MAY** is genuinely optional.

Every rule is followed by _why_, and the sections end with the deviations that exist in the
codebase today, named and located, so this document describes the target rather than pretending
it describes the present.

---

## 0. Measurement: the canvas is the unit

Every size in this document is in **canvas pixels** — the coordinate space you author in, before
`UINormalizer` scales it. Presenters are 1920×1080, clients are 1080×1920.

Canvas pixels are an honest unit precisely because the canvas scales to fit. A presenter's 24px
is the same fraction of a laptop screen and of a 55" television, so a size that reads on one
reads on the other. That is the whole payoff of the fixed canvas, and it is why this document can
dictate numbers at all.

The two reference viewings, which every number below is checked against:

|                   | Presenter                        | Client                 |
| ----------------- | -------------------------------- | ---------------------- |
| Canvas            | 1920×1080                        | 1080×1920              |
| Reference device  | 55" 16:9 television (686mm tall) | 6.1" phone (65mm wide) |
| Viewing distance  | 3m (across a room)               | 350mm (in the hand)    |
| **1 canvas px ≈** | **0.635mm**                      | **0.060mm**            |

On the phone the canvas is **width-bound**: a 1080×1920 canvas is 1.78 tall-to-wide, a modern
phone is ~2.17, so the canvas fills the width and letterboxes top and bottom. This matters in
[§7](#7-background-bleed-and-the-content-box) — those bars are real estate you are choosing the
colour of.

Legibility is judged in **arcminutes of subtended angle**, which is the only measure that
survives both viewings. Comfortable sustained reading wants ≳17′; below ~12′ text is decoration.

```
presenter 24px → 15.2mm at 3m    → 17.4′   floor
presenter 32px → 20.3mm at 3m    → 23.3′   comfortable
presenter 16px → 10.2mm at 3m    → 11.6′   unreadable across a room
client    24px →  1.44mm at 350mm → 14.2′   floor, and only for chrome
client    32px →  1.92mm at 350mm → 18.9′   comfortable
```

---

## 1. Room codes

The room code is the only thing standing between a person holding a phone and being in the game.
It is not chrome.

1.1 The room code **MUST** appear on the presenter, and **MUST NOT** appear on the client. A
phone that can render the code is already in the room; the space is worth more to the game.
_(Every game already gets this right — no `Client.tsx` references `roomId`. It is written down
here so it stays that way.)_

1.2 Wherever the code appears, the **join host MUST appear with it**, in the same visual unit.
A bare "Room Code: ABCD" is unusable to somebody who just walked in and does not know where to
type it. Pair them: `Join at <host> · <CODE>`.

1.3 On the **gathering screen** the code is the primary element. It **MUST** be the largest text
on the screen and **MUST** be ≥ 150px. PartyPix's 190px `.joinCode` is the exemplar.

1.4 While the game is running the code **MUST** stay visible for the entire game, in the
persistent chrome strip ([§4](#4-buttons-and-chrome)), at **≥ 30px**. People arrive late, and
phones die and come back. A code that disappears when the game starts converts a latecomer into
a spectator.

1.5 The code **SHOULD** be visually distinguishable from its label — heavier, or larger, or in
the accent colour. `Room Code:` at 100% above the code at 180% (Lexible) is the established
pattern.

> **Deviations today.** PartyPix renders its persistent join line (`.frameJoin`) at **18px** —
> 11.6′ on a television — and the comment directly above it correctly identifies that line as
> "the one line on the big screen that somebody across the room needs". It is the most important
> line on the presenter set at the smallest size on the presenter. Separately, PartyPix is the
> only game that satisfies 1.2 while playing: Lexible, Eittris, OneOhOne, CollageBoard,
> Template, Stressato, PassTheAux (`ROOM {id}`, 26px), FaceOff (30px) and RetroSpectro all show
> a **bare code with no host**.

---

## 2. Minimum text size

The floors are absolute. There is no "but it's only a caption" — a caption nobody can read is
not a caption.

|               | Absolute floor | Body text | Must be read from across the room / acted on |
| ------------- | -------------- | --------- | -------------------------------------------- |
| **Presenter** | 24px           | ≥ 32px    | ≥ 48px                                       |
| **Client**    | 24px           | ≥ 32px    | ≥ 40px                                       |

2.1 No text on either surface **MUST** be below **24px**. Below that it falls under 15′ at the
reference viewing and stops being readable rather than merely small.

2.2 The 24px floor is for **chrome only** — version tags, dev affordances, footnotes. Anything a
player reads as part of playing **MUST** be ≥ 32px.

2.3 Anything a player must act on — a prompt, a timer, a score they are chasing, the room code —
**MUST** be ≥ 48px on the presenter. At 3m that is ≳35′, which survives a lit room and a
cheap panel.

2.4 Percentage font sizes (`font-size: 180%`) are fine **inside** a component whose base is
anchored in px, and **MUST NOT** be used where the inherited base is a game-level body size that
another game will set differently. This is not hypothetical: `GameVersionTag`'s changelog panel
inherited its size from whatever corner it sat in, and PartyPix's 14px footer produced a **9.8px
changelog on a television**. It is now anchored at an absolute 24px. `ClientHeader` anchors
itself at 40px for the same reason — every `em` inside it resolves against that, so a game's
own body size cannot reach in.

2.5 Tap targets on the client **SHOULD** be ≥ 150px (≈9mm) in both dimensions. Below that,
thumbs miss.

> **The deliberate exception.** `ClientHeader`'s quit region is a fixed **120px** (≈7.2mm),
> below 2.5 on purpose. Quit is the one control where a mis-tap is unrecoverable — it ends
> somebody's game mid-round — so it is small, and it is in the corner. Do not "fix" it, and do
> not copy its size for anything else.

> **Deviations today.** Eight declarations sit below the presenter floor:
> `FaceOff/Presenter.module.css:49` (16px) and `:110` (18px);
> `PartyPix/Presenter.module.css:90, :104, :110, :115` (18px);
> `PassTheAux/Presenter.module.css:141` (16px) and `:993` (18px).
> Three sit below the client floor: `PassTheAux/Client.module.css:213, :485` (22px) and
> `:601` (20px).

---

## 3. Player names

A player must be able to find themselves on both screens, instantly, without reading.

3.1 On the client, the player's own name lives in **`ClientHeader`** and nowhere else. It
**MUST NOT** be repeated elsewhere on the phone. All ten games use `ClientHeader`; the strip
exists because it was seven different strips that had drifted apart, and a player who plays two
games in an evening should not have to hunt for the quit button twice.

3.2 Anywhere a player's name appears — join lists, scoreboards, turn indicators, winner screens
— it **MUST** be accompanied by that player's **`PlayerAvatar`**. Names are read; avatars are
recognised. Across a room, at speed, only the second one works.

3.3 `PlayerAvatar` **MUST** be passed **both `avatarId` and `colorIndex`**. The player picked a
shape _and_ a colour in the lobby and both travel on the Join message. Passing only the shape
silently renders every player in the default colour, so two players who picked the same shape
become indistinguishable — which is exactly the case the colour was added to solve.

```tsx
// wrong - drops the player's chosen colour
<PlayerAvatar avatarId={p.avatarId} size={44} />

// right
<PlayerAvatar avatarId={p.avatarId} colorIndex={p.avatarColor} size={44} />
```

3.4 Disconnected players **MUST** stay visible and **MUST** be rendered as clearly diminished —
greyed, dimmed, or badged. They keep their seat and all their state
([lifecycle §1c](../CLAUDE.md)); removing them from the screen tells the room a lie, and tells
the host to stop waiting for somebody who is coming back.

3.5 A name is public and a `playerToken` is not. Never render a token, and never render a
`connectionId` outside `DevUI`.

> **Deviations today.** Fifteen `PlayerAvatar` call sites drop `colorIndex`:
> `CollageBoard/Presenter.tsx:55, :92, :230`; `FaceOff/Presenter.tsx:71, :104, :159, :248, :274,
:286` and `FaceOff/Client.tsx:300`; `PassTheAux/Presenter.tsx:167, :287, :706, :764, :821`.

---

## 4. Buttons and chrome

**The presenter is not a touch surface.** It is a television, or a laptop across the room. The
only person who can reach it is the host, and only if the laptop is in front of them.

4.1 Every interactive control on the presenter **MUST** be a **host** control — pause, quit, dev
affordances. Game actions **MUST NOT** require touching the presenter. Everything a player does,
they do on their phone.

4.2 The presenter **MUST** carry exactly one persistent **chrome strip**, as the first child of
`UINormalizer`, so it is the top row of the canvas. Its order, left to right:

```
[ Quit ] [ Pause ] [ room code + join host ] [ game-specific status ] [ DevUI ] [ version tag ]
```

Eight games already render this as `renderFrame()`. The order is fixed for the same reason
`ClientHeader`'s geometry is fixed: a host who runs two games in an evening should find Quit in
the same place both times.

4.3 The chrome strip **MUST NOT** scroll away, be covered by game content, or be conditional on
game state. It is the one region that is always true.

4.4 On the client, the **primary action MUST be in the lower half** of the canvas — that is
where a thumb reaches on a phone held one-handed. The upper 120px is `ClientHeader` and the top
third is for context, not controls.

4.5 Client buttons **MUST** meet the 150px tap-target floor of [§2.5](#2-minimum-text-size), and
destructive or irreversible actions **MUST NOT** sit adjacent to a frequently-tapped control.

4.6 Modals and overlays **MUST** use `position: fixed`. Inside `UINormalizer`'s CSS transform,
`fixed` resolves against the **transformed ancestor**, so it covers the normalized canvas rather
than the browser window — which is what makes it land correctly at every window size.
`GameVersionTag`'s changelog panel and `ClientHeader`'s overlay both rely on this.

> **Deviations today.** PartyPix bottom-anchors its join line instead of carrying it in the top
> strip, and RetroSpectro arranges its own frame. Both are legible; both break 4.2's promise
> that Quit is in the same place in every game.

---

## 5. Leaving the game

Leaving must be possible from anywhere, obvious when you look for it, and impossible to hit by
accident. It also must not mean what players think it means — see 5.4.

5.1 The client's only exit is the **X in `ClientHeader`'s fixed 120px right region**, with
`aria-label="Quit the game"`. Every client **MUST** pass `onQuit` to `ClientHeader` — all ten
already do — and **MUST NOT** render a quit control anywhere else, **in any game state,
including `GameOver` and `JoinError`**. `onQuit` on `ClientHeader` should be the only
`quitApp()` call site in a client view.

The exception people reach for is the terminal screen: the game is over, nothing is left to lose
by a mis-tap, so why not offer a friendly labelled button? Because the X is not a mid-round
affordance that a finished game makes redundant — it is **the way out of a ClusterFun game**, and
it is only learned by being the way out every time. A body button on the last screen teaches a
player that the real exit is wherever this game decided to put it, which is the exact drift
`ClientHeader` was built to end: it was seven different strips before it was one, and a player
who plays two games in an evening should not have to find the quit button twice. The final screen
is where a player is most likely to be looking for the exit, so it is the worst screen on which
to put it somewhere new.

`ClientHeader` is an unconditional child of `.gameclient` in all ten clients — it does not depend
on game state — so the X is present on `GameOver` and `JoinError` already. A game removing its
terminal-screen button is not removing the player's way out; it is removing the second one.

5.2 The presenter's only exit is the **Quit button at the left of the chrome strip**
([§4.2](#4-buttons-and-chrome)).

5.3 Quit **MUST NOT** be given a confirmation dialog on the client, and **SHOULD** be given one
on the presenter. The asymmetry is deliberate: a player quitting costs that player a seat they
can walk straight back into (5.4), while a host quitting **ends the room for everybody**.

5.4 **Quitting does not free a seat, and the UI must not imply that it does.** A client Quit
sends `QuitEndpoint`; the presenter marks the player disconnected and **holds the seat with all
its state**. A clean quit and a phone in a tunnel are deliberately not distinguished, because a
phone in a tunnel never sends a Quit. So:

- Do **not** label the client's X "Leave game forever" or warn about losing progress.
- Do **not** remove the player from the presenter's roster — grey them out
  ([§3.4](#3-player-names)).
- The **only** control that frees a seat is the host's `bootPlayer()`, and that is the only place
  a "remove player" affordance may exist.

  5.5 The three ways a game ends are distinct and **MUST** read differently to the player, because
  `endReason` already distinguishes them and the lobby behaves differently for each:

| `endReason`  | What happened                           | What the phone should say          |
| ------------ | --------------------------------------- | ---------------------------------- |
| `quit`       | The player pressed X                    | Back to the lobby, seat still warm |
| `hostEnded`  | The game reached GameOver               | The game is over — show the result |
| `terminated` | The host closed the room, or booted you | This room is finished              |

> **Deviations today — this is the biggest single cleanup in this document.** Nine of the ten
> clients render a second `Quit` button on their `GameOver` screen, in addition to the header X:
> `CollageBoard/Client.tsx:840`, `Eittris:932`, `FaceOff:346`, `Lexible:160`, `OneOhOne:231`,
> `PartyPix:487`, `PassTheAux:410`, `TemplateGame:191`, `RetroSpectro/client/Client.tsx:142`.
> Stressato is the only client without one. All nine call the same `quitApp()` the X calls, so
> they are pure duplicates — removing each is a delete, with no replacement needed and no state
> in which a player is left without an exit.

---

## 6. Too few and too many players

Both failures are the lobby's job to explain, and both are currently explained to the wrong
person.

### Too few

6.1 While gathering, the presenter **MUST** show the shortfall **with the current count**, not
just the requirement: `Waiting for at least 4 players (2 so far)…`. "Waiting for at least 4
players" alone leaves a room of three people staring at a screen with no idea whether it can see
them. FaceOff's `Presenter.tsx:122` is the exemplar.

6.2 The start control **MUST** be disabled below `minPlayers`, and its disabled state **MUST** be
visually obvious — not merely inert. Six games disable it; a greyed button that gives no reason
sends the host looking for a bug.

6.3 When connected players fall below `minPlayers` mid-game the base class **auto-pauses**, and
the presenter **MUST** say which pause this is. `_pausedWaitingForPlayers` already distinguishes
"I paused this" from "the game paused itself waiting for Dana to come back", and the host cannot
tell them apart from a screen that just says **Paused**. Name the missing players — they are in
`players` with `isConnected === false`.

6.4 That pause auto-resumes when enough players return, and the presenter **MUST NOT** require a
host action to clear it. A pause the host asked for is left alone.

### Too many

6.5 When a join is refused because the room is full, the presenter **MUST** show it. Today the
refusal is delivered only to the phone that got refused — the presenter shows nothing, so the
host watching somebody fail to join has no idea why. The room is full is a fact about the room,
and the room is what the presenter is for.

6.6 The client's `JoinError` state **MUST** render the reason at body size, not as a footnote,
and **MUST** distinguish the three cases the presenter actually returns: `name_taken`,
`room_full`, `room_closed`. "Could not join the game because: The room is full" is right;
swallowing the reason is not.

6.7 **A game's lobby card MUST NOT advertise a range its presenter will refuse.** The card in
`LobbyPresentation.ts` and the model's `minPlayers`/`maxPlayers` are two copies of one fact, and
they drift. The card's minimum **MUST** be ≥ the model's `minPlayers`, and the card's maximum
**MUST** be ≤ the model's `maxPlayers`. A card may be _stricter_ than the model — that is how a
game keeps a dev-only solo mode without advertising it — but it may never be looser.

> **Deviations today.** Two cards advertise what the model refuses, both in debug-only games:
> **Template** advertises `1–8` against `minPlayers = 2`, so a host who gathers the advertised
> one player can never start; **Stressato** advertises `1–99` against the default
> `maxPlayers = 8`, so players 9 and up are told the room is full. Two more are merely stricter
> and therefore legal, but understate the game: **RetroSpectro** advertises `3–10` against
> `2–50`, and **Eittris** advertises `2–16` against `1–16`.

---

## 7. Background bleed and the content box

The canvas scales to fit **both** dimensions, so on almost every real screen there is margin left
over. That margin is part of the design.

The mechanism is easy to get backwards, so state it exactly. `UINormalizer` puts `className` and
`backdropClassName` on the **outer, full-viewport div**, and renders `children` inside the
**scaled canvas div**:

```
<div class={className + backdropClassName}>   ← full viewport. Background bleeds here.
  <div transform: scale(...)>                 ← the canvas: 1920×1080 / 1080×1920
    {children}                                ← ALL content lives here
  </div>
</div>
```

7.1 **Bleed the background; box the content.** The game's background colour **MUST** be applied
via `className`/`backdropClassName` so it fills the letterbox margin, and **all content MUST** be
a child of `UINormalizer` so it stays inside the canvas.

7.2 The class passed to `UINormalizer` **MUST** be limited to **background paint and inherited
tokens** — `background`, `background-color`, `color`, `font-family`, CSS custom properties. It
**MUST NOT** set `padding`, `margin`, `border`, or `width`/`height`, and **MUST NOT** contain
content. Box properties there offset the canvas rather than being scaled with it, and content
there is rendered at raw device pixels — the one place on the whole surface where the canvas
guarantee does not apply.

7.3 **Decoration that must line up with content MUST be a child**, not backdrop paint. PartyPix's
`.glowCyan` and PassTheAux's `.noise` are children, so they letterbox with the layout they belong
to. Only a flat wash belongs on the backdrop; a gradient positioned against the composition will
visibly slip if you bleed it.

7.4 Nothing readable or interactive **MAY** be positioned outside the canvas. The margin is a
frame, not an overflow area.

7.5 `width: 100%; height: 100%` on the class passed to `UINormalizer` is **inert** — the
component sets exact pixel width and height inline, and inline wins. Harmless, but it reads as
though it is doing something. On a child (`.gameclient`) it is correct and load-bearing: the
child fills the canvas rather than sizing itself from the device.

7.6 `body { background: #08080d }` in `index.css` is the backstop, and **MUST NOT** be treated as
a design choice. It exists so the margin does not flash white before a screen paints its own
backdrop.

> **Deviation today — this is the whole asymmetry.** All ten presenters pass
> `className={styles.gamepresenter}` to `UINormalizer`, so every television letterboxes in the
> game's own colour. **Not one client passes `className` or `backdropClassName`** — `.gameclient`
> is a child div — so every phone letterboxes to the global near-black instead. On the
> width-bound phone geometry of [§0](#0-measurement-the-canvas-is-the-unit) those are real bars
> above and below the content, and they are the wrong colour in all ten games. The lobby already
> does it correctly (`LobbyComponent.tsx:677`, `backdropClassName={styles.clientStage}`) and is
> the pattern to copy.

---

## What is mechanically checkable

`libs/components/virtualCanvas.spec.ts` is the precedent: it reads the source, because the
regression it guards against breaks no behavioural test and no build — it just quietly stops
being the same UI on every device. Most of the rules above have the same property.

Checkable by reading the source, in rough order of value:

| Rule                                            | Check                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| [§2](#2-minimum-text-size)                      | No `font-size: <24px` in any game `*.module.css`                           |
| [§6.7](#too-many)                               | Every lobby card's range is inside its model's `minPlayers`/`maxPlayers`   |
| [§3.3](#3-player-names)                         | Every `PlayerAvatar` call site passes `colorIndex`                         |
| [§7.1](#7-background-bleed-and-the-content-box) | Every `Client.tsx` passes `backdropClassName` to `UINormalizer`            |
| [§1.1](#1-room-codes)                           | No `Client.tsx` references `roomId`                                        |
| [§5.1](#5-leaving-the-game)                     | `ClientHeader`'s `onQuit` is the ONLY `quitApp()` call site in each client |
| [§4.6](#4-buttons-and-chrome)                   | No overlay uses `position: absolute` where it means to cover the canvas    |

The remainder — placement, hierarchy, whether a pause explains itself — needs eyes, and belongs
in review.
