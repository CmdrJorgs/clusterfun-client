import { runInAction } from "mobx";
import { ISessionHelper, instantiateGame, getPresenterTypeHelper } from "libs";
import { MockTelemetryLogger } from "libs/telemetry/MockTelemetryLogger";
import { PresenterGameState, GeneralGameState } from "libs";
import {
  SushiSyncGameState,
  SushiSyncOrder,
  SushiSyncPlayer,
  SushiSyncPresenterModel,
  getSushiSyncPresenterTypeHelper,
} from "./PresenterModel";
import { STRIKES_TO_FAIL, STRIKE_FOR_FLAWED, STRIKE_FOR_TIMEOUT } from "./GameSettings";
import { basePayoutFor } from "./sushiSyncLogic";

// -------------------------------------------------------------------
// A light integration test that drives the real presenter through its message handlers.
// We deliberately skip reconstitute() (it starts a ticker and wires the relay listeners);
// the handlers under test do not depend on it.  The only collaborator they touch is the
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

const NOOP_STORAGE = { set: () => {}, get: () => null, remove: () => {}, clear: () => {} } as any;

function makeModel() {
  const sent: SentMessage[] = [];
  const model = new SushiSyncPresenterModel(
    makeFakeSession(sent),
    new MockTelemetryLogger("test"),
    NOOP_STORAGE,
  );
  return { model, sent };
}

function addPlayer(model: SushiSyncPresenterModel, id: string, name: string): SushiSyncPlayer {
  const p = model.createFreshPlayerEntry(name, id);
  runInAction(() => model.players.push(p));
  return p;
}

/** Three chefs, seated, ingredients dealt, clock running - the common starting point. */
function makeSeatedGame(playerCount = 3) {
  const { model, sent } = makeModel();
  const names = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank", "Gus", "Hana"];
  const players = names.slice(0, playerCount).map((name, i) => addPlayer(model, `p${i}`, name));
  model.beginSeating();
  return { model, sent, players };
}

function startPlaying(model: SushiSyncPresenterModel) {
  runInAction(() => {
    model.currentRound = 1;
  });
  model.prepareFreshRound();
  runInAction(() => {
    model.gameState = SushiSyncGameState.Playing;
    model.timeOfStageEnd = Number.MAX_SAFE_INTEGER;
    model.gameTime_ms = 1000;
  });
}

/** Run one tick at a given game time. */
function tickAt(model: SushiSyncPresenterModel, gameTime: number) {
  runInAction(() => {
    model.gameTime_ms = gameTime;
  });
  model.handleTick();
}

/** Spawn exactly one order by ticking once past the spawn timer. */
function spawnOneOrder(model: SushiSyncPresenterModel): SushiSyncOrder {
  tickAt(model, model.gameTime_ms + 100);
  expect(model.orders.length).toBeGreaterThan(0);
  return model.orders[0];
}

/** Give a chef every layer an order needs, so a test can build a plate end to end. */
function grantRecipe(player: SushiSyncPlayer, order: SushiSyncOrder) {
  runInAction(() => {
    player.ingredientIds = order.recipe.slice();
  });
}

describe("SushiSyncPresenterModel - seating", () => {
  it("assigns every chef a unique gapless station", () => {
    const { model, players } = makeSeatedGame(5);
    const seats = players.map((p) => p.stationIndex).sort((a, b) => a - b);
    expect(seats).toEqual([0, 1, 2, 3, 4]);
    expect(model.gameState).toBe(SushiSyncGameState.Seating);
    expect(model.stationCount).toBe(5);
  });

  it("swaps seats with a neighbor and reports the new neighbors", () => {
    const { model, players } = makeSeatedGame(3);
    const alice = players[0];
    const before = alice.stationIndex;

    const response = model.handleSwapStation(alice.playerId, { direction: "right" });

    expect(response.accepted).toBe(true);
    expect(alice.stationIndex).not.toBe(before);
    // Still a valid gapless ring afterwards.
    expect(players.map((p) => p.stationIndex).sort()).toEqual([0, 1, 2]);
  });

  it("refuses a swap once the shift has started", () => {
    const { model, players } = makeSeatedGame(3);
    startPlaying(model);
    const before = players[0].stationIndex;

    expect(model.handleSwapStation(players[0].playerId, { direction: "left" }).accepted).toBe(
      false,
    );
    expect(players[0].stationIndex).toBe(before);
  });

  it("does not let a mid-round joiner renumber the belt under everyone's feet", () => {
    const { model } = makeSeatedGame(3);
    startPlaying(model);
    expect(model.allowedJoinStates).not.toContain(SushiSyncGameState.Playing);
    expect(model.allowedJoinStates).toContain(PresenterGameState.Gathering);
    expect(model.allowedJoinStates).toContain(SushiSyncGameState.Seating);
  });
});

