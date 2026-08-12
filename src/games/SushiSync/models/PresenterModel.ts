import { action, makeObservable, observable } from "mobx";
import {
  BELT_PUSH_INTERVAL_MS,
  BRIEFING_MS,
  END_OF_ROUND_MS,
  FIRST_TABLE_NUMBER,
  LAST_TABLE_NUMBER,
  MAX_PLAYERS,
  MAX_STACK_HEIGHT,
  MIN_PLAYERS,
  ROUNDS,
  RoundConfig,
  SHOW_MY_TURN_HIGHLIGHT,
  SHOW_NEXT_LAYER_HINT,
  STRIKES_TO_FAIL,
  STRIKE_FOR_TIMEOUT,
  TOTAL_ROUNDS,
} from "./GameSettings";
import {
  ClusterFunPlayer,
  ISessionHelper,
  ClusterFunGameProps,
  ClusterfunPresenterModel,
  ITelemetryLogger,
  IStorage,
  ITypeHelper,
  PresenterGameState,
  GeneralGameState,
} from "libs";
import Logger from "js-logger";
import {
  SushiSyncAddIngredientEndpoint,
  SushiSyncAddIngredientRequest,
  SushiSyncAddIngredientResponse,
  SushiSyncBeltPushEndpoint,
  SushiSyncHeldPlate,
  SushiSyncOnboardClientEndpoint,
  SushiSyncOnboardClientMessage,
  SushiSyncPullPlateEndpoint,
  SushiSyncPullPlateRequest,
  SushiSyncPullPlateResponse,
  SushiSyncReturnPlateEndpoint,
  SushiSyncReturnPlateResponse,
  SushiSyncServePlateEndpoint,
  SushiSyncServePlateResponse,
  SushiSyncSwapStationEndpoint,
  SushiSyncSwapStationRequest,
  SushiSyncSwapStationResponse,
  SushiSyncTrashPlateEndpoint,
  SushiSyncTrashPlateResponse,
} from "./sushiSyncEndpoints";
import {
  ChefStats,
  Ingredient,
  advanceBelt,
  assignIngredients,
  chooseActiveIngredients,
  compactStations,
  dishNameFor,
  findTopChefs,
  generateRecipe,
  ingredientById,
  isPlateInReach,
  neighborsOf,
  nextRequiredIngredient,
  redistributeOrphanedIngredients,
  scorePlate,
  starRating,
} from "./sushiSyncLogic";
import { GameOverEndpoint, InvalidateStateEndpoint } from "libs/messaging/basicEndpoints";

// A tick can be arbitrarily long if the presenter tab was backgrounded or the machine slept.
// Clamping keeps a resumed tab from teleporting every plate around the loop at once.
const MAX_TICK_ELAPSED_MS = 250;

// Grace period after the briefing before the first plate appears, so nobody is behind on the
// very first order.
const FIRST_SPAWN_GRACE_MS = 1500;

// -------------------------------------------------------------------
// The presenter's record for one chef.
//
// makeObservable() in the constructor is NOT optional here: ClusterFunPlayer does not call it,
// so without it these @observable fields are inert in MobX 6 and the order board would render
// stale stations, ingredients and stats.  (CollageBoardPlayer does the same.)
// -------------------------------------------------------------------
export class SushiSyncPlayer extends ClusterFunPlayer {
  /** Seat on the belt loop.  -1 until the ring is laid out. */
  @observable stationIndex = -1;
  /** This chef's exclusive ingredients for the current round. */
  @observable ingredientIds: string[] = [];
  /** Id of the plate in this chef's workstation, or "" when their bench is clear. */
  @observable heldPlateId = "";

  // Contribution stats -> the Top Chef crown on the results screen.
  @observable layersAdded = 0;
  @observable platesServed = 0;
  @observable perfectPlates = 0;

  constructor() {
    super();
    makeObservable(this);
  }
}

