// The plate renderer: turns a plate's layer stack into a picture of the sushi on it.
//
// Used at three very different sizes - a dot on the presenter's belt ring, a card on a
// phone's conveyor, and the big hero plate on a chef's workstation - so it takes a single
// `size` and scales the whole authoring canvas to match.  All layout maths lives in
// models/plateArt.ts; this file only paints.
import React from "react";
import SushiSyncAssets, { INGREDIENT_IMAGES } from "../assets/Assets";
import {
  BAND_MAX_HEIGHT,
  BAND_WIDTH,
  BAND_X,
  DRIP_DEPTH,
  PLATE_ART_HEIGHT,
  PLATE_ART_WIDTH,
  PlateLayout,
  SEAT_Y,
  layoutStack,
} from "../models/plateArt";
import { ingredientName } from "../models/sushiSyncLogic";

// The authoring canvas is 4:3; `size` means WIDTH, and height follows.
const ASPECT = PLATE_ART_HEIGHT / PLATE_ART_WIDTH;

export interface SushiPlateProps {
  /** Layers in the order the chefs applied them.  Paint order IS array order. */
  stack: string[];
  /** Rendered width in CSS px of the surrounding virtual canvas. Height is derived. */
  size: number;
  /** Hide the dish, e.g. when showing a lone ingredient on a palette button. */
  hideDish?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * One ingredient layer.
 *
 * Every layer is the full authoring canvas with transparency around the ingredient, so the
 * element is just the canvas scaled to `size` and shifted up by its stack offset.  No
 * per-asset registration data, no sprite offsets - the alignment is baked into the art.
 */
const PlateLayerImage = (props: { id: string; offsetY: number; scale: number; z: number }) => {
  const src = INGREDIENT_IMAGES[props.id];
  // An ingredient with no art yet must not blow up the whole plate - skip it and let the
  // rest of the stack render.  The Assets spec is what stops this reaching production.
  if (!src) return null;

  return (
    <img
      src={src}
      alt={ingredientName(props.id)}
      draggable={false}
      data-layer={props.id}
      data-index={props.z - 1}
      style={{
        position: "absolute",
        left: 0,
        bottom: 0,
        width: "100%",
        height: "100%",
        // translate rather than `bottom` so the belt's per-frame movement stays on the
        // compositor instead of triggering layout on every tick.
        transform: `translateY(${-props.offsetY * props.scale}px)`,
        zIndex: props.z,
        pointerEvents: "none",
      }}
    />
  );
};

/**
 * A plate of sushi, layered to show exactly what is on it.
 *
 * Deliberately NOT an observer: it is a pure function of its props, so it re-renders when the
 * stack it was handed changes and stays cheap when a dozen of these ride the belt at 30fps.
 */
export function SushiPlate(props: SushiPlateProps) {
  const { stack, size, hideDish, className, style } = props;
  const scale = size / PLATE_ART_WIDTH;
  const layout: PlateLayout = layoutStack(stack);

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: size,
        height: size * ASPECT,
        // Layers translate upward out of the box; short stacks leave air above the food,
        // which is exactly how a plate on a belt looks.
        overflow: "visible",
        ...style,
      }}
    >
      {hideDish ? null : (
        <img
          src={SushiSyncAssets.images.dish}
          alt=""
          draggable={false}
          data-dish=""
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            width: "100%",
            height: "100%",
            zIndex: 0,
            pointerEvents: "none",
          }}
        />
      )}
      {layout.layers.map((layer) => (
        <PlateLayerImage
          key={`${layer.id}-${layer.index}`}
          id={layer.id}
          offsetY={layer.offsetY}
          scale={scale}
          z={layer.index + 1}
        />
      ))}
    </div>
  );
}

/**
 * A single ingredient with no dish under it, for palette buttons and order-board chips.
 *
 * Crops tightly to the LAYER BAND and scales that region up to fill `size`.  Scaling the
 * whole canvas instead would make a thin ingredient (a nori sheet is 26 of 384 px tall)
 * render as a two-pixel sliver next to its label.  Thin ingredients still LOOK thin here,
 * which is the point - the swatch is the same silhouette the chef will hunt for on a plate.
 */
export function IngredientSwatch(props: { id: string; size: number; className?: string }) {
  const src = INGREDIENT_IMAGES[props.id];
  if (!src) return null;

  // One design px of the band, in CSS px.
  const unit = props.size / BAND_WIDTH;
  const bandTop = SEAT_Y - BAND_MAX_HEIGHT;

  return (
    <span
      className={props.className}
      style={{
        display: "inline-block",
        position: "relative",
        width: props.size,
        height: (BAND_MAX_HEIGHT + DRIP_DEPTH) * unit,
        overflow: "hidden",
        verticalAlign: "middle",
        flex: "0 0 auto",
      }}
    >
      <img
        src={src}
        alt={ingredientName(props.id)}
        draggable={false}
        style={{
          position: "absolute",
          left: -BAND_X * unit,
          top: -bandTop * unit,
          width: PLATE_ART_WIDTH * unit,
          height: PLATE_ART_HEIGHT * unit,
          maxWidth: "none",
          pointerEvents: "none",
        }}
      />
    </span>
  );
}

// ------------------------------------------------------------------------------------------
// Preloading
// ------------------------------------------------------------------------------------------

const preloaded = new Set<string>();

/**
 * Warm the browser's image cache for a round's ingredients.
 *
 * Without this the FIRST plate carrying each ingredient pops in mid-service, which at Rush
 * Hour belt speed is exactly when a chef can least afford a blank layer.  RoundBriefing gives
 * us a ~9 second window that already lists who owns what, so that is where this gets called.
 * Idempotent: repeated calls (round 2, round 3, a rejoin) skip anything already fetched.
 */
export function preloadPlateArt(ingredientIds: string[]): void {
  const sources = [
    SushiSyncAssets.images.dish,
    ...ingredientIds.map((id) => INGREDIENT_IMAGES[id]),
  ];
  for (const src of sources) {
    if (!src || preloaded.has(src)) continue;
    preloaded.add(src);
    const img = new Image();
    img.src = src;
  }
}