describe("SushiSyncPresenterModel - ingredient dealing", () => {
  it("deals every active ingredient to exactly one chef, and nobody goes empty-handed", () => {
    const { model, players } = makeSeatedGame(4);
    startPlaying(model);

    const dealt = players.flatMap((p) => p.ingredientIds);
    expect(new Set(dealt).size).toBe(dealt.length);
    expect(dealt.slice().sort()).toEqual(model.activeIngredientIds.slice().sort());
    players.forEach((p) => expect(p.ingredientIds.length).toBeGreaterThan(0));
  });

  it("reshuffles the deal between rounds", () => {
    const { model, players } = makeSeatedGame(4);
    startPlaying(model);
    const before = players.map((p) => p.ingredientIds.join(","));

    model.startNextRound();
    const after = players.map((p) => p.ingredientIds.join(","));

    // The pool also grows, so at minimum the total dealt should differ.
    expect(after.join("|")).not.toBe(before.join("|"));
  });
});

describe("SushiSyncPresenterModel - pulling plates", () => {
  it("gives a plate to the chef whose segment it is crossing", () => {
    const { model, players } = makeSeatedGame(3);
    startPlaying(model);
    const order = spawnOneOrder(model);
    const plate = model.plates.find((p) => p.orderId === order.id)!;
    const atStationZero = players.find((p) => p.stationIndex === 0)!;

    const response = model.handlePullPlate(atStationZero.playerId, { plateId: plate.id });

    expect(response.accepted).toBe(true);
    expect(response.plate!.table).toBe(order.tableNumber);
    expect(plate.heldBy).toBe(atStationZero.playerId);
    expect(atStationZero.heldPlateId).toBe(plate.id);
  });

  it("rejects a chef reaching for a plate that is not in their segment", () => {
    const { model, players } = makeSeatedGame(3);
    startPlaying(model);
    const order = spawnOneOrder(model);
    const plate = model.plates.find((p) => p.orderId === order.id)!;
    const elsewhere = players.find((p) => p.stationIndex === 1)!;

    const response = model.handlePullPlate(elsewhere.playerId, { plateId: plate.id });

    expect(response.accepted).toBe(false);
    expect(response.reason).toBe("outofreach");
    expect(plate.heldBy).toBe("");
  });

  it("arbitrates two chefs grabbing the same plate in the same frame", () => {
    // This is exactly why PullPlate is request/response rather than fire-and-forget.
    const { model, players } = makeSeatedGame(3);
    startPlaying(model);
    spawnOneOrder(model);
    const plate = model.plates[0];
    const first = players.find((p) => p.stationIndex === 0)!;
    const second = players.find((p) => p.stationIndex === 1)!;
    // Put them both at station 0 so reach is not the thing being tested.
    runInAction(() => (second.stationIndex = 0));

    expect(model.handlePullPlate(first.playerId, { plateId: plate.id }).accepted).toBe(true);
    const loser = model.handlePullPlate(second.playerId, { plateId: plate.id });

    expect(loser.accepted).toBe(false);
    expect(loser.reason).toBe("taken");
    expect(second.heldPlateId).toBe("");
  });

  it("refuses a second plate while the bench is occupied", () => {
    const { model, players } = makeSeatedGame(3);
    startPlaying(model);
    spawnOneOrder(model);
    const chef = players.find((p) => p.stationIndex === 0)!;
    model.handlePullPlate(chef.playerId, { plateId: model.plates[0].id });

    // Spawn a second plate and drop it into the same segment.
    tickAt(model, model.gameTime_ms + 20000);
    const other = model.plates.find((p) => p.heldBy === "")!;
    runInAction(() => (other.beltPos = 0.5));

    const response = model.handlePullPlate(chef.playerId, { plateId: other.id });
    expect(response.accepted).toBe(false);
    expect(response.reason).toBe("busy");
  });

  it("refuses pulls outside of play", () => {
    const { model, players } = makeSeatedGame(3);
    expect(model.handlePullPlate(players[0].playerId, { plateId: "nope" }).reason).toBe(
      "notplaying",
    );
  });
});