// -------------------------------------------------------------------
// A physical plate: either riding the belt or sitting on a chef's bench.
// -------------------------------------------------------------------
export class SushiSyncPlate {
  id = "";
  orderId = "";
  tableNumber = 0;
  /** Belt position: integer part is the station, fraction is progress across it. */
  @observable beltPos = 0;
  /** Ingredient ids in application order. */
  @observable stack: string[] = [];
  /** Player id holding this plate, or "" while it is on the belt. */
  @observable heldBy = "";

  constructor() {
    makeObservable(this);
  }
}

// -------------------------------------------------------------------
// A customer's order.  The RECIPE lives here on the presenter only - that is the whole
// informational tension of the game.
// -------------------------------------------------------------------
export class SushiSyncOrder {
  id = "";
  tableNumber = 0;
  @observable recipe: string[] = [];
  @observable dishName = "";
  @observable plateId = "";
  /** Game time the customer sat down. */
  createdAt = 0;
  patienceMs = 1;

  constructor() {
    makeObservable(this);
  }
}

// -------------------------------------------------------------------
// Presenter states.  Gathering / Paused / GameOver come from the framework enums.
// -------------------------------------------------------------------
export enum SushiSyncGameState {
  /** Stations assigned; players physically arrange themselves to match. */
  Seating = "Seating",
  /** Round name + who owns which ingredients this round. */
  RoundBriefing = "RoundBriefing",
  Playing = "Playing",
  EndOfRound = "EndOfRound",
}

// -------------------------------------------------------------------
// Game events - in-process notifications the views subscribe to for sounds and animation.
// -------------------------------------------------------------------
export enum SushiSyncGameEvent {
  PlateServed = "PlateServed",
  PlateTrashed = "PlateTrashed",
  OrderTimedOut = "OrderTimedOut",
  RoundStarted = "RoundStarted",
  ShiftOver = "ShiftOver",
}

// -------------------------------------------------------------------
// Type helper: EVERY serializable class must be registered here or save/restore silently
// drops it.  Sushi Sync stores only scalars and short string arrays, so unlike the photo
// games nothing needs to be excluded for localStorage quota reasons.
// -------------------------------------------------------------------
export const getSushiSyncPresenterTypeHelper = (
  sessionHelper: ISessionHelper,
  gameProps: ClusterFunGameProps,
): ITypeHelper => {
  return {
    rootTypeName: "SushiSyncPresenterModel",
    getTypeName(o) {
      switch (o.constructor) {
        case SushiSyncPresenterModel:
          return "SushiSyncPresenterModel";
        case SushiSyncPlayer:
          return "SushiSyncPlayer";
        case SushiSyncPlate:
          return "SushiSyncPlate";
        case SushiSyncOrder:
          return "SushiSyncOrder";
      }
      return undefined;
    },
    constructType(typeName: string): any {
      switch (typeName) {
        case "SushiSyncPresenterModel":
          return new SushiSyncPresenterModel(sessionHelper, gameProps.logger, gameProps.storage);
        case "SushiSyncPlayer":
          return new SushiSyncPlayer();
        case "SushiSyncPlate":
          return new SushiSyncPlate();
        case "SushiSyncOrder":
          return new SushiSyncOrder();
      }
      return null;
    },
    shouldStringify(typeName: string, propertyName: string, object: any): boolean {
      if (object instanceof SushiSyncPresenterModel) {
        // Frame-timing bookkeeping is meaningless after a reload - it is re-seeded on the
        // first tick.  Persisting it would make a restored game think a huge span elapsed.
        const doNotSerializeMe = ["_lastTickTime", "_lastBeltPushTime", "_knownPlayerIds"];
        if (doNotSerializeMe.indexOf(propertyName) !== -1) return false;
      }
      return true;
    },
    reconstitute(typeName: string, propertyName: string, rehydratedObject: any) {
      if (typeName === "SushiSyncPresenterModel") {
        switch (propertyName) {
          case "plates":
            return observable<SushiSyncPlate>(rehydratedObject as SushiSyncPlate[]);
          case "orders":
            return observable<SushiSyncOrder>(rehydratedObject as SushiSyncOrder[]);
        }
      }
      return rehydratedObject;
    },
  };
};

