import { runInAction } from "mobx";
import { ISessionHelper, instantiateGame, getPresenterTypeHelper, PresenterGameState } from "libs";
import { MockTelemetryLogger } from "libs/telemetry/MockTelemetryLogger";
import {
  MinefieldGameState,
  MinefieldPlayer,
  MinefieldPresenterModel,
  getMinefieldPresenterTypeHelper,
} from "./PresenterModel";
import { neighborOptions } from "./minefieldLogic";
import { DIFFICULTY_PRESETS, ROUND_MS } from "./GameSettings";

// -------------------------------------------------------------------
// Drives the real presenter through its real handlers.  reconstitute() is deliberately
// skipped (it starts the ticker and wires the relay); the handlers under test only touch the
// session, so a recording stub is enough.
// -------------------------------------------------------------------
interface SentMessage {
  route: string;
  receiverId: string;
  message: any;
}

function makeFakeSession(sent: SentMessage[]): ISessionHelper {
  const fake: Partial<ISessionHelper> = {
    roomId: "ROOM1",
    personalId: "PRESENTER",
    personalSecret: "secret",
    sendMessage: (endpoint, receiverId, message) => {
      sent.push({ route: (endpoint as any).route, receiverId, message });
    },
    listen: (() => ({ unsubscribe: () => {} })) as any,
    listenPresenter: (() => ({ unsubscribe: () => {} })) as any,
    request: (() => Promise.resolve(undefined)) as any,
    requestPresenter: (() => Promise.resolve(undefined)) as any,
    sendMessageToPresenter: () => {},
    addClosedListener: () => {},
    removeClosedListener: () => {},
    onError: () => {},
    serverCall: (() => Promise.resolve(undefined)) as any,
    stats: { sentCount: 0, bytesSent: 0, recievedCount: 0, bytesRecieved: 0 },
  };
  return fake as ISessionHelper;
}

function makeModel() {
  const sent: SentMessage[] = [];
  const session = makeFakeSession(sent);
  const logger = new MockTelemetryLogger("test");
  const storage = { set: () => {}, get: () => null, remove: () => {}, clear: () => {} };
  const model = new MinefieldPresenterModel(session, logger, storage);
  return { model, sent };
}

function addPlayer(model: MinefieldPresenterModel, id: string, name: string): MinefieldPlayer {
  const player = model.createFreshPlayerEntry(name, id);
  player.isConnected = true;
  player.connectionId = `conn-${id}`;
  runInAction(() => model.players.push(player));
  return player;
}

/** A model with `count` players, a generated field, and the round actually running. */
function runningGame(count = 4, teamCount = 1) {
  const { model, sent } = makeModel();
  for (let i = 0; i < count; i++) addPlayer(model, `P${i}`, `Player ${i}`);
  runInAction(() => (model.teamCount = teamCount));
  model.prepareFreshGame();
  model.prepareFreshRound();
  model.startNextRound();
  runInAction(() => {
    model.gameState = MinefieldGameState.Running;
    model.setStageEndTime(ROUND_MS);
  });
  sent.length = 0;
  return { model, sent };
}

/** The first legal step out of the start cell. Hazards are never placed next to the start. */
function firstLegalMove(model: MinefieldPresenterModel, teamId = 0): number {
  const team = model.teamById(teamId)!;
  const option = neighborOptions(model.currentMap!, team.run).find((o) => !o.walled);
  return option!.cellId;
}

describe("MinefieldPresenterModel - setup", () => {
  it("starts in Gathering with one team and a preset chosen", () => {
    const { model } = makeModel();
    expect(model.gameState).toBe(PresenterGameState.Gathering);
    expect(model.teams).toHaveLength(1);
    expect(model.difficulty.name).toBe(DIFFICULTY_PRESETS[model.difficultyIndex].name);
  });

  it("switches presets wholesale", () => {
    const { model } = makeModel();
    model.setDifficultyIndex(3);
    expect(model.difficulty.name).toBe("Nightmare");
    expect(model.difficulty.mineKinds).toBe(5);
  });

  it("turning a knob makes the difficulty Custom rather than silently editing a preset", () => {
    const { model } = makeModel();
    model.setDifficultyIndex(0);
    model.updateDifficulty({ mineCount: 33 });
    expect(model.difficulty.name).toBe("Custom");
    expect(model.difficulty.mineCount).toBe(33);
    expect(model.difficultyIndex).toBe(-1);
    // The shared preset constant is untouched - this was a copy all along.
    expect(DIFFICULTY_PRESETS[0].mineCount).not.toBe(33);
  });

  it("balances players across the requested number of teams", () => {
    const { model } = makeModel();
    for (let i = 0; i < 6; i++) addPlayer(model, `P${i}`, `Player ${i}`);
    model.setTeamCount(3);
    expect(model.teams).toHaveLength(3);
    expect([0, 1, 2].map((t) => model.teamMembers(t).length)).toEqual([2, 2, 2]);
  });

  it("caps the team count at the supported maximum", () => {
    const { model } = makeModel();
    model.setTeamCount(99);
    expect(model.teams).toHaveLength(4);
  });
});

