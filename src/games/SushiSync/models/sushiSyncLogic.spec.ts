import {
  INGREDIENTS,
  Ingredient,
  IngredientCategory,
  Rng,
  advanceBelt,
  assignIngredients,
  basePayoutFor,
  chefScore,
  chooseActiveIngredients,
  compactStations,
  dishNameFor,
  findTopChefs,
  generateRecipe,
  ingredientById,
  ingredientName,
  ingredientsOfCategory,
  isPlateInReach,
  matchingPrefixLength,
  neighborsOf,
  nextRequiredIngredient,
  progressAcrossStation,
  redistributeOrphanedIngredients,
  sameMultiset,
  sameSequence,
  scorePlate,
  shuffled,
  speedTip,
  starRating,
  stationAt,
  wrapBelt,
} from "./sushiSyncLogic";
import { PAYOUT_BASE, PAYOUT_PER_LAYER, STRIKE_FOR_FLAWED } from "./GameSettings";

// Unit tests for the pure game rules.  Every rule in sushiSyncLogic.ts should have coverage
// here - this suite runs in the deploy pipeline, so a broken rule blocks a release.

// A deterministic rng so every shuffle/pick below is reproducible.
function seededRng(seed = 1): Rng {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const alwaysZero: Rng = () => 0;

describe("ingredient catalog", () => {
  it("has at least two Bases and two Binders so no single chef gates every plate", () => {
    // This is the fix for the bottleneck flaw: with exclusive ownership, one mandatory
    // ingredient would make its owner a hard dependency for every order on the belt.
    expect(
      ingredientsOfCategory(INGREDIENTS, IngredientCategory.Base).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      ingredientsOfCategory(INGREDIENTS, IngredientCategory.Binder).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("has unique ids", () => {
    const ids = INGREDIENTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("looks ingredients up by id and falls back to the raw id for unknown names", () => {
    expect(ingredientById("nori")?.name).toBe("Nori");
    expect(ingredientById("wasabi")).toBeUndefined();
    expect(ingredientName("eel")).toBe("Eel");
    expect(ingredientName("wasabi")).toBe("wasabi");
  });
});

describe("shuffled", () => {
  it("preserves the multiset and leaves the input untouched", () => {
    const input = ["a", "b", "c", "d", "e"];
    const out = shuffled(input, seededRng(7));
    expect(out.slice().sort()).toEqual(input.slice().sort());
    expect(input).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("chooseActiveIngredients", () => {
  it("guarantees at least one ingredient per player", () => {
    for (let players = 3; players <= 8; players++) {
      const active = chooseActiveIngredients(players, 4, seededRng(players));
      expect(active.length).toBeGreaterThanOrEqual(players);
    }
  });

  it("includes two Bases and two Binders at every table size", () => {
    for (let players = 3; players <= 8; players++) {
      const active = chooseActiveIngredients(players, 4, seededRng(players));
      expect(ingredientsOfCategory(active, IngredientCategory.Base).length).toBe(2);
      expect(ingredientsOfCategory(active, IngredientCategory.Binder).length).toBe(2);
    }
  });

  it("gives a 3-player round 1 more than a couple of possible orders", () => {
    // Regression guard for a real playtest failure: with only one Base and one Binder active,
    // every short recipe was identical, the board filled with the same ticket three times,
    // and reading the shared screen stopped being worth doing.
    const active = chooseActiveIngredients(3, 4, seededRng(3));
    const seen = new Set<string>();
    for (let s = 1; s < 60; s++) seen.add(generateRecipe(active, 2, 3, seededRng(s)).join(">"));
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("always includes a filling and a topping so long recipes are reachable", () => {
    const active = chooseActiveIngredients(3, 4, seededRng(11));
    expect(ingredientsOfCategory(active, IngredientCategory.Filling).length).toBeGreaterThan(0);
    expect(ingredientsOfCategory(active, IngredientCategory.Topping).length).toBeGreaterThan(0);
  });

  it("never returns duplicates and never exceeds the pool", () => {
    const active = chooseActiveIngredients(8, 99, seededRng(5));
    expect(new Set(active.map((i) => i.id)).size).toBe(active.length);
    expect(active.length).toBeLessThanOrEqual(INGREDIENTS.length);
  });

  it("grows with the round's ingredient target", () => {
    const early = chooseActiveIngredients(3, 4, seededRng(2));
    const late = chooseActiveIngredients(3, 10, seededRng(2));
    expect(late.length).toBeGreaterThan(early.length);
  });
});

describe("assignIngredients", () => {
  it("gives every active ingredient exactly one owner", () => {
    const active = chooseActiveIngredients(5, 7, seededRng(4));
    const map = assignIngredients(["a", "b", "c", "d", "e"], active, seededRng(9));
    const owned = Array.from(map.values()).flat();
    expect(owned.slice().sort()).toEqual(active.map((i) => i.id).sort());
    expect(new Set(owned).size).toBe(owned.length);
  });

  it("leaves nobody with an empty palette", () => {
    for (let players = 3; players <= 8; players++) {
      const ids = Array.from({ length: players }, (_, i) => `p${i}`);
      const active = chooseActiveIngredients(players, 7, seededRng(players));
      const map = assignIngredients(ids, active, seededRng(players * 3));
      ids.forEach((id) => expect(map.get(id)!.length).toBeGreaterThan(0));
    }
  });

  it("spreads the two Bases across different chefs", () => {
    // The round-robin pointer carries across categories precisely so this holds.
    const ids = ["a", "b", "c", "d"];
    const active = chooseActiveIngredients(4, 7, seededRng(6));
    const map = assignIngredients(ids, active, seededRng(6));
    const baseIds = ingredientsOfCategory(active, IngredientCategory.Base).map((i) => i.id);
    const ownersOfBases = baseIds.map((bid) => ids.find((id) => map.get(id)!.includes(bid))!);
    expect(new Set(ownersOfBases).size).toBe(baseIds.length);
  });

  it("returns an empty map when there are no players", () => {
    expect(assignIngredients([], INGREDIENTS, alwaysZero).size).toBe(0);
  });
});

describe("redistributeOrphanedIngredients", () => {
  const ACTIVE = ["nori", "whiterice", "salmon", "eel"];

  it("hands a departed chef's ingredients to the lightest-loaded survivor", () => {
    // "a" has left; nori and salmon are orphaned.
    const assignments = new Map<string, string[]>([
      ["a", ["nori", "salmon"]],
      ["b", ["whiterice"]],
      ["c", ["eel"]],
    ]);
    const next = redistributeOrphanedIngredients(assignments, ACTIVE, ["b", "c"]);
    expect(next.has("a")).toBe(false);
    // b and c both hold 1, so nori goes to b (first on a tie); c is then lightest for salmon.
    expect(next.get("b")).toEqual(["whiterice", "nori"]);
    expect(next.get("c")).toEqual(["eel", "salmon"]);
  });

  it("keeps every active ingredient owned - this is what stops orders becoming unwinnable", () => {
    const assignments = new Map<string, string[]>([
      ["a", ["nori", "salmon", "eel"]],
      ["b", ["whiterice"]],
    ]);
    const after = redistributeOrphanedIngredients(assignments, ACTIVE, ["b"]);
    expect(Array.from(after.values()).flat().sort()).toEqual(ACTIVE.slice().sort());
  });

  it("is a no-op when everything is already owned", () => {
    const assignments = new Map<string, string[]>([
      ["a", ["nori", "salmon"]],
      ["b", ["whiterice", "eel"]],
    ]);
    const next = redistributeOrphanedIngredients(assignments, ACTIVE, ["a", "b"]);
    expect(next.get("a")).toEqual(["nori", "salmon"]);
    expect(next.get("b")).toEqual(["whiterice", "eel"]);
  });

  it("is safe to run repeatedly (idempotent)", () => {
    const assignments = new Map<string, string[]>([["b", ["whiterice"]]]);
    const once = redistributeOrphanedIngredients(assignments, ACTIVE, ["b", "c"]);
    const twice = redistributeOrphanedIngredients(once, ACTIVE, ["b", "c"]);
    expect(Array.from(twice.entries())).toEqual(Array.from(once.entries()));
  });

  it("gives a brand new player an entry even with nothing to hand them", () => {
    const assignments = new Map<string, string[]>([["a", ["nori", "whiterice", "salmon", "eel"]]]);
    const next = redistributeOrphanedIngredients(assignments, ACTIVE, ["a", "newbie"]);
    expect(next.get("newbie")).toEqual([]);
  });

  it("does not mutate the input map", () => {
    const assignments = new Map<string, string[]>([
      ["a", ["nori"]],
      ["b", ["whiterice"]],
    ]);
    redistributeOrphanedIngredients(assignments, ACTIVE, ["b"]);
    expect(assignments.get("a")).toEqual(["nori"]);
    expect(assignments.get("b")).toEqual(["whiterice"]);
  });

  it("returns an empty map when nobody is left rather than throwing", () => {
    const assignments = new Map<string, string[]>([["a", ["nori"]]]);
    expect(redistributeOrphanedIngredients(assignments, ACTIVE, []).size).toBe(0);
  });
});

describe("compactStations", () => {
  it("closes the gap left by a departure while preserving seating order", () => {
    const map = compactStations([
      { playerId: "a", stationIndex: 0 },
      { playerId: "c", stationIndex: 2 },
      { playerId: "d", stationIndex: 3 },
    ]);
    expect(map.get("a")).toBe(0);
    expect(map.get("c")).toBe(1);
    expect(map.get("d")).toBe(2);
  });

  it("always produces a gapless 0..N-1 ring, which the belt math depends on", () => {
    const map = compactStations([
      { playerId: "x", stationIndex: 9 },
      { playerId: "y", stationIndex: 4 },
      { playerId: "z", stationIndex: 7 },
    ]);
    expect(Array.from(map.values()).sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(map.get("y")).toBe(0);
  });

  it("breaks ties deterministically so joiners cannot shuffle the table", () => {
    const entries = [
      { playerId: "b", stationIndex: -1 },
      { playerId: "a", stationIndex: -1 },
    ];
    expect(Array.from(compactStations(entries).entries())).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("handles an empty table", () => {
    expect(compactStations([]).size).toBe(0);
  });
});

describe("generateRecipe", () => {
  const active = chooseActiveIngredients(5, 10, seededRng(3));

  it("only uses ingredients from the active set, so every order is completable", () => {
    const activeIds = new Set(active.map((i) => i.id));
    for (let s = 1; s < 30; s++) {
      generateRecipe(active, 3, 5, seededRng(s)).forEach((id) =>
        expect(activeIds.has(id)).toBe(true),
      );
    }
  });

  it("respects the requested length window", () => {
    for (let s = 1; s < 30; s++) {
      const recipe = generateRecipe(active, 3, 5, seededRng(s));
      expect(recipe.length).toBeGreaterThanOrEqual(3);
      expect(recipe.length).toBeLessThanOrEqual(5);
    }
  });

  it("emits layers in Base -> Binder -> Filling -> Topping order", () => {
    const rank = {
      [IngredientCategory.Base]: 0,
      [IngredientCategory.Binder]: 1,
      [IngredientCategory.Filling]: 2,
      [IngredientCategory.Topping]: 3,
    };
    for (let s = 1; s < 30; s++) {
      const ranks = generateRecipe(active, 2, 5, seededRng(s)).map(
        (id) => rank[ingredientById(id)!.category],
      );
      expect(ranks).toEqual(ranks.slice().sort((a, b) => a - b));
    }
  });

  it("starts with a base and a binder", () => {
    const recipe = generateRecipe(active, 2, 3, seededRng(12));
    expect(ingredientById(recipe[0])!.category).toBe(IngredientCategory.Base);
    expect(ingredientById(recipe[1])!.category).toBe(IngredientCategory.Binder);
  });

  it("never repeats an ingredient within one recipe", () => {
    for (let s = 1; s < 30; s++) {
      const recipe = generateRecipe(active, 4, 5, seededRng(s));
      expect(new Set(recipe).size).toBe(recipe.length);
    }
  });

  it("includes a filling before reaching for toppings", () => {
    const categories = generateRecipe(active, 4, 4, seededRng(21)).map(
      (id) => ingredientById(id)!.category,
    );
    expect(categories).toContain(IngredientCategory.Filling);
  });

  it("clamps to what the active set can actually supply", () => {
    const tiny: Ingredient[] = [
      { id: "nori", name: "Nori", category: IngredientCategory.Base },
      { id: "whiterice", name: "White Rice", category: IngredientCategory.Binder },
    ];
    expect(generateRecipe(tiny, 4, 5, seededRng(1))).toEqual(["nori", "whiterice"]);
  });
});

describe("dishNameFor", () => {
  it("names signature rolls by their combinations", () => {
    expect(dishNameFor(["nori", "whiterice", "eel", "avocado"])).toBe("Dragon Roll");
    expect(dishNameFor(["nori", "whiterice", "salmon", "avocado"])).toBe("Philadelphia Roll");
    expect(dishNameFor(["nori", "whiterice", "tuna", "spicymayo"])).toBe("Spicy Tuna Roll");
    expect(dishNameFor(["nori", "whiterice", "eel", "eelsauce"])).toBe("Unagi Roll");
    expect(dishNameFor(["nori", "whiterice", "salmon", "tobiko"])).toBe("Sunrise Roll");
    expect(dishNameFor(["nori", "whiterice", "cucumber"])).toBe("Kappa Maki");
  });

  it("falls back to the primary filling, then to Hosomaki when there is none", () => {
    expect(dishNameFor(["nori", "whiterice", "tuna"])).toBe("Tuna Roll");
    expect(dishNameFor(["nori", "whiterice"])).toBe("Hosomaki");
  });
});

describe("sequence helpers", () => {
  it("sameSequence is order sensitive", () => {
    expect(sameSequence(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameSequence(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameSequence(["a"], ["a", "b"])).toBe(false);
  });

  it("sameMultiset ignores order but counts duplicates", () => {
    expect(sameMultiset(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameMultiset(["a", "a"], ["a", "b"])).toBe(false);
    expect(sameMultiset(["a"], ["a", "a"])).toBe(false);
  });

  it("matchingPrefixLength counts the leading run that agrees", () => {
    expect(matchingPrefixLength(["a", "b", "x"], ["a", "b", "c"])).toBe(2);
    expect(matchingPrefixLength(["x"], ["a"])).toBe(0);
    expect(matchingPrefixLength([], ["a"])).toBe(0);
  });
});

describe("scorePlate", () => {
  const recipe = ["nori", "whiterice", "salmon"];
  const base = basePayoutFor(recipe.length);

  it("computes base payout from recipe length", () => {
    expect(base).toBe(PAYOUT_BASE + PAYOUT_PER_LAYER * 3);
  });

  it("pays full price with no strike for an exact match served at the tip threshold", () => {
    const s = scorePlate(recipe, recipe, 0.5);
    expect(s.result).toBe("exact");
    expect(s.payout).toBe(base);
    expect(s.strikeDelta).toBe(0);
  });

  it("adds a full 50% tip for an exact match served instantly", () => {
    const s = scorePlate(recipe, recipe, 1);
    expect(s.result).toBe("exact");
    expect(s.payout).toBe(Math.round(base * 1.5));
  });

  it("pays 40% and a partial strike when the layers are right but misordered", () => {
    const s = scorePlate(["whiterice", "nori", "salmon"], recipe, 1);
    expect(s.result).toBe("wrongOrder");
    expect(s.payout).toBe(Math.round(base * 0.4));
    expect(s.strikeDelta).toBe(STRIKE_FOR_FLAWED);
  });

  it("gives no speed tip for a misordered plate however fast it arrives", () => {
    const fast = scorePlate(["whiterice", "nori", "salmon"], recipe, 1);
    const slow = scorePlate(["whiterice", "nori", "salmon"], recipe, 0);
    expect(fast.payout).toBe(slow.payout);
  });

  it("scales an incomplete plate by how much of the prefix was right", () => {
    const s = scorePlate(["nori", "whiterice"], recipe, 1);
    expect(s.result).toBe("incomplete");
    expect(s.payout).toBe(Math.round(base * 0.5 * (2 / 3)));
    expect(s.strikeDelta).toBe(STRIKE_FOR_FLAWED);
  });

  it("pays nothing for an empty plate but still only a partial strike", () => {
    const s = scorePlate([], recipe, 1);
    expect(s.result).toBe("incomplete");
    expect(s.payout).toBe(0);
    expect(s.strikeDelta).toBe(STRIKE_FOR_FLAWED);
  });

  it("treats a plate with extra layers as incomplete rather than exact", () => {
    expect(scorePlate([...recipe, "tobiko"], recipe, 1).result).toBe("incomplete");
  });
});

describe("speedTip", () => {
  it("pays nothing at or below the halfway threshold", () => {
    expect(speedTip(100, 0.5)).toBe(0);
    expect(speedTip(100, 0.2)).toBe(0);
    expect(speedTip(100, 0)).toBe(0);
  });

  it("ramps linearly to half the base payout at full patience", () => {
    expect(speedTip(100, 0.75)).toBeCloseTo(25);
    expect(speedTip(100, 1)).toBeCloseTo(50);
  });

  it("clamps out-of-range fractions", () => {
    expect(speedTip(100, 5)).toBeCloseTo(50);
    expect(speedTip(100, -5)).toBe(0);
  });
});

describe("nextRequiredIngredient", () => {
  const recipe = ["nori", "whiterice", "salmon"];

  it("reports the next layer for a plate still on track", () => {
    expect(nextRequiredIngredient([], recipe)).toBe("nori");
    expect(nextRequiredIngredient(["nori"], recipe)).toBe("whiterice");
  });

  it("returns undefined for a finished plate", () => {
    expect(nextRequiredIngredient(recipe, recipe)).toBeUndefined();
  });

  it("returns undefined once the plate has gone wrong - there is no recovering", () => {
    expect(nextRequiredIngredient(["whiterice"], recipe)).toBeUndefined();
  });
});

describe("belt geometry", () => {
  it("wraps around the loop in both directions", () => {
    expect(wrapBelt(0, 4)).toBe(0);
    expect(wrapBelt(4, 4)).toBe(0);
    expect(wrapBelt(4.5, 4)).toBeCloseTo(0.5);
    expect(wrapBelt(-0.5, 4)).toBeCloseTo(3.5);
  });

  it("advances by speed x time and loops past the last station", () => {
    expect(advanceBelt(0, 0.5, 1000, 4)).toBeCloseTo(0.5);
    expect(advanceBelt(3.9, 0.5, 1000, 4)).toBeCloseTo(0.4);
  });

  it("is a no-op when there are no stations", () => {
    expect(advanceBelt(2, 1, 1000, 0)).toBe(0);
    expect(wrapBelt(2, 0)).toBe(0);
    expect(stationAt(2, 0)).toBe(0);
  });

  it("maps a position to a station and progress across it", () => {
    expect(stationAt(2.75, 4)).toBe(2);
    expect(progressAcrossStation(2.75, 4)).toBeCloseTo(0.75);
  });

  it("only lets a chef reach plates crossing their own segment", () => {
    expect(isPlateInReach(2.4, 2, 4)).toBe(true);
    expect(isPlateInReach(3.4, 2, 4)).toBe(false);
    expect(isPlateInReach(4.2, 0, 4)).toBe(true); // wrapped back around
  });
});

describe("neighborsOf", () => {
  it("wraps at both ends of the ring", () => {
    expect(neighborsOf(0, 4)).toEqual({ leftIndex: 3, rightIndex: 1 });
    expect(neighborsOf(3, 4)).toEqual({ leftIndex: 2, rightIndex: 0 });
  });

  it("degenerates safely for an empty table", () => {
    expect(neighborsOf(0, 0)).toEqual({ leftIndex: 0, rightIndex: 0 });
  });
});

describe("top chef", () => {
  const stats = (playerId: string, layersAdded: number, platesServed: number, perfect: number) => ({
    playerId,
    layersAdded,
    platesServed,
    perfectPlates: perfect,
  });

  it("weights perfect plates most heavily", () => {
    expect(chefScore(stats("a", 0, 0, 1))).toBe(3);
    expect(chefScore(stats("a", 1, 1, 0))).toBe(2);
  });

  it("crowns the highest contributor", () => {
    expect(findTopChefs([stats("a", 2, 1, 0), stats("b", 1, 1, 2)]).map((t) => t.playerId)).toEqual(
      ["b"],
    );
  });

  it("returns every chef on a tie so the view can share the crown", () => {
    const top = findTopChefs([stats("a", 3, 0, 0), stats("b", 1, 2, 0)]);
    expect(top.map((t) => t.playerId).sort()).toEqual(["a", "b"]);
  });

  it("crowns nobody when nobody did anything", () => {
    expect(findTopChefs([stats("a", 0, 0, 0), stats("b", 0, 0, 0)])).toEqual([]);
    expect(findTopChefs([])).toEqual([]);
  });
});

describe("starRating", () => {
  it("is zero before any round completes, however much is in the till", () => {
    expect(starRating(5000, 0, 0)).toBe(0);
  });

  it("awards five stars for hitting par with a clean sheet", () => {
    expect(starRating(600, 0, 1)).toBe(5);
  });

  it("penalises strikes", () => {
    expect(starRating(600, 3, 1)).toBe(3);
  });

  it("scales par with rounds played, so failing out early cannot look like a good night", () => {
    expect(starRating(600, 0, 3)).toBeLessThan(starRating(600, 0, 1));
  });

  it("never leaves the 0-5 range", () => {
    expect(starRating(999999, 0, 1)).toBe(5);
    expect(starRating(0, 3, 3)).toBe(0);
  });
});