// -------------------------------------------------------------------
// The presenter: single source of truth for the belt, the orders, the till and the strikes.
// -------------------------------------------------------------------
export class SushiSyncPresenterModel extends ClusterfunPresenterModel<SushiSyncPlayer> {
  plates = observable<SushiSyncPlate>([]);
  orders = observable<SushiSyncOrder>([]);

  @observable till = 0;
  @observable strikes = 0;
  @observable roundsCompleted = 0;
  /** True when the shift ended early on three strikes rather than by finishing round 3. */
  @observable shiftFailed = false;

  /** Ingredient ids in play this round. */
  @observable activeIngredientIds: string[] = [];

  // Per-round running totals, for the end-of-round report card.
  @observable roundEarnings = 0;
  @observable roundPerfect = 0;
  @observable roundFlawed = 0;
  @observable roundTimedOut = 0;

  private _lastTickTime = -1;
  private _lastBeltPushTime = 0;
  private _nextSpawnTime = 0;
  private _nextTableNumber = FIRST_TABLE_NUMBER;
  private _idCounter = 0;
  private _knownPlayerIds: string[] = [];

  /** Tuning for the current round.  Clamped so it is safe before round 1 has started. */
  get roundConfig(): RoundConfig {
    const index = Math.min(Math.max(this.currentRound - 1, 0), ROUNDS.length - 1);
    return ROUNDS[index];
  }

  get stationCount(): number {
    return this.players.length;
  }

  get activeIngredients(): Ingredient[] {
    return this.activeIngredientIds
      .map(ingredientById)
      .filter((i): i is Ingredient => i !== undefined);
  }

  /** Chefs sorted by seat, for the ring diagram and the briefing table. */
  get playersByStation(): SushiSyncPlayer[] {
    return this.players.slice().sort((a, b) => a.stationIndex - b.stationIndex);
  }

  get stars(): number {
    return starRating(this.till, this.strikes, this.roundsCompleted);
  }

  get topChefs(): SushiSyncPlayer[] {
    return findTopChefs(this.players.slice() as (SushiSyncPlayer & ChefStats)[]);
  }

  /** Plates actually riding the belt (a held plate is on a bench, not the loop). */
  get platesOnBelt(): SushiSyncPlate[] {
    return this.plates.filter((p) => p.heldBy === "");
  }

  // -------------------------------------------------------------------
  // ctor
  // -------------------------------------------------------------------
  constructor(sessionHelper: ISessionHelper, logger: ITelemetryLogger, storage: IStorage) {
    super("SushiSync", sessionHelper, logger, storage);
    makeObservable(this);
    Logger.info(`Constructing SushiSyncPresenterModel ${this.gameState}`);

    // Seating is included so latecomers can still be given a seat before the shift starts.
    // Joining mid-round is deliberately NOT allowed - it would renumber the belt under
    // everyone's feet while plates are in flight.
    this.allowedJoinStates = [PresenterGameState.Gathering, SushiSyncGameState.Seating];

    this.minPlayers = MIN_PLAYERS;
    this.maxPlayers = MAX_PLAYERS;
    this.totalRounds = TOTAL_ROUNDS;
  }

  // -------------------------------------------------------------------
  //  reconstitute - runs fresh AND after a restore, so listeners are wired here.
  // -------------------------------------------------------------------
  reconstitute() {
    super.reconstitute();
    this.listenToEndpoint(SushiSyncOnboardClientEndpoint, this.handleOnboardClient);
    this.listenToEndpoint(SushiSyncSwapStationEndpoint, this.handleSwapStation);
    this.listenToEndpoint(SushiSyncPullPlateEndpoint, this.handlePullPlate);
    this.listenToEndpoint(SushiSyncAddIngredientEndpoint, this.handleAddIngredient);
    this.listenToEndpoint(SushiSyncReturnPlateEndpoint, this.handleReturnPlate);
    this.listenToEndpoint(SushiSyncTrashPlateEndpoint, this.handleTrashPlate);
    this.listenToEndpoint(SushiSyncServePlateEndpoint, this.handleServePlate);
  }

  createFreshPlayerEntry(name: string, id: string): SushiSyncPlayer {
    const player = new SushiSyncPlayer();
    player.playerId = id;
    player.name = name;
    return player;
  }

