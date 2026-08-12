import { GameVersionEntry, currentVersion } from "libs";
import { ScoreRules } from "./minefieldLogic";

// Version + change history. The version IS the newest entry here, so the two cannot drift
// and no version can be bumped without saying what changed - see libs/config/GameVersion.ts.
export const MINEFIELD_VERSION_HISTORY: GameVersionEntry[] = [
  {
    version: "0.1.0",
    changes: [
      "First playable Minefield: blind explorer, advisors holding fragments of the map.",
      "Irregular mosaic fields generated from a jittered lattice, verified survivable before play.",
      "Standard, multi-step, freeze, motion and invisible mines, plus walls, switches and missing cells.",
      "Four difficulty presets with an advanced panel for every individual knob.",
      "One to four teams racing the same field, with per-team hazard state.",
    ],
  },
];
export const MinefieldVersion = currentVersion(MINEFIELD_VERSION_HISTORY);

// ------------------------------------------------------------------------------------------
// Rules the map generator and the live game must agree on.  These two in particular are
// load-bearing: findSafeRoute() promises every field can be crossed, and it proves that
// using MOTION_FUSE_STEPS.  Change it here and both sides change together.
// ------------------------------------------------------------------------------------------
export const MOTION_FUSE_STEPS = 2;
export const FREEZE_MS = 10000;

/** Failed runs kept for the big screen's ghost trails. Bounded so the checkpoint stays small. */
export const MAX_GHOST_TRAILS = 6;

// ------------------------------------------------------------------------------------------
// Round shape
// ------------------------------------------------------------------------------------------
export const ROUNDS = 3;
export const BRIEFING_MS = 8000;
export const ROUND_MS = 5 * 60 * 1000;
export const ROUND_SCORE_MS = 12000;

export const SCORE_RULES: ScoreRules = {
  goalPoints: 1000,
  timeBonusPerSecond: 5,
  deathPenalty: 150,
};

export const MAX_TEAMS = 4;

/** Saturated and distinct at across-the-room distance - these are read off a television. */
export const TEAM_COLORS = ["#23e0ff", "#ffb020", "#ff5cc8", "#b6ff3a"];
export const TEAM_NAMES = ["Cyan", "Amber", "Magenta", "Lime"];

// ------------------------------------------------------------------------------------------
// Difficulty
//
// Every knob from the design lives here, and a preset is nothing more than a named set of
// them - so the "Advanced" panel on the presenter is editing the same numbers the presets
// write, and there is no second source of truth for what "Veteran" means.
//
// `intelOverlap` is the interesting one: coverage of the field is ALWAYS complete across a
// team's advisors (distributeIntel guarantees it), so this knob only decides how much the
// advisors' fragments overlap - 0 forces them to pool everything they have, 1 gives everyone
// the whole picture.
// ------------------------------------------------------------------------------------------
export interface MinefieldDifficulty {
  name: string;
  blurb: string;
  /** Mines placed on the field. */
  mineCount: number;
  /** How many distinct mine types are drawn from, 1..5 (see HAZARD_ORDER). */
  mineKinds: number;
  /** Cells removed outright - the "missing cells" obstacle. */
  holeCount: number;
  /** Wall + switch pairs. */
  wallCount: number;
  /** Vertex-disjoint safe routes the generator aims for: 1 is a tightrope, 3 is forgiving. */
  viablePaths: number;
  /** 0 = advisors hold disjoint fragments, 1 = every advisor sees the whole field. */
  intelOverlap: number;
}

export const DIFFICULTY_PRESETS: MinefieldDifficulty[] = [
  {
    name: "Recruit",
    blurb: "Standard mines only. Everyone sees everything. Learn to talk to each other.",
    mineCount: 6,
    mineKinds: 1,
    holeCount: 1,
    wallCount: 0,
    viablePaths: 3,
    intelOverlap: 1,
  },
  {
    name: "Sapper",
    blurb: "Multi-step and freeze mines join in, and your intel starts to differ.",
    mineCount: 12,
    mineKinds: 3,
    holeCount: 2,
    wallCount: 1,
    viablePaths: 3,
    intelOverlap: 0.5,
  },
  {
    name: "Veteran",
    blurb: "Motion mines. Walls to unlock. You each hold a quarter of the picture.",
    mineCount: 18,
    mineKinds: 4,
    holeCount: 3,
    wallCount: 2,
    viablePaths: 2,
    intelOverlap: 0.25,
  },
  {
    name: "Nightmare",
    blurb: "Every mine type, mines nobody can see, and one route through. Good luck.",
    mineCount: 26,
    mineKinds: 5,
    holeCount: 4,
    wallCount: 3,
    viablePaths: 1,
    intelOverlap: 0,
  },
];

export const DEFAULT_DIFFICULTY_INDEX = 1;
