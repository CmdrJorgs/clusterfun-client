# Sushi Sync — Plate Art Spec

> The contract between the drawings and the code. If you are picking up a pen, this is the
> only file you need. If you are changing the renderer, keep this and
> [`models/plateArt.ts`](../models/plateArt.ts) in step — that file is the executable copy of
> these numbers.

## The one rule that shapes everything else

A plate's contents are an **ordered list**, and **layering things in the wrong order is
legal** — it scores as a Flawed Serve rather than being blocked (see
[DESIGN.md](../DESIGN.md)). The visible stack is the only cue a chef gets that a plate has
gone wrong before someone serves it.

So the renderer **paints in the order the chefs applied the layers**, never in canonical
Base → Binder → Filling → Topping order. Nori stacked on top of tobiko is _supposed_ to look
wrong.

The consequence for you, at the drawing board:

> **Draw each ingredient as a self-contained slab that reads correctly at any height in the
> stack.** Nori is a flat dark sheet. Rice is a mound. Salmon is a slice. Tobiko is a scatter.
>
> Do **not** draw "salmon draped over a rice ball" — that only composites correctly in one
> position, and the game will put it in all of them.

## Canvas

Every ingredient file, and the dish, uses the same canvas. That uniformity is what lets the
renderer stack them with no per-asset offset data — the alignment is baked into the art.

|                    |                                                                    |
| ------------------ | ------------------------------------------------------------------ |
| **Size**           | **512 × 384** px (4:3)                                             |
| **Format**         | PNG-32 with alpha                                                  |
| **Seat line**      | y = **292** — every ingredient rests its bottom here               |
| **Layer band**     | x **80 → 432** (352 wide), up to **100 px** above the seat line    |
| **Drip zone**      | 12 px _below_ the seat line, for sauces and scatters that overhang |
| **Dish footprint** | roughly x 20 → 492, centred on the seat line — **its own file**    |

Start from [`images/_template.svg`](images/_template.svg), which has all of this as guides.
Hide the guide layer before exporting.

Why 4:3 and not square: the subject is a wide shallow dish with a modest stack on it. A square
canvas spent about 45% of its pixels on empty air above a typical three-layer plate.

### Why 512 wide

Worked from the actual worst-case render across the three places a plate appears:

| Where                        | Virtual px | Worst-case physical px                  |
| ---------------------------- | ---------- | --------------------------------------- |
| Presenter belt ring          | 96         | ~200 (4K display, UINormalizer scale 2) |
| Phone conveyor               | 150        | ~200                                    |
| Phone workstation hero plate | 460        | ~640 (very high-DPI Android)            |

512 is at or above 1:1 on essentially every phone and downscales everywhere else. **Author at
2048** and downsample, so there is headroom if the hero plate ever grows.

If the hero plate does need more resolution later, bump **`dish.png` only** to 1024 — it is
one file, where the ingredients are thirteen.

## Files

```
assets/images/
  dish.png                 the empty plate
  _template.svg            drawing guides (not shipped — no code imports it)
  ingredients/
    nori.png  soypaper.png
    whiterice.png  brownrice.png
    salmon.png  tuna.png  eel.png  cucumber.png  avocado.png
    tobiko.png  spicymayo.png  eelsauce.png  sesame.png
```

Filenames match `Ingredient.id` in [`sushiSyncLogic.ts`](../models/sushiSyncLogic.ts)
**exactly**. To add an ingredient you need all four of:

1. the PNG, named for its id,
2. a static import + map entry in [`Assets.ts`](Assets.ts),
3. an entry in `INGREDIENTS` in `sushiSyncLogic.ts`,
4. a rise in `INGREDIENT_RISE` in [`plateArt.ts`](../models/plateArt.ts).

`SushiPlate.spec.tsx` fails the build if 1–3 drift apart, and `plateArt.spec.ts` fails if 4
is missed.