  private nextId(prefix: string): string {
    this._idCounter++;
    return `${prefix}${this._idCounter}`;
  }

  private rng = () => this.randomDouble(1);

  // -------------------------------------------------------------------
  //  Lifecycle
  // -------------------------------------------------------------------

  prepareFreshGame = () => {
    action(() => {
      this.gameState = PresenterGameState.Gathering;
      this.currentRound = 0;
      this.roundsCompleted = 0;
      this.till = 0;
      this.strikes = 0;
      this.shiftFailed = false;
      this.plates.clear();
      this.orders.clear();
      this.activeIngredientIds = [];
      this.players.forEach((p) => {
        p.stationIndex = -1;
        p.ingredientIds = [];
        p.heldPlateId = "";
        p.layersAdded = 0;
        p.platesServed = 0;
        p.perfectPlates = 0;
      });
    })();
  };

  /**
   * Lay out the belt ring and let everyone physically arrange themselves.  Called from the
   * join screen instead of startGame() so seating happens before the first shift.
   */
  beginSeating = () => {
    action(() => {
      this.assignStations();
      this.gameState = SushiSyncGameState.Seating;
    })();
    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();
  };

  private assignStations() {
    this.players.forEach((p, i) => {
      if (p.stationIndex < 0) p.stationIndex = i;
    });
    this.compactStationIndices();
  }

  private compactStationIndices() {
    const compacted = compactStations(
      this.players.map((p) => ({ playerId: p.playerId, stationIndex: p.stationIndex })),
    );
    this.players.forEach((p) => {
      const next = compacted.get(p.playerId);
      if (next !== undefined) p.stationIndex = next;
    });
  }

  /**
   * Per-round setup: pick this round's ingredient pool and deal it out exclusively.
   * Idempotent - the base class calls it once before startNextRound() does.
   */
  prepareFreshRound = () => {
    action(() => {
      const config = this.roundConfig;
      const active = chooseActiveIngredients(
        this.players.length,
        config.ingredientTarget,
        this.rng,
      );
      this.activeIngredientIds = active.map((i) => i.id);

      const assignments = assignIngredients(
        this.players.map((p) => p.playerId),
        active,
        this.rng,
      );
      this.players.forEach((p) => {
        p.ingredientIds = assignments.get(p.playerId) ?? [];
        p.heldPlateId = "";
      });

      this.plates.clear();
      this.orders.clear();
      this.roundEarnings = 0;
      this.roundPerfect = 0;
      this.roundFlawed = 0;
      this.roundTimedOut = 0;
    })();
  };

  startNextRound = () => {
    action(() => {
      this.currentRound++;
      this.assignStations();
    })();
    this.prepareFreshRound();
    action(() => {
      this.gameState = SushiSyncGameState.RoundBriefing;
      this.setStageEndTime(BRIEFING_MS);
    })();
    this.invokeEvent(SushiSyncGameEvent.RoundStarted, this.roundConfig.name);
    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();
  };

  /** Briefing is over - open the restaurant. */
  private beginPlayingRound() {
    action(() => {
      this.gameState = SushiSyncGameState.Playing;
      this.setStageEndTime(this.roundConfig.durationMs);
      this._nextSpawnTime = this.gameTime_ms + FIRST_SPAWN_GRACE_MS;
      this._lastTickTime = this.gameTime_ms;
    })();
    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();
  }

  private finishRound() {
    action(() => {
      this.roundsCompleted++;
      this.releaseAllPlates();
    })();

    if (this.currentRound >= this.totalRounds) {
      this.finishGame(false);
    } else {
      action(() => {
        this.gameState = SushiSyncGameState.EndOfRound;
        this.setStageEndTime(END_OF_ROUND_MS);
      })();
      this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
      this.saveCheckpoint();
    }
  }

  private releaseAllPlates() {
    this.players.forEach((p) => (p.heldPlateId = ""));
    this.plates.clear();
    this.orders.clear();
  }

