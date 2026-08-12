// Asset manifest.  Import every image/sound here and reference them through
// this object so webpack bundles them and games never hard-code asset paths.
import logo from "./images/Logo.png";
import dish from "./images/dish.png";
import ding from "./sounds/ding.wav";
import hello from "./sounds/hello.mp3";
import response from "./sounds/response.mp3";
import score from "./sounds/score.wav";
import winner from "./sounds/winner.wav";

// Ingredient layer art.  One PNG per ingredient, all sharing the authoring canvas described
// in ASSETS.md, so the renderer can stack them with no per-asset offset metadata.
//
// These are STATIC imports on purpose: CRA/webpack cannot resolve `import(\`./x/${id}.png\`)`
// from a variable, and spelling them out means a missing file is a compile error rather than
// a broken image at Rush Hour speed.  The spec asserts this map covers every ingredient.
import nori from "./images/ingredients/nori.png";
import soypaper from "./images/ingredients/soypaper.png";
import whiterice from "./images/ingredients/whiterice.png";
import brownrice from "./images/ingredients/brownrice.png";
import salmon from "./images/ingredients/salmon.png";
import tuna from "./images/ingredients/tuna.png";
import eel from "./images/ingredients/eel.png";
import cucumber from "./images/ingredients/cucumber.png";
import avocado from "./images/ingredients/avocado.png";
import tobiko from "./images/ingredients/tobiko.png";
import spicymayo from "./images/ingredients/spicymayo.png";
import eelsauce from "./images/ingredients/eelsauce.png";
import sesame from "./images/ingredients/sesame.png";

/** Ingredient id -> layer PNG.  Keys match `Ingredient.id` in sushiSyncLogic.ts exactly. */
export const INGREDIENT_IMAGES: Readonly<Record<string, string>> = {
  nori,
  soypaper,
  whiterice,
  brownrice,
  salmon,
  tuna,
  eel,
  cucumber,
  avocado,
  tobiko,
  spicymayo,
  eelsauce,
  sesame,
};

const SushiSyncAssets = {
  images: {
    logo,
    dish, // the empty plate every stack is built on
    ingredients: INGREDIENT_IMAGES,
  },
  sounds: {
    ding, // short alert - used for the round-countdown warning and color changes
    hello, // played when a player joins
    response, // played when a player sends a message
    score, // played when a player's score increases
    winner, // played when the winner is announced at game over
  },
};

export default SushiSyncAssets;