describe("SushiSyncPresenterModel - building plates", () => {
  function setup() {
    const { model, players } = makeSeatedGame(3);
    startPlaying(model);
    const order = spawnOneOrder(model);
    const plate = model.plates.find((p) => p.orderId === order.id)!;
    const chef = players.find((p) => p.stationIndex === 0)!;
    grantRecipe(chef, order);
    model.handlePullPlate(chef.playerId, { plateId: plate.id });
    return { model, players, order, plate, chef };
  }

  it("applies an owned ingredient and echoes the authoritative stack", () => {
    const { model, order, chef, plate } = setup();
    const response = model.handleAddIngredient(chef.playerId, { ingredientId: order.recipe[0] });

    expect(response.accepted).toBe(true);
    expect(response.stack).toEqual([order.recipe[0]]);
    expect(plate.stack).toEqual([order.recipe[0]]);
    expect(chef.layersAdded).toBe(1);
  });

  it("refuses an ingredient the chef does not own - exclusivity is the whole game", () => {
    const { model, chef, plate } = setup();
    runInAction(() => (chef.ingredientIds = []));

    const response = model.handleAddIngredient(chef.playerId, { ingredientId: "nori" });

    expect(response.accepted).toBe(false);
    expect(response.reason).toBe("notyours");
    expect(plate.stack).toEqual([]);
    expect(chef.layersAdded).toBe(0);
  });

  it("ALLOWS layering out of order - that is a flawed serve, not a blocked action", () => {
    const { model, order, chef, plate } = setup();
    // Apply the binder before the base.
    model.handleAddIngredient(chef.playerId, { ingredientId: order.recipe[1] });
    model.handleAddIngredient(chef.playerId, { ingredientId: order.recipe[0] });

    expect(plate.stack).toEqual([order.recipe[1], order.recipe[0]]);
  });

  it("returns a plate to the belt in the chef's own segment so it travels onward", () => {
    const { model, chef, plate } = setup();
    const response = model.handleReturnPlate(chef.playerId);

    expect(response.accepted).toBe(true);
    expect(plate.heldBy).toBe("");
    expect(chef.heldPlateId).toBe("");
    expect(Math.floor(plate.beltPos)).toBe(chef.stationIndex);
  });

  it("trashing bins the plate, respawns a fresh one for the table, and costs no strike", () => {
    const { model, order, chef, plate } = setup();
    model.handleAddIngredient(chef.playerId, { ingredientId: order.recipe[0] });

    const response = model.handleTrashPlate(chef.playerId);

    expect(response.accepted).toBe(true);
    expect(model.strikes).toBe(0); // trashing is a legitimate recovery move
    expect(chef.heldPlateId).toBe("");
    expect(model.plates.find((p) => p.id === plate.id)).toBeUndefined();
    // The customer is still waiting, so the table gets a fresh EMPTY plate.
    const replacement = model.plates.find((p) => p.orderId === order.id)!;
    expect(replacement).toBeDefined();
    expect(replacement.stack).toEqual([]);
    expect(model.orders).toContain(order);
  });
});