  finishGame(failed: boolean) {
    action(() => {
      this.shiftFailed = failed;
      this.releaseAllPlates();
      this.gameState = GeneralGameState.GameOver;
    })();
    this.invokeEvent(SushiSyncGameEvent.ShiftOver, this.topChefs);
    this.requestEveryone(GameOverEndpoint, () => ({}));
    this.saveCheckpoint();
  }

  // -------------------------------------------------------------------
  //  handleTick - the belt, the spawner and the customers' patience all live here.
  // -------------------------------------------------------------------
  handleTick() {
    const now = this.gameTime_ms;

    switch (this.gameState) {
      case SushiSyncGameState.Seating:
        this.reconcileRoster();
        break;

      case SushiSyncGameState.RoundBriefing:
        if (this.isStageOver) this.beginPlayingRound();
        break;

      case SushiSyncGameState.Playing: {
        this.reconcileRoster();

        // Clamp so a backgrounded tab does not teleport the whole belt on resume.
        const elapsed =
          this._lastTickTime < 0 ? 0 : Math.min(now - this._lastTickTime, MAX_TICK_ELAPSED_MS);
        this._lastTickTime = now;

        this.advancePlates(elapsed);
        this.spawnDueOrders(now);
        this.expireImpatientCustomers(now);
        this.pushBeltIfDue(now);

        if (this.strikes >= STRIKES_TO_FAIL) {
          this.finishGame(true);
        } else if (this.isStageOver) {
          this.finishRound();
          this.saveCheckpoint();
        }
        break;
      }

      case SushiSyncGameState.EndOfRound:
        if (this.isStageOver) this.startNextRound();
        break;
    }
  }

  private advancePlates(elapsedMs: number) {
    if (elapsedMs <= 0 || this.stationCount === 0) return;
    const speed = this.roundConfig.beltSpeed;
    action(() => {
      this.plates.forEach((plate) => {
        if (plate.heldBy !== "") return;
        plate.beltPos = advanceBelt(plate.beltPos, speed, elapsedMs, this.stationCount);
      });
    })();
  }

  private spawnDueOrders(now: number) {
    const config = this.roundConfig;
    if (this.orders.length >= config.maxConcurrentOrders) return;
    if (now < this._nextSpawnTime) return;
    this.spawnOrder();
    this._nextSpawnTime = now + config.spawnIntervalMs;
  }

  private spawnOrder() {
    const config = this.roundConfig;
    const active = this.activeIngredients;
    if (active.length === 0) return;

    const recipe = generateRecipe(active, config.minRecipeLength, config.maxRecipeLength, this.rng);

    const order = new SushiSyncOrder();
    order.id = this.nextId("order");
    order.tableNumber = this._nextTableNumber;
    order.recipe = recipe;
    order.dishName = dishNameFor(recipe);
    order.createdAt = this.gameTime_ms;
    order.patienceMs = config.patienceMs;

    this._nextTableNumber++;
    if (this._nextTableNumber > LAST_TABLE_NUMBER) this._nextTableNumber = FIRST_TABLE_NUMBER;

    action(() => {
      this.orders.push(order);
      this.spawnPlateFor(order);
    })();
  }

  /** Every order always has exactly one plate; trashing one respawns a fresh empty plate. */
  private spawnPlateFor(order: SushiSyncOrder) {
    const plate = new SushiSyncPlate();
    plate.id = this.nextId("plate");
    plate.orderId = order.id;
    plate.tableNumber = order.tableNumber;
    plate.beltPos = 0; // plates always enter the loop at station 0
    plate.stack = [];
    plate.heldBy = "";
    order.plateId = plate.id;
    this.plates.push(plate);
  }

  private expireImpatientCustomers(now: number) {
    const expired = this.orders.filter((o) => now - o.createdAt >= o.patienceMs);
    if (expired.length === 0) return;

    action(() => {
      expired.forEach((order) => {
        this.strikes += STRIKE_FOR_TIMEOUT;
        this.roundTimedOut++;
        this.removeOrder(order);
        this.invokeEvent(SushiSyncGameEvent.OrderTimedOut, order);
      });
    })();
    this.saveCheckpoint();
  }

