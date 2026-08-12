# Minefield

A co-operative game of asymmetric information for ClusterFun. One player walks a minefield
they cannot see. Everyone else on their team can see it — but each of them only holds a
**fragment** of the intel, and nobody holds all of it. The team has to talk.

See [DESIGN.md](DESIGN.md) for the full spec and the decisions behind it.

## How to play

- **2–16 players**, in **1–4 teams**, over **3 rounds** (about 20 minutes).
- The host picks a difficulty on the big screen — **Recruit / Sapper / Veteran / Nightmare**,
  or opens **Advanced** and sets each knob by hand — and picks each team's explorer (or hits
  🎲 for a random one). The boots pass to somebody new each round.
- **If you are the Explorer:** your phone shows your current cell and the cells you can step
  to, drawn to scale in their real positions. That is all. You cannot see the map and you
  cannot see what is buried anywhere. Describe what is in front of you and do as you are told.
- **If you are an Advisor:** your phone shows the whole field with **your share** of the
  mines, walls and switches marked. Your teammates hold the rest. Pool it out loud and talk
  your explorer across.
- The big screen shows the **outline** of the field, the start ★, the goal ⚑ and each team's
  trail. It never shows cells or hazards — everyone can see it, and half the room is not
  supposed to know what is out there.

**Nothing on any screen names a cell.** No compass, no grid references, no numbers. Working
out how to say "that one, the pointy one — no, the _other_ pointy one" while a clock runs is
the game. The only thing you get for free is that up is up on everybody's screen.

## What is out there

| Hazard              | What it does                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Standard mine**   | Kills instantly.                                                                                                                               |
| **Multi-step mine** | Takes 2–5 steps before it kills. Advisors are shown the total and it is **never** counted down — remembering is your job.                      |
| **Freeze mine**     | Ten seconds where you cannot move at all.                                                                                                      |
| **Motion mine**     | Arms when you step _next to_ it, and goes off two movements later. Get clear and it blows harmlessly; the crater is then safe to walk through. |
| **Invisible mine**  | Not on anybody's map. Arms when trodden on, then behaves like a motion mine.                                                                   |
| **Wall + switch**   | A thick line you cannot cross until somebody steps on its switch — usually in the wrong direction entirely.                                    |
| **Missing cells**   | Holes in the field.                                                                                                                            |

Die and you go back to the start with the field reset — but the deaths are your score, and
your failed run stays on the big screen as a ghost trail with a skull where it ended. Rival
teams can read those too.

## Scoring

Reaching the goal is 1000 points plus 5 per second left, minus 150 per death (never below
zero). Ties break on fewest deaths, then fewest steps, then who got there first.

## Running it

`npm start` → Test Lobby → **Minefield**. Two players is enough to play (one explorer, one
advisor); four or more is where it gets good, because that is when the intel starts being
genuinely split.

## Where the code lives

| File                           | What it holds                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models/minefieldMap.ts`       | Field generation (jittered lattice → merge → carve), plus the two checks that make a field fair: `countDisjointRoutes` and `findSafeRoute`. Pure. |
| `models/minefieldLogic.ts`     | The rules: step resolution, fuses, intel distribution, scoring. Pure.                                                                             |
| `models/minefieldEndpoints.ts` | The wire API, and the redaction contract.                                                                                                         |
| `models/PresenterModel.ts`     | The authority: the field, every team's run, every advisor's share.                                                                                |
| `models/ClientModel.ts`        | Thin. Taps in, whatever this role is allowed to see out.                                                                                          |
| `views/MosaicMap.tsx`          | The advisor's map. `views/Presenter.tsx` draws the silhouette.                                                                                    |
| `views/mapGeometry.ts`         | Drawing helpers shared by both roles' screens.                                                                                                    |

Every rule is unit-tested in `minefieldLogic.spec.ts` / `minefieldMap.spec.ts`, and
`PresenterModel.spec.ts` drives the real presenter — including the check that an explorer's
onboard response contains no hazard data at all.