describe("SushiSyncPresenterModel - serving", () => {
  function buildPlate(stackOrder: (recipe: string[]) => string[]) {
    const { model, players } = makeSeatedGame(3);
    startPlaying(model);
    const order = spawnOneOrder(model);
    const plate = model.plates.find((p) => p.orderId === order.id)!;
    const chef = players.find((p) => p.stationIndex === 0)!;
    grantRecipe(chef, order);
    model.handlePullPlate(chef.playerId, { plateId: plate.id });
    stackOrder(order.recipe.slice()).forEach((id) =>
      model.handleAddIngredient(chef.playerId, { ingredientId: id }),
    );
    return { model, order, chef };
  }

  it("pays full price plus a tip and no strike for a perfect plate served early", () => {
    const { model, order, chef } = buildPlate((recipe) => recipe);
    const base = basePayoutFor(order.recipe.length);

    const response = model.handleServePlate(chef.playerId);

    expect(response.accepted).toBe(true);
    expect(response.result).toBe("exact");
    expect(response.dishName).toBe(order.dishName);
    expect(response.payout).toBeGreaterThan(base); // speed tip applied
    expect(model.till).toBe(response.payout);
    expect(model.strikes).toBe(0);
    expect(chef.platesServed).toBe(1);
    expect(chef.perfectPlates).toBe(1);
    expect(model.orders).not.toContain(order);
  });

  it("pays partially and adds a fractional strike for the right layers in the wrong order", () => {
    const { model, chef } = buildPlate((recipe) => [recipe[1], recipe[0], ...recipe.slice(2)]);

    const response = model.handleServePlate(chef.playerId);

    expect(response.result).toBe("wrongOrder");
    expect(model.strikes).toBeCloseTo(STRIKE_FOR_FLAWED);
    expect(chef.perfectPlates).toBe(0);
    expect(chef.platesServed).toBe(1);
  });

  it("pays a prefix-scaled amount for an incomplete plate", () => {
    const { model, chef } = buildPlate((recipe) => recipe.slice(0, 1));

    const response = model.handleServePlate(chef.playerId);

    expect(response.result).toBe("incomplete");
    expect(response.payout).toBeGreaterThan(0);
    expect(model.strikes).toBeCloseTo(STRIKE_FOR_FLAWED);
  });

  it("refuses to serve from an empty bench", () => {
    const { model, players } = makeSeatedGame(3);
    startPlaying(model);
    expect(model.handleServePlate(players[0].playerId).accepted).toBe(false);
  });
});

describe("SushiSyncPresenterModel - customer patience", () => {
  it("issues a full strike and clears the order when a customer gives up", () => {
    const { model } = makeSeatedGame(3);
    startPlaying(model);
    const order = spawnOneOrder(model);

    tickAt(model, order.createdAt + order.patienceMs + 1);

    expect(model.orders).not.toContain(order);
    expect(model.strikes).toBeCloseTo(STRIKE_FOR_TIMEOUT);
    expect(model.roundTimedOut).toBe(1);
    // The abandoned plate goes with it rather than circling forever.
    expect(model.plates.find((p) => p.orderId === order.id)).toBeUndefined();
  });

  it("frees the holder's bench when their plate's customer walks out", () => {
    const { model, players } = makeSeatedGame(3);
    startPlaying(model);
    const order = spawnOneOrder(model);
    const chef = players.find((p) => p.stationIndex === 0)!;
    model.handlePullPlate(chef.playerId, { plateId: model.plates[0].id });
    expect(chef.heldPlateId).not.toBe("");

    tickAt(model, order.createdAt + order.patienceMs + 1);

    expect(chef.heldPlateId).toBe("");
  });

  it("ends the shift on the third strike", () => {
    const { model } = makeSeatedGame(3);
    startPlaying(model);

    let guard = 0;
    while (model.strikes < STRIKES_TO_FAIL && guard++ < 50) {
      const order = model.orders[0];
      if (!order) {
        tickAt(model, model.gameTime_ms + 20000);
        continue;
      }
      tickAt(model, order.createdAt + order.patienceMs + 1);
    }

    expect(model.strikes).toBeGreaterThanOrEqual(STRIKES_TO_FAIL);
    expect(model.gameState).toBe(GeneralGameState.GameOver);
    expect(model.shiftFailed).toBe(true);
  });
});

describe("SushiSyncPresenterModel - the belt", () => {
  it("moves plates along the loop and broadcasts a snapshot", () => {
    const { model, sent } = makeSeatedGame(3);
    startPlaying(model);
    spawnOneOrder(model);
    const plate = model.plates[0];
    const startPos = plate.beltPos;

    tickAt(model, model.gameTime_ms + 200);
    tickAt(model, model.gameTime_ms + 200);

    expect(plate.beltPos).toBeGreaterThan(startPos);
    const push = sent.find((s) => s.route === "/games/sushisync/push/belt");
    expect(push).toBeDefined();
    expect(push!.message.plates[0].id).toBe(plate.id);
    // Hard mode is the default, so no plate should be flagged as "yours".
    expect(push!.message.plates[0].needsYou).toBeUndefined();
  });

  it("keeps a held plate off the belt broadcast", () => {
    const { model, sent, players } = makeSeatedGame(3);
    startPlaying(model);
    spawnOneOrder(model);
    const chef = players.find((p) => p.stationIndex === 0)!;
    model.handlePullPlate(chef.playerId, { plateId: model.plates[0].id });

    sent.length = 0;
    tickAt(model, model.gameTime_ms + 1000);

    const push = sent.find((s) => s.route === "/games/sushisync/push/belt");
    expect(push!.message.plates.length).toBe(0);
    expect(model.platesOnBelt.length).toBe(0);
  });

  it("clamps a huge time jump so a backgrounded tab does not teleport the belt", () => {
    const { model } = makeSeatedGame(3);
    startPlaying(model);
    spawnOneOrder(model);
    const plate = model.plates[0];
    tickAt(model, model.gameTime_ms + 100); // seed the tick clock
    const before = plate.beltPos;

    tickAt(model, model.gameTime_ms + 600000); // ten minutes asleep

    // Only the clamped 250ms of motion should have been applied.
    const maxExpected = before + model.roundConfig.beltSpeed * 0.25 + 0.001;
    expect(plate.beltPos).toBeLessThanOrEqual(maxExpected);
  });
});