  private removeOrder(order: SushiSyncOrder) {
    const plate = this.plates.find((p) => p.id === order.plateId);
    if (plate) this.discardPlate(plate);
    this.orders.remove(order);
  }

  /** Take a plate out of play, clearing whoever's bench it was sitting on. */
  private discardPlate(plate: SushiSyncPlate) {
    if (plate.heldBy) {
      const holder = this.players.find((p) => p.playerId === plate.heldBy);
      if (holder) holder.heldPlateId = "";
    }
    this.plates.remove(plate);
  }

  private pushBeltIfDue(now: number) {
    if (now - this._lastBeltPushTime < BELT_PUSH_INTERVAL_MS) return;
    this._lastBeltPushTime = now;

    // Round the position - two decimals is well below what a phone can render, and it keeps
    // the payload small for eight phones on weak wifi.
    const plates = this.platesOnBelt.map((p) => ({
      id: p.id,
      pos: Math.round(p.beltPos * 100) / 100,
      table: p.tableNumber,
      stack: p.stack.slice(),
    }));
    const speed = this.roundConfig.beltSpeed;

    if (!SHOW_MY_TURN_HIGHLIGHT) {
      // Hard mode (the default): one shared payload, no per-recipient work.
      this.sendToEveryone(SushiSyncBeltPushEndpoint, () => ({ plates, speed }));
      return;
    }

    // Soft mode: mark the plates whose next required layer this particular chef owns.  This
    // has to happen here because the phone is never told the recipe.
    const nextLayerByPlate = new Map<string, string | undefined>();
    this.platesOnBelt.forEach((plate) => {
      const order = this.orders.find((o) => o.id === plate.orderId);
      nextLayerByPlate.set(
        plate.id,
        order ? nextRequiredIngredient(plate.stack.slice(), order.recipe.slice()) : undefined,
      );
    });

    this.sendToEveryone(SushiSyncBeltPushEndpoint, (player) => ({
      speed,
      plates: plates.map((p) => {
        const needed = nextLayerByPlate.get(p.id);
        return { ...p, needsYou: !!needed && player.ingredientIds.includes(needed) };
      }),
    }));
  }

  /**
   * Keep seating and ingredient ownership consistent with who is actually here.
   *
   * Deliberately polled rather than event-driven: the base class removes players inside an
   * arrow-function property that a subclass cannot override via super, so reconciling from
   * observed state is both simpler and correct regardless of how someone left.
   */
  private reconcileRoster() {
    const currentIds = this.players.map((p) => p.playerId);
    const unchanged =
      currentIds.length === this._knownPlayerIds.length &&
      currentIds.every((id, i) => id === this._knownPlayerIds[i]);
    if (unchanged) return;

    action(() => {
      this._knownPlayerIds = currentIds;

      // Someone new arrived during Seating - give them the next seat.
      this.players.forEach((p, i) => {
        if (p.stationIndex < 0) p.stationIndex = this.players.length + i;
      });
      this.compactStationIndices();

      // Free any plate whose holder is gone, so it is not stranded off the belt forever.
      this.plates.forEach((plate) => {
        if (plate.heldBy && !currentIds.includes(plate.heldBy)) plate.heldBy = "";
      });

      // Rescue exclusive ingredients left behind by a departure.  Without this, every live
      // order needing one becomes unwinnable.
      if (this.activeIngredientIds.length > 0 && currentIds.length > 0) {
        const assignments = new Map<string, string[]>();
        this.players.forEach((p) => assignments.set(p.playerId, p.ingredientIds.slice()));
        const next = redistributeOrphanedIngredients(
          assignments,
          this.activeIngredientIds,
          currentIds,
        );
        this.players.forEach((p) => (p.ingredientIds = next.get(p.playerId) ?? []));
      }
    })();

    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();
  }

  // -------------------------------------------------------------------
  //  Message handlers
  // -------------------------------------------------------------------

  handleOnboardClient = (sender: string): SushiSyncOnboardClientMessage => {
    this.telemetryLogger.logEvent("Presenter", "Onboard Client");
    return this.buildOnboardMessage(sender);
  };

