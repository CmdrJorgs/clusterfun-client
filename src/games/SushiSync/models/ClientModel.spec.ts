import { runInAction } from "mobx";
import { ISessionHelper } from "libs";
import { MockTelemetryLogger } from "libs/telemetry/MockTelemetryLogger";
import { SushiSyncClientModel, SushiSyncClientState } from "./ClientModel";

// -------------------------------------------------------------------
// Belt extrapolation on the phone.
//
// Regression cover for a real bug: BaseGameModel does `onTick.invoke(this.gameTime_ms)`,
// so onTick carries ABSOLUTE game time, not a per-frame delta.  The view used to pipe that
// straight into gameThink(elapsed_ms), which treats its argument as a delta - so every
// frame advanced the belt by the entire elapsed game.  Plates tore across the phone and
// drifted further from the presenter the longer a round ran, while the presenter (which
// computes its own delta) looked correct.
// -------------------------------------------------------------------

function makeFakeSession(): ISessionHelper {
  const fake: Partial<ISessionHelper> = {
    roomId: "ROOM1",
    personalId: "PLAYER1",
    personalSecret: "secret",
    sendMessage: () => {},
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

// Skips reconstitute() deliberately - it starts a real ticker.  We invoke the tick handler
// directly, which is exactly what the subscription does in production.
function makeClient() {
  const model = new SushiSyncClientModel(
    makeFakeSession(),
    "Alice",
    new MockTelemetryLogger("test"),
    NOOP_STORAGE,
  );
  runInAction(() => {
    model.gameState = SushiSyncClientState.Playing;
    model.stationCount = 4;
    model.beltSpeed = 0.5; // stations per second
    model.beltPlates = [{ id: "p1", pos: 0, table: 3, stack: [] }];
  });
  return model;
}

/** The production subscription is `onTick.subscribe(..., this.handleBeltTick)`. */
function tick(model: SushiSyncClientModel, absoluteGameTimeMs: number) {
  (model as any).handleBeltTick(absoluteGameTimeMs);
}

describe("SushiSyncClientModel — belt extrapolation", () => {
  it("treats onTick's absolute game time as a delta between ticks", () => {
    const model = makeClient();

    // First tick only establishes the baseline - it must not advance anything, or a phone
    // joining an hour into a game would rocket its plates around the belt.
    tick(model, 60_000);
    expect(model.beltPlates[0].pos).toBe(0);

    // 1 second later at 0.5 stations/sec => half a station, NOT 61 seconds' worth.
    tick(model, 61_000);
    expect(model.beltPlates[0].pos).toBeCloseTo(0.5, 6);

    // And a second later again - steady, not accelerating.
    tick(model, 62_000);
    expect(model.beltPlates[0].pos).toBeCloseTo(1.0, 6);
  });

  it("advances by the delta only, regardless of absolute game time", () => {
    // The original bug scaled movement with absolute game time, so an identical 100ms
    // step moved the belt further the longer the game had been running.  Each model here
    // takes the SAME 100ms step, one near t=0 and one ten minutes in.
    const step = (baselineMs: number) => {
      const model = makeClient();
      tick(model, baselineMs); // establishes the baseline, advances nothing
      tick(model, baselineMs + 100);
      return model.beltPlates[0].pos;
    };

    const early = step(1_000);
    const late = step(600_000);

    expect(early).toBeCloseTo(0.05, 6); // 0.5 stations/sec * 0.1s
    expect(late).toBeCloseTo(early, 6);
  });

  it("wraps around the loop rather than running off the end", () => {
    const model = makeClient();
    tick(model, 0);
    // 4 stations at 0.5/sec = 8s for a full loop; 9s should wrap to 0.5.
    tick(model, 9_000);
    expect(model.beltPlates[0].pos).toBeCloseTo(0.5, 6);
  });

  it("ignores a non-advancing or backwards tick", () => {
    const model = makeClient();
    tick(model, 5_000);
    tick(model, 6_000);
    const posAfter = model.beltPlates[0].pos;

    tick(model, 6_000); // duplicate timestamp
    expect(model.beltPlates[0].pos).toBeCloseTo(posAfter, 6);
  });

  it("holds still when the phone is not in the Playing state", () => {
    const model = makeClient();
    runInAction(() => (model.gameState = SushiSyncClientState.EndOfRound));
    tick(model, 1_000);
    tick(model, 3_000);
    expect(model.beltPlates[0].pos).toBe(0);
  });
});