describe("SushiSyncPresenterModel - roster churn", () => {
  it("rescues a departed chef's exclusive ingredients so orders stay winnable", () => {
    const { model, players } = makeSeatedGame(4);
    startPlaying(model);
    const leaver = players[0];
    const orphaned = leaver.ingredientIds.slice();
    expect(orphaned.length).toBeGreaterThan(0);

    runInAction(() => model.players.remove(leaver));
    tickAt(model, model.gameTime_ms + 50);

    const stillOwned = model.players.flatMap((p) => p.ingredientIds);
    orphaned.forEach((id) => expect(stillOwned).toContain(id));
    // And every active ingredient still has exactly one owner.
    expect(new Set(stillOwned).size).toBe(stillOwned.length);
    expect(stillOwned.slice().sort()).toEqual(model.activeIngredientIds.slice().sort());
  });

  it("releases a plate stranded on a departed chef's bench", () => {
    const { model, players } = makeSeatedGame(4);
    startPlaying(model);
    spawnOneOrder(model);
    const chef = players.find((p) => p.stationIndex === 0)!;
    model.handlePullPlate(chef.playerId, { plateId: model.plates[0].id });
    const plate = model.plates[0];

    runInAction(() => model.players.remove(chef));
    tickAt(model, model.gameTime_ms + 50);

    expect(plate.heldBy).toBe("");
  });

  it("closes the gap in the station ring after a departure", () => {
    const { model, players } = makeSeatedGame(4);
    startPlaying(model);
    const middle = players.find((p) => p.stationIndex === 1)!;

    runInAction(() => model.players.remove(middle));
    tickAt(model, model.gameTime_ms + 50);

    expect(model.players.map((p) => p.stationIndex).sort()).toEqual([0, 1, 2]);
    expect(model.stationCount).toBe(3);
  });
});

describe("SushiSyncPresenterModel - round flow", () => {
  it("runs briefing then play, and moves to the next round when time runs out", () => {
    const { model } = makeSeatedGame(3);
    model.startGame();
    expect(model.gameState).toBe(SushiSyncGameState.RoundBriefing);
    expect(model.currentRound).toBe(1);

    // Briefing expires -> play begins.
    runInAction(() => (model.timeOfStageEnd = model.gameTime_ms - 1));
    model.handleTick();
    expect(model.gameState).toBe(SushiSyncGameState.Playing);

    // Round timer expires -> end of round report.
    runInAction(() => (model.timeOfStageEnd = model.gameTime_ms - 1));
    model.handleTick();
    expect(model.gameState).toBe(SushiSyncGameState.EndOfRound);
    expect(model.roundsCompleted).toBe(1);

    // Report expires -> next round briefing.
    runInAction(() => (model.timeOfStageEnd = model.gameTime_ms - 1));
    model.handleTick();
    expect(model.gameState).toBe(SushiSyncGameState.RoundBriefing);
    expect(model.currentRound).toBe(2);
  });

  it("ends the game cleanly after the final round", () => {
    const { model } = makeSeatedGame(3);
    startPlaying(model);
    runInAction(() => {
      model.currentRound = model.totalRounds;
      model.timeOfStageEnd = model.gameTime_ms - 1;
    });

    model.handleTick();

    expect(model.gameState).toBe(GeneralGameState.GameOver);
    expect(model.shiftFailed).toBe(false);
  });

  it("clears the belt when a round ends so plates do not leak between rounds", () => {
    const { model } = makeSeatedGame(3);
    startPlaying(model);
    spawnOneOrder(model);
    expect(model.plates.length).toBeGreaterThan(0);

    runInAction(() => (model.timeOfStageEnd = model.gameTime_ms - 1));
    model.handleTick();

    expect(model.plates.length).toBe(0);
    expect(model.orders.length).toBe(0);
  });
});