  private buildOnboardMessage(playerId: string): SushiSyncOnboardClientMessage {
    const player = this.players.find((p) => p.playerId === playerId);
    const count = this.stationCount;
    const station = player?.stationIndex ?? 0;
    const { leftIndex, rightIndex } = neighborsOf(station, count);

    const heldPlate = player?.heldPlateId
      ? this.plates.find((p) => p.id === player.heldPlateId)
      : undefined;

    return {
      gameState: this.gameState,
      roundNumber: this.currentRound,
      roundName: this.roundConfig.name,

      stationIndex: station,
      stationCount: count,
      leftNeighborName: this.nameAtStation(leftIndex),
      rightNeighborName: this.nameAtStation(rightIndex),

      myIngredients: (player?.ingredientIds ?? [])
        .map(ingredientById)
        .filter((i): i is Ingredient => i !== undefined)
        .map((i) => ({ id: i.id, name: i.name, category: i.category })),

      heldPlate: heldPlate ? this.toHeldPlate(heldPlate) : null,

      beltSpeed: this.roundConfig.beltSpeed,
      strikes: this.strikes,
      till: this.till,

      showMyTurnHighlight: SHOW_MY_TURN_HIGHLIGHT,
      showNextLayerHint: SHOW_NEXT_LAYER_HINT,
    };
  }

  private nameAtStation(index: number): string {
    return this.players.find((p) => p.stationIndex === index)?.name ?? "";
  }

  private toHeldPlate(plate: SushiSyncPlate): SushiSyncHeldPlate {
    return { id: plate.id, table: plate.tableNumber, stack: plate.stack.slice() };
  }

  handleSwapStation = (
    sender: string,
    message: SushiSyncSwapStationRequest,
  ): SushiSyncSwapStationResponse => {
    const player = this.players.find((p) => p.playerId === sender);
    const count = this.stationCount;
    const reject = (): SushiSyncSwapStationResponse => {
      const station = player?.stationIndex ?? 0;
      const n = neighborsOf(station, count);
      return {
        accepted: false,
        stationIndex: station,
        leftNeighborName: this.nameAtStation(n.leftIndex),
        rightNeighborName: this.nameAtStation(n.rightIndex),
      };
    };

    if (!player || this.gameState !== SushiSyncGameState.Seating || count < 2) return reject();

    const { leftIndex, rightIndex } = neighborsOf(player.stationIndex, count);
    const targetIndex = message.direction === "left" ? leftIndex : rightIndex;
    const neighbor = this.players.find((p) => p.stationIndex === targetIndex);
    if (!neighbor || neighbor.playerId === player.playerId) return reject();

    action(() => {
      const mine = player.stationIndex;
      player.stationIndex = neighbor.stationIndex;
      neighbor.stationIndex = mine;
    })();

    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();

    const after = neighborsOf(player.stationIndex, count);
    return {
      accepted: true,
      stationIndex: player.stationIndex,
      leftNeighborName: this.nameAtStation(after.leftIndex),
      rightNeighborName: this.nameAtStation(after.rightIndex),
    };
  };

  handlePullPlate = (
    sender: string,
    message: SushiSyncPullPlateRequest,
  ): SushiSyncPullPlateResponse => {
    if (this.gameState !== SushiSyncGameState.Playing) {
      return { accepted: false, reason: "notplaying" };
    }
    const player = this.players.find((p) => p.playerId === sender);
    if (!player) return { accepted: false, reason: "notplaying" };
    if (player.heldPlateId) return { accepted: false, reason: "busy" };

    const plate = this.plates.find((p) => p.id === message.plateId);
    // Lost the race: someone else grabbed it in the same frame, or it has already been served.
    if (!plate || plate.heldBy !== "") return { accepted: false, reason: "taken" };

    if (!isPlateInReach(plate.beltPos, player.stationIndex, this.stationCount)) {
      return { accepted: false, reason: "outofreach" };
    }

    action(() => {
      plate.heldBy = sender;
      player.heldPlateId = plate.id;
    })();
    this.saveCheckpoint();
    return { accepted: true, plate: this.toHeldPlate(plate) };
  };