> The imports in `Assets.ts` are spelled out one per line on purpose: CRA/webpack cannot
> resolve ``import(`./ingredients/${id}.png`)`` from a variable, and an explicit list turns a
> missing file into a compile error instead of a blank layer at Rush Hour.

## Rise — how tall each ingredient stands

A layer is lifted by the **total rise of everything beneath it**. Rise is a property of the
ingredient, not a constant, because a sesame sprinkle lifting the next layer as far as a rice
mound looks absurd.

**Rise is deliberately smaller than the drawn body**, so layers overlap the way a real stack
does. A nori sheet drawn 26 px tall with a rise of 18 shows an 18 px sliver of dark green
under the rice — and that sliver is the cue.

| Ingredient             | Rise | Drawn body (placeholder)    |
| ---------------------- | ---- | --------------------------- |
| Nori, Soy Paper        | 18   | 26 — flat sheet             |
| White Rice, Brown Rice | 56   | 78 — rounded mound          |
| Salmon, Tuna, Eel      | 34   | 46 — draped slice           |
| Cucumber, Avocado      | 30   | 42 — batons / fanned slices |
| Tobiko                 | 16   | 22 — roe scatter            |
| Spicy Mayo, Eel Sauce  | 12   | 18 — zig-zag drizzle        |
| Sesame                 | 10   | 14 — fine sprinkle          |

Draw first, then tune the rise in `plateArt.ts` to match what you actually drew. Nothing else
needs to change.

### Tall stacks compress

Duplicate ingredients are legal up to `MAX_STACK_HEIGHT` (8), so a chef who owns rice can
build a rice skyscraper. Past a cumulative rise of **192** the renderer scales every offset
down proportionally so the tower stays in frame. The longest legal _recipe_ tops out around
142, so this only ever fires on deliberate over-stacking.

## File budget

Keep the whole ingredient set **under ~800 KB**. At 512 × 384 with large transparent regions,
a quantized PNG-32 should land at 20–50 KB. Run finished art through `pngquant` or `oxipng`
and **commit the optimized file** — the build does not optimize images, and the game is a
lazily-loaded chunk that phones fetch over party wifi.

WebP would be roughly 30% smaller and is safe in every browser that matters, but PNG stays the
source of truth. Worth revisiting only if the set overruns its budget.

## Where the art shows up

| Surface                            | Component          | Size |
| ---------------------------------- | ------------------ | ---- |
| Presenter belt ring                | `SushiPlate`       | 96   |
| Presenter order board recipe chips | `IngredientSwatch` | 46   |
| Presenter round briefing           | `IngredientSwatch` | 64   |
| Phone conveyor                     | `SushiPlate`       | 150  |
| Phone workstation hero plate       | `SushiPlate`       | 460  |
| Phone ingredient buttons           | `IngredientSwatch` | 110  |
| Phone round briefing               | `IngredientSwatch` | 120  |

`IngredientSwatch` crops tightly to the layer band and scales it up, so a thin ingredient
still reads next to its label instead of becoming a two-pixel sliver. Thin ingredients still
_look_ thin there — the swatch is the same silhouette the chef will hunt for on a plate.

## Preloading

All thirteen ingredients are preloaded during the round briefing — on the presenter from
`activeIngredientIds`, on the phone the full set (a phone is never told which ingredients are
active, and plates arrive carrying whatever the chefs upstream added). Without this the first
plate carrying each ingredient pops in mid-service, worst exactly at Rush Hour speed.

If you add an ingredient, preloading picks it up automatically.

## Placeholders

Everything currently in `ingredients/` is a placeholder generated by
[`scripts/generate-sushi-placeholders.py`](../../../../scripts/generate-sushi-placeholders.py).
They are drawn to this exact geometry, so **replace them one file at a time** — nothing in the
code cares who drew them. Rerun that script if you retune the geometry and want the
placeholders to follow.

## Ideas parked here

At real kaiten-zushi, **plate colour encodes price**. Payout already scales with recipe length
(`50 + 25 × length`), so three or four dish colourways would make a plate's value readable
across the room. Cheap to add: the dish is a single separate file.