describe("SushiSyncPresenterModel - checkpoint serialization", () => {
  // A type-helper mistake (a missing class, or a collection not re-wrapped as observable)
  // otherwise only shows up as a broken save/restore mid-game.  Build the serializer the
  // production way and round-trip a game that has all four classes live in the graph.
  it("round-trips players, plates and orders through the real serializer", () => {
    const sent: SentMessage[] = [];
    const session = makeFakeSession(sent);
    const logger = new MockTelemetryLogger("test");

    const typeHelper = getPresenterTypeHelper(
      getSushiSyncPresenterTypeHelper(session, { logger, storage: NOOP_STORAGE } as any),
    );
    const model = instantiateGame(
      typeHelper,
      logger,
      NOOP_STORAGE,
    ) as unknown as SushiSyncPresenterModel;

    ["p0", "p1", "p2"].forEach((id, i) => {
      const p = model.createFreshPlayerEntry(`Chef${i}`, id);
      runInAction(() => model.players.push(p));
    });
    model.beginSeating();
    startPlaying(model);
    const order = spawnOneOrder(model);
    const chef = model.players.find((p) => p.stationIndex === 0)!;
    grantRecipe(chef, order);
    model.handlePullPlate(chef.playerId, { plateId: model.plates[0].id });
    model.handleAddIngredient(chef.playerId, { ingredientId: order.recipe[0] });
    runInAction(() => {
      model.till = 275;
      model.strikes = 1.34;
    });

    const serializer = model.serializer!;
    let json = "";
    expect(() => {
      json = serializer.stringify(model);
    }).not.toThrow();

    const back = serializer.parse<SushiSyncPresenterModel>(json);

    expect(back.players.length).toBe(3);
    expect(back.till).toBe(275);
    expect(back.strikes).toBeCloseTo(1.34);
    expect(back.activeIngredientIds.slice().sort()).toEqual(
      model.activeIngredientIds.slice().sort(),
    );

    // Orders keep their recipes - losing these would make every live order unservable.
    expect(back.orders.length).toBe(model.orders.length);
    expect(back.orders[0].recipe).toEqual(order.recipe);
    expect(back.orders[0].dishName).toBe(order.dishName);

    // Plates keep their stack and who is holding them.
    expect(back.plates.length).toBe(model.plates.length);
    const restoredPlate = back.plates.find((p) => p.heldBy === chef.playerId)!;
    expect(restoredPlate).toBeDefined();
    expect(restoredPlate.stack).toEqual([order.recipe[0]]);

    // Seating and the deal survive, so a refreshed presenter resumes the same shift.
    const restoredChef = back.players.find((p) => p.playerId === chef.playerId)!;
    expect(restoredChef.stationIndex).toBe(chef.stationIndex);
    expect(restoredChef.ingredientIds).toEqual(chef.ingredientIds);
    expect(restoredChef.heldPlateId).toBe(restoredPlate.id);
    expect(restoredChef.layersAdded).toBe(1);
  });

  it("keeps restored collections observable so the board re-renders after a refresh", () => {
    const sent: SentMessage[] = [];
    const session = makeFakeSession(sent);
    const logger = new MockTelemetryLogger("test");
    const typeHelper = getPresenterTypeHelper(
      getSushiSyncPresenterTypeHelper(session, { logger, storage: NOOP_STORAGE } as any),
    );
    const model = instantiateGame(
      typeHelper,
      logger,
      NOOP_STORAGE,
    ) as unknown as SushiSyncPresenterModel;
    ["p0", "p1", "p2"].forEach((id, i) => {
      const p = model.createFreshPlayerEntry(`Chef${i}`, id);
      runInAction(() => model.players.push(p));
    });
    model.beginSeating();
    startPlaying(model);
    spawnOneOrder(model);

    const back = model.serializer!.parse<SushiSyncPresenterModel>(
      model.serializer!.stringify(model),
    );

    // MobX observable arrays expose remove(); a plain array would not, and the presenter
    // calls plates.remove()/orders.remove() on every serve and timeout.
    expect(typeof (back.plates as any).remove).toBe("function");
    expect(typeof (back.orders as any).remove).toBe("function");
  });
});
