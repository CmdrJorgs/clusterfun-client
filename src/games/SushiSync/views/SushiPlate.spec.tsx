import React from "react";
import { render, screen } from "@testing-library/react";
import { IngredientSwatch, SushiPlate, preloadPlateArt } from "./SushiPlate";
import { INGREDIENT_IMAGES } from "../assets/Assets";
import { INGREDIENTS, ingredientName } from "../models/sushiSyncLogic";
import { MAX_STACK_HEIGHT } from "../models/GameSettings";

/** The ingredient layers, in DOM order - which is paint order. */
const layersIn = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLImageElement>("img[data-layer]"));

const liftOf = (el: HTMLElement) =>
  Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)![1]);

describe("ingredient art manifest", () => {
  it("has art for every ingredient the game can deal out", () => {
    // The guard that keeps art and rules from drifting: add an ingredient to INGREDIENTS
    // without an image and a plate would silently render a missing layer mid-service.
    const missing = INGREDIENTS.filter((i) => !INGREDIENT_IMAGES[i.id]).map((i) => i.id);
    expect(missing).toEqual([]);
  });

  it("has no art for ingredients the game does not know about", () => {
    const known = new Set(INGREDIENTS.map((i) => i.id));
    const orphans = Object.keys(INGREDIENT_IMAGES).filter((id) => !known.has(id));
    expect(orphans).toEqual([]);
  });
});

describe("SushiPlate", () => {
  it("renders an empty plate as just the dish", () => {
    const { container } = render(<SushiPlate stack={[]} size={200} />);
    expect(layersIn(container)).toHaveLength(0);
    expect(container.querySelectorAll("img[data-dish]")).toHaveLength(1);
  });

  it("renders one image per layer", () => {
    const { container } = render(<SushiPlate stack={["nori", "whiterice", "salmon"]} size={200} />);
    expect(layersIn(container)).toHaveLength(3);
  });

  it("paints layers in the order they were applied, not canonical layer order", () => {
    // The load-bearing behaviour: a flawed plate has to LOOK flawed.
    const { container } = render(<SushiPlate stack={["tobiko", "nori"]} size={200} />);
    expect(layersIn(container).map((el) => el.dataset.layer)).toEqual(["tobiko", "nori"]);
  });

  it("stacks z-index so later layers sit above earlier ones and above the dish", () => {
    const { container } = render(<SushiPlate stack={["nori", "whiterice", "eel"]} size={200} />);
    const zs = layersIn(container).map((el) => Number(el.style.zIndex));
    expect(zs).toEqual([1, 2, 3]);

    const dish = container.querySelector<HTMLImageElement>("img[data-dish]")!;
    expect(Math.min(...zs)).toBeGreaterThan(Number(dish.style.zIndex));
  });

  it("lifts each layer further than the one below it", () => {
    const { container } = render(<SushiPlate stack={["nori", "whiterice", "salmon"]} size={512} />);
    const lifts = layersIn(container).map(liftOf);
    // translateY is negative (upward), so each successive layer's value is strictly smaller.
    expect(Math.abs(lifts[0])).toBe(0);
    expect(lifts[1]).toBeLessThan(lifts[0]);
    expect(lifts[2]).toBeLessThan(lifts[1]);
  });

  it("scales layer offsets with the requested size", () => {
    const liftAt = (size: number) => {
      const { container, unmount } = render(
        <SushiPlate stack={["whiterice", "salmon"]} size={size} />,
      );
      const value = liftOf(layersIn(container)[1]);
      unmount();
      return value;
    };
    // Half the width means half the lift - the whole canvas scales together.
    expect(liftAt(256)).toBeCloseTo(liftAt(512) / 2, 5);
  });

  it("renders duplicate ingredients as distinct layers", () => {
    const tower = new Array(MAX_STACK_HEIGHT).fill("whiterice");
    const { container } = render(<SushiPlate stack={tower} size={200} />);
    expect(layersIn(container)).toHaveLength(MAX_STACK_HEIGHT);
  });

  it("can omit the dish", () => {
    const { container } = render(<SushiPlate stack={["nori"]} size={200} hideDish />);
    expect(container.querySelectorAll("img[data-dish]")).toHaveLength(0);
    expect(layersIn(container)).toHaveLength(1);
  });

  it("skips an unknown ingredient instead of breaking the rest of the plate", () => {
    const { container } = render(
      <SushiPlate stack={["nori", "wasabi-not-yet-drawn", "salmon"]} size={200} />,
    );
    expect(layersIn(container).map((el) => el.dataset.layer)).toEqual(["nori", "salmon"]);
  });

  it("keeps the frame at the authoring aspect ratio", () => {
    const { container } = render(<SushiPlate stack={[]} size={512} />);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.width).toBe("512px");
    expect(frame.style.height).toBe("384px");
  });

  it("gives every layer an accessible name so the stack is readable to assistive tech", () => {
    const { container } = render(<SushiPlate stack={["nori", "tobiko"]} size={200} />);
    expect(layersIn(container).map((el) => el.getAttribute("alt"))).toEqual([
      ingredientName("nori"),
      ingredientName("tobiko"),
    ]);
  });
});

describe("IngredientSwatch", () => {
  it("renders the ingredient art with an accessible name", () => {
    render(<IngredientSwatch id="tobiko" size={80} />);
    expect(screen.getByRole("img")).toHaveAttribute("alt", ingredientName("tobiko"));
  });

  it("renders nothing for an unknown ingredient", () => {
    const { container } = render(<IngredientSwatch id="nope" size={80} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("preloadPlateArt", () => {
  it("fetches each ingredient once and tolerates repeat calls", () => {
    // Round 2 and 3 re-preload an overlapping set; a rejoining phone preloads again. None of
    // that should re-request art the browser already has.
    expect(() => {
      preloadPlateArt(["nori", "whiterice"]);
      preloadPlateArt(["nori", "whiterice", "salmon"]);
      preloadPlateArt([]);
      preloadPlateArt(["unknown-ingredient"]);
    }).not.toThrow();
  });
});