describe("MinefieldPresenterModel - round preparation", () => {
  it("generates a survivable field and puts one explorer in each team's boots", () => {
    const { model } = runningGame(6, 2);
    expect(model.currentMap).not.toBeNull();
    for (const team of model.teams) {
      expect(team.explorerId).not.toBe("");
      expect(model.teamMembers(team.teamId).map((p) => p.playerId)).toContain(team.explorerId);
      expect(team.run.cell).toBe(model.currentMap!.startCell);
    }
  });

  it("deals every advisor a fragment, and the team between them holds all of it", () => {
    const { model } = runningGame(5, 1);
    const team = model.teams[0];
    const advisors = model.advisorsOf(team);
    expect(advisors.length).toBe(4);

    const dealt = advisors.flatMap((a) => team.intel[a.playerId] ?? []);
    const everyVisible = model
      .currentMap!.hazards.filter((h) => h.kind !== "invisible")
      .map((h) => `h:${h.id}`)
      .concat(model.currentMap!.walls.map((w) => `w:${w.id}`));
    expect(new Set(dealt)).toEqual(new Set(everyVisible));
  });

  it("passes the boots around rather than landing on the same player twice", () => {
    const { model } = runningGame(3, 1);
    const first = model.teams[0].explorerId;
    model.prepareFreshRound();
    const second = model.teams[0].explorerId;
    model.prepareFreshRound();
    const third = model.teams[0].explorerId;
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("honours a host's pick for one round, then goes back to rotating", () => {
    const { model } = runningGame(3, 1);
    model.setExplorer(0, "P2");
    expect(model.teams[0].explorerId).toBe("P2");
    model.prepareFreshRound();
    expect(model.teams[0].explorerId).toBe("P2");
    expect(model.teams[0].explorerPinned).toBe(false);
  });
});

describe("MinefieldPresenterModel - what each role is told", () => {
  it("never sends the explorer a single hazard", () => {
    const { model } = runningGame(4, 1);
    const team = model.teams[0];
    const response = model.handleOnboardClient(team.explorerId);

    expect(response.role).toBe("explorer");
    expect(response.local).toBeDefined();
    // The whole game rests on this: there is no field on the wire at all, so there is
    // nothing for a curious explorer to read out of devtools.
    expect(response.field).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("standard");
  });

  it("sends an advisor only the hazards they were dealt", () => {
    const { model } = runningGame(4, 1);
    const team = model.teams[0];
    const advisor = model.advisorsOf(team)[0];
    const response = model.handleOnboardClient(advisor.playerId);

    expect(response.role).toBe("advisor");
    expect(response.field).toBeDefined();
    const owned = new Set(team.intel[advisor.playerId]);
    for (const hazard of response.field!.hazards) {
      expect(owned.has(`h:${hazard.id}`)).toBe(true);
    }
    for (const wall of response.field!.walls) {
      expect(owned.has(`w:${wall.id}`)).toBe(true);
    }
  });

  it("never tells any advisor about an invisible mine", () => {
    const { model } = makeModel();
    for (let i = 0; i < 4; i++) addPlayer(model, `P${i}`, `Player ${i}`);
    model.setDifficultyIndex(3); // Nightmare - all five mine types
    model.prepareFreshGame();
    model.prepareFreshRound();

    const team = model.teams[0];
    for (const advisor of model.advisorsOf(team)) {
      const field = model.handleOnboardClient(advisor.playerId).field!;
      expect(field.hazards.some((h) => h.kind === "invisible")).toBe(false);
    }
  });

  it("gives the explorer the cells they can reach, and the advisors the same list", () => {
    const { model } = runningGame(3, 1);
    const team = model.teams[0];
    const explorerView = model.handleOnboardClient(team.explorerId).local!;
    const advisorView = model.handleOnboardClient(model.advisorsOf(team)[0].playerId).status!;
    expect(explorerView.options.map((o) => o.id).sort()).toEqual(
      advisorView.options.slice().sort(),
    );
  });

  it("declassifies the whole field once the round is over", () => {
    const { model } = runningGame(3, 1);
    const advisor = model.advisorsOf(model.teams[0])[0];
    const during = model.handleOnboardClient(advisor.playerId).field!;

    model.skipRound();
    const after = model.handleOnboardClient(advisor.playerId).field!;

    expect(model.revealed).toBe(true);
    expect(after.hazards.length).toBe(model.currentMap!.hazards.length);
    expect(after.hazards.length).toBeGreaterThanOrEqual(during.hazards.length);
  });
});

describe("MinefieldPresenterModel - moving", () => {
  it("takes a step from the explorer and moves the team", () => {
    const { model, sent } = runningGame(3, 1);
    const team = model.teams[0];
    const target = firstLegalMove(model);

    const response = model.handleMove(team.explorerId, { toCellId: target, stepSerial: 0 });

    expect(response.accepted).toBe(true);
    expect(response.outcome).toBe("moved");
    expect(team.run.cell).toBe(target);
    expect(response.local!.here.id).toBe(target);
    // Advisors on this team are told; the explorer already has it in the response.
    const pushes = sent.filter((s) => s.route.includes("team-update"));
    expect(pushes.length).toBe(model.advisorsOf(team).length);
  });

  it("refuses a move from anybody who is not the explorer", () => {
    const { model } = runningGame(3, 1);
    const team = model.teams[0];
    const advisor = model.advisorsOf(team)[0];
    const target = firstLegalMove(model);

    expect(model.handleMove(advisor.playerId, { toCellId: target, stepSerial: 0 }).accepted).toBe(
      false,
    );
    expect(team.run.cell).toBe(model.currentMap!.startCell);
  });

  it("refuses a move while the round is not running", () => {
    const { model } = runningGame(3, 1);
    const team = model.teams[0];
    const target = firstLegalMove(model);
    runInAction(() => (model.gameState = MinefieldGameState.Briefing));
    expect(model.handleMove(team.explorerId, { toCellId: target, stepSerial: 0 }).accepted).toBe(
      false,
    );
  });

  it("refuses a cell that is not adjacent", () => {
    const { model } = runningGame(3, 1);
    const team = model.teams[0];
    const far = model.currentMap!.goalCell;
    const response = model.handleMove(team.explorerId, { toCellId: far, stepSerial: 0 });
    expect(response.accepted).toBe(false);
    expect(response.outcome).toBe("blocked");
  });

  it("answers a retried move with current state instead of walking it twice", () => {
    // On this game's rules a replayed step is the difference between life and death, so the
    // stale serial has to be recognised rather than obeyed.
    const { model } = runningGame(3, 1);
    const team = model.teams[0];
    const first = firstLegalMove(model);
    model.handleMove(team.explorerId, { toCellId: first, stepSerial: 0 });
    const landedOn = team.run.cell;
    const steps = team.run.steps;

    const retry = model.handleMove(team.explorerId, { toCellId: first, stepSerial: 0 });

    expect(retry.accepted).toBe(true);
    expect(team.run.cell).toBe(landedOn);
    expect(team.run.steps).toBe(steps);
  });
});

describe("MinefieldPresenterModel - the round", () => {
  it("moves Briefing -> Running -> RoundScore as the clock runs out", () => {
    const { model } = makeModel();
    for (let i = 0; i < 3; i++) addPlayer(model, `P${i}`, `Player ${i}`);
    model.prepareFreshGame();
    model.prepareFreshRound();
    model.startNextRound();
    expect(model.gameState).toBe(MinefieldGameState.Briefing);

    runInAction(() => (model.timeOfStageEnd = model.gameTime_ms - 1));
    model.handleTick();
    expect(model.gameState).toBe(MinefieldGameState.Running);

    runInAction(() => (model.timeOfStageEnd = model.gameTime_ms - 1));
    model.handleTick();
    expect(model.gameState).toBe(MinefieldGameState.RoundScore);
    expect(model.revealed).toBe(true);
  });

  it("ends the round early once every team is home rather than playing out the clock", () => {
    const { model } = runningGame(3, 1);
    runInAction(() => (model.teams[0].run = { ...model.teams[0].run, reachedGoal: true }));
    model.handleTick();
    expect(model.gameState).toBe(MinefieldGameState.RoundScore);
  });

  it("plays the configured number of rounds and then ends", () => {
    const { model } = runningGame(3, 1);
    runInAction(() => (model.currentRound = model.totalRounds));
    model.skipRound();
    runInAction(() => (model.timeOfStageEnd = model.gameTime_ms - 1));
    model.handleTick();
    expect(model.gameState).toBe("GameOver");
  });

  it("starts a new field for the next round", () => {
    const { model } = runningGame(3, 1);
    const firstSeed = model.currentMap!.seed;
    model.skipRound();
    runInAction(() => (model.timeOfStageEnd = model.gameTime_ms - 1));
    model.handleTick();
    expect(model.gameState).toBe(MinefieldGameState.Briefing);
    expect(model.currentMap!.seed).not.toBe(firstSeed);
    expect(model.revealed).toBe(false);
  });
});

describe("MinefieldPresenterModel - reconnect", () => {
  it("hands a returning advisor a share, so nobody comes back to an empty field", () => {
    const { model } = runningGame(4, 1);
    const team = model.teams[0];
    const advisor = model.advisorsOf(team)[0];
    runInAction(() => {
      const rest = { ...team.intel };
      delete rest[advisor.playerId];
      team.intel = rest;
    });

    model.handleOnboardClient(advisor.playerId);
    expect(model.handleOnboardClient(advisor.playerId).field!.hazards).toHaveLength(0);

    (model as any).onPlayerReturned(advisor, { matchedBy: "id" });

    expect(team.intel[advisor.playerId]).toBeDefined();
    expect(model.roleOf(advisor)).toBe("advisor");
  });

  it("leaves a returning explorer in their own boots - ids are stable, nothing to migrate", () => {
    const { model } = runningGame(3, 1);
    const team = model.teams[0];
    const explorer = model.explorerOf(team)!;
    const target = firstLegalMove(model);
    model.handleMove(explorer.playerId, { toCellId: target, stepSerial: 0 });

    (model as any).onPlayerReturned(explorer, { matchedBy: "name" });

    expect(team.explorerId).toBe(explorer.playerId);
    expect(team.run.cell).toBe(target);
    expect(model.roleOf(explorer)).toBe("explorer");
  });
});

describe("MinefieldPresenterModel - checkpoint", () => {
  it("round-trips the field, the teams and a run in progress through the real serializer", () => {
    const sent: SentMessage[] = [];
    const session = makeFakeSession(sent);
    const logger = new MockTelemetryLogger("test");
    const storage = { set: () => {}, get: () => null, remove: () => {}, clear: () => {} } as any;

    const typeHelper = getPresenterTypeHelper(
      getMinefieldPresenterTypeHelper(session, { logger, storage } as any),
    );
    const model = instantiateGame(
      typeHelper,
      logger,
      storage,
    ) as unknown as MinefieldPresenterModel;

    runInAction(() => {
      for (let i = 0; i < 3; i++) {
        const p = model.createFreshPlayerEntry(`Player ${i}`, `P${i}`);
        p.isConnected = true;
        model.players.push(p);
      }
    });
    model.prepareFreshGame();
    model.prepareFreshRound();
    runInAction(() => {
      model.gameState = MinefieldGameState.Running;
      model.setStageEndTime(ROUND_MS);
      model.teams[0].score = 640;
    });
    const team = model.teams[0];
    model.handleMove(team.explorerId, { toCellId: firstLegalMove(model), stepSerial: 0 });

    const serializer = model.serializer!;
    let json = "";
    expect(() => {
      json = serializer.stringify(model);
    }).not.toThrow();

    const back = serializer.parse<MinefieldPresenterModel>(json);

    // A refreshed presenter has to come back to the SAME minefield, not a new one - the
    // advisors' memory of it is the only copy that matters and it is in their heads.
    expect(back.currentMap!.seed).toBe(model.currentMap!.seed);
    expect(back.currentMap!.cells.length).toBe(model.currentMap!.cells.length);
    expect(back.currentMap!.hazards.length).toBe(model.currentMap!.hazards.length);
    expect(back.teams).toHaveLength(1);
    expect(back.teams[0].score).toBe(640);
    expect(back.teams[0].explorerId).toBe(team.explorerId);
    expect(back.teams[0].run.cell).toBe(team.run.cell);
    expect(back.teams[0].run.path).toEqual(team.run.path);
    expect(back.teams[0].intel).toEqual(team.intel);
    expect(back.players).toHaveLength(3);
  });
});