  handleAddIngredient = (
    sender: string,
    message: SushiSyncAddIngredientRequest,
  ): SushiSyncAddIngredientResponse => {
    const context = this.heldPlateContext(sender);
    if (!context) return { accepted: false, reason: "noplate", stack: [] };
    const { player, plate } = context;

    // Exclusive ownership is the whole game: you may only apply what you were dealt.
    if (!player.ingredientIds.includes(message.ingredientId)) {
      return { accepted: false, reason: "notyours", stack: plate.stack.slice() };
    }
    if (plate.stack.length >= MAX_STACK_HEIGHT) {
      return { accepted: false, reason: "full", stack: plate.stack.slice() };
    }

    // NOTE: out-of-order layering is intentionally allowed - it becomes a flawed serve.
    action(() => {
      plate.stack = [...plate.stack, message.ingredientId];
      player.layersAdded++;
    })();
    this.saveCheckpoint();
    return { accepted: true, stack: plate.stack.slice() };
  };

  handleReturnPlate = (sender: string): SushiSyncReturnPlateResponse => {
    const context = this.heldPlateContext(sender);
    if (!context) return { accepted: false, reason: "noplate" };
    const { player, plate } = context;

    action(() => {
      // Re-enter mid-way through this chef's own segment so it carries on to the next chef.
      plate.beltPos = player.stationIndex + 0.5;
      plate.heldBy = "";
      player.heldPlateId = "";
    })();
    this.saveCheckpoint();
    return { accepted: true };
  };

  handleTrashPlate = (sender: string): SushiSyncTrashPlateResponse => {
    const context = this.heldPlateContext(sender);
    if (!context) return { accepted: false, reason: "noplate" };
    const { plate } = context;

    const order = this.orders.find((o) => o.id === plate.orderId);
    action(() => {
      this.discardPlate(plate);
      // The customer is still waiting, so give the table a fresh empty plate.  Trashing costs
      // no strike; the time lost against a running order timer is the punishment.
      if (order) this.spawnPlateFor(order);
    })();
    this.invokeEvent(SushiSyncGameEvent.PlateTrashed, plate);
    this.saveCheckpoint();
    return { accepted: true };
  };

  handleServePlate = (sender: string): SushiSyncServePlateResponse => {
    const context = this.heldPlateContext(sender);
    if (!context) return { accepted: false, reason: "noplate" };
    const { player, plate } = context;

    const order = this.orders.find((o) => o.id === plate.orderId);
    if (!order) {
      // The customer gave up while this plate was on the bench - drop it quietly.
      action(() => this.discardPlate(plate))();
      return { accepted: false, reason: "noorder" };
    }

    const elapsed = this.gameTime_ms - order.createdAt;
    const patienceFraction = 1 - elapsed / Math.max(1, order.patienceMs);
    const scored = scorePlate(plate.stack.slice(), order.recipe.slice(), patienceFraction);

    action(() => {
      this.till += scored.payout;
      this.strikes += scored.strikeDelta;
      this.roundEarnings += scored.payout;
      player.platesServed++;
      if (scored.result === "exact") {
        player.perfectPlates++;
        this.roundPerfect++;
      } else {
        this.roundFlawed++;
      }
      this.removeOrder(order);
    })();

    this.invokeEvent(SushiSyncGameEvent.PlateServed, { player, ...scored });
    this.saveCheckpoint();

    if (this.strikes >= STRIKES_TO_FAIL) this.finishGame(true);

    return {
      accepted: true,
      result: scored.result,
      payout: scored.payout,
      dishName: order.dishName,
    };
  };

  /** Shared lookup for the four actions that need "the plate on this chef's bench". */
  private heldPlateContext(
    sender: string,
  ): { player: SushiSyncPlayer; plate: SushiSyncPlate } | undefined {
    if (this.gameState !== SushiSyncGameState.Playing) return undefined;
    const player = this.players.find((p) => p.playerId === sender);
    if (!player || !player.heldPlateId) return undefined;
    const plate = this.plates.find((p) => p.id === player.heldPlateId);
    if (!plate || plate.heldBy !== sender) return undefined;
    return { player, plate };
  }
}
