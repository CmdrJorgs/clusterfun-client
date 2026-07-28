import Logger from "js-logger";
import { action, makeObservable, observable } from "mobx";
import {
  ISessionHelper,
  ClusterFunGameProps,
  ClusterfunClientModel,
  ITelemetryLogger,
  IStorage,
  GeneralClientGameState,
  ITypeHelper,
} from "libs";
import { SushiSyncGameState } from "./PresenterModel";
import {
  SushiSyncAddIngredientEndpoint,
  SushiSyncBeltPlate,
  SushiSyncBeltPushEndpoint,
  SushiSyncBeltPushMessage,
  SushiSyncHeldPlate,
  SushiSyncIngredientInfo,
  SushiSyncOnboardClientEndpoint,
  SushiSyncPullPlateEndpoint,
  SushiSyncReturnPlateEndpoint,
  SushiSyncServePlateEndpoint,
  SushiSyncSwapStationEndpoint,
  SushiSyncTrashPlateEndpoint,
} from "./sushiSyncEndpoints";
import { advanceBelt, isPlateInReach } from "./sushiSyncLogic";

// How long a transient message ("Someone beat you to it") stays on the phone.
const TOAST_MS = 1600;

// -------------------------------------------------------------------
// Type helper.  The client holds only scalars and small plain objects.  Belt state is
// deliberately NOT persisted: it is re-pulled on onboard and is stale within 400ms anyway.
// -------------------------------------------------------------------
export const getSushiSyncClientTypeHelper = (
  sessionHelper: ISessionHelper,
  gameProps: ClusterFunGameProps,
): ITypeHelper => {
  return {
    rootTypeName: "SushiSyncClientModel",
    getTypeName(o: object) {
      switch (o.constructor) {
        case SushiSyncClientModel:
          return "SushiSyncClientModel";
      }
      return undefined;
    },
    constructType(typeName: string): any {
      switch (typeName) {
        case "SushiSyncClientModel":
          return new SushiSyncClientModel(
            sessionHelper,
            gameProps.playerName || "Chef",
            gameProps.logger,
            gameProps.storage,
          );
      }
      return null;
    },
    shouldStringify(typeName: string, propertyName: string, object: any): boolean {
      if (object instanceof SushiSyncClientModel) {
        const doNotSerializeMe = ["beltPlates", "toastMessage", "_toastClearTime"];
        if (doNotSerializeMe.indexOf(propertyName) !== -1) return false;
      }
      return true;
    },
    reconstitute(typeName: string, propertyName: string, rehydratedObject: any) {
      if (propertyName === "myIngredients") {
        return observable<SushiSyncIngredientInfo>(rehydratedObject as SushiSyncIngredientInfo[]);
      }
      return rehydratedObject;
    },
  };
};

// Client-side states - one per screen the phone can show.
export enum SushiSyncClientState {
  Seating = "Seating",
  Briefing = "Briefing",
  Playing = "Playing",
  EndOfRound = "EndOfRound",
}

// -------------------------------------------------------------------
// The chef's phone.  A thin controller: it captures taps, sends them to the presenter, and
// renders only the input UI.  It makes NO authoritative decisions - every action is echoed
// back by the presenter and the phone reconciles to that.
// -------------------------------------------------------------------
export class SushiSyncClientModel extends ClusterfunClientModel {
  @observable roundName = "";
  @observable stationIndex = 0;
  @observable stationCount = 0;
  @observable leftNeighborName = "";
  @observable rightNeighborName = "";

  @observable myIngredients: SushiSyncIngredientInfo[] = [];
  @observable heldPlate: SushiSyncHeldPlate | null = null;

  @observable strikes = 0;
  @observable till = 0;
  @observable showMyTurnHighlight = false;
  @observable showNextLayerHint = false;

  /** Local mirror of the belt, extrapolated between presenter pushes. */
  @observable beltPlates: SushiSyncBeltPlate[] = [];
  @observable beltSpeed = 0;

  /** Transient feedback ("Someone beat you to it", "Perfect! +150"). */
  @observable toastMessage = "";
  private _toastClearTime = 0;

  /** True while a request is in flight, so a double-tap cannot double-fire. */
  @observable busy = false;

  constructor(
    sessionHelper: ISessionHelper,
    playerName: string,
    logger: ITelemetryLogger,
    storage: IStorage,
  ) {
    super("SushiSyncClient", sessionHelper, playerName, logger, storage);
    makeObservable(this);
  }

  reconstitute() {
    super.reconstitute();
    this.listenToEndpointFromPresenter(SushiSyncBeltPushEndpoint, this.handleBeltPush);
  }

  // -------------------------------------------------------------------
  //  requestGameStateFromPresenter - the client's ONLY state-sync path.  Must fully rebuild
  //  the phone, because individual pushes can be missed.
  // -------------------------------------------------------------------
  async requestGameStateFromPresenter(): Promise<void> {
    const response = await this.session.requestPresenter(SushiSyncOnboardClientEndpoint, {});

    action(() => {
      this.roundNumber = response.roundNumber;
      this.roundName = response.roundName;
      this.stationIndex = response.stationIndex;
      this.stationCount = response.stationCount;
      this.leftNeighborName = response.leftNeighborName;
      this.rightNeighborName = response.rightNeighborName;
      this.myIngredients = response.myIngredients;
      this.heldPlate = response.heldPlate;
      this.beltSpeed = response.beltSpeed;
      this.strikes = response.strikes;
      this.till = response.till;
      this.showMyTurnHighlight = response.showMyTurnHighlight;
      this.showNextLayerHint = response.showNextLayerHint;
      this.busy = false;

      switch (response.gameState) {
        case SushiSyncGameState.Seating:
          this.gameState = SushiSyncClientState.Seating;
          break;
        case SushiSyncGameState.RoundBriefing:
          this.gameState = SushiSyncClientState.Briefing;
          break;
        case SushiSyncGameState.Playing:
          this.gameState = SushiSyncClientState.Playing;
          break;
        case SushiSyncGameState.EndOfRound:
          this.gameState = SushiSyncClientState.EndOfRound;
          break;
        default:
          Logger.debug(`Presenter is in state: ${response.gameState}`);
          this.gameState = GeneralClientGameState.WaitingToStart;
          break;
      }
    })();

    this.saveCheckpoint();
  }

  // -------------------------------------------------------------------
  //  Belt sync.  The presenter is authoritative; between its 400ms pushes the phone
  //  extrapolates locally so the belt reads as continuous motion rather than a slideshow.
  // -------------------------------------------------------------------
  private handleBeltPush = (message: SushiSyncBeltPushMessage) => {
    action(() => {
      this.beltPlates = message.plates;
      this.beltSpeed = message.speed;
    })();
  };

  gameThink(elapsed_ms: number) {
    if (this.gameState === SushiSyncClientState.Playing && this.stationCount > 0) {
      action(() => {
        this.beltPlates = this.beltPlates.map((plate) => ({
          ...plate,
          pos: advanceBelt(plate.pos, this.beltSpeed, elapsed_ms, this.stationCount),
        }));
      })();
    }

    if (this.toastMessage && this.gameTime_ms > this._toastClearTime) {
      action(() => (this.toastMessage = ""))();
    }
  }

  /** Plates currently crossing THIS phone's segment - the only ones it renders or can pull. */
  get platesInMyZone(): SushiSyncBeltPlate[] {
    return this.beltPlates.filter((p) =>
      isPlateInReach(p.pos, this.stationIndex, this.stationCount),
    );
  }

  private toast(message: string) {
    action(() => {
      this.toastMessage = message;
      this._toastClearTime = this.gameTime_ms + TOAST_MS;
    })();
  }

  // -------------------------------------------------------------------
  //  Player actions
  // -------------------------------------------------------------------

  async swapStation(direction: "left" | "right") {
    const response = await this.session.requestPresenter(SushiSyncSwapStationEndpoint, {
      direction,
    });
    action(() => {
      this.stationIndex = response.stationIndex;
      this.leftNeighborName = response.leftNeighborName;
      this.rightNeighborName = response.rightNeighborName;
    })();
    this.saveCheckpoint();
  }

  async pullPlate(plateId: string) {
    if (this.busy || this.heldPlate) return;
    action(() => (this.busy = true))();
    try {
      const response = await this.session.requestPresenter(SushiSyncPullPlateEndpoint, { plateId });
      if (response.accepted && response.plate) {
        const plate = response.plate;
        action(() => {
          this.heldPlate = plate;
          // Drop it from the local belt immediately so it cannot be tapped twice.
          this.beltPlates = this.beltPlates.filter((p) => p.id !== plateId);
        })();
      } else {
        this.toast(pullFailureMessage(response.reason));
      }
    } finally {
      action(() => (this.busy = false))();
    }
    this.saveCheckpoint();
  }

  async addIngredient(ingredientId: string) {
    if (!this.heldPlate) return;
    const response = await this.session.requestPresenter(SushiSyncAddIngredientEndpoint, {
      ingredientId,
    });
    action(() => {
      if (this.heldPlate) this.heldPlate = { ...this.heldPlate, stack: response.stack };
    })();
    if (!response.accepted && response.reason === "notyours") {
      this.toast("That's not yours to add");
    }
    this.saveCheckpoint();
  }

  async returnPlateToBelt() {
    if (!this.heldPlate || this.busy) return;
    action(() => (this.busy = true))();
    try {
      const response = await this.session.requestPresenter(SushiSyncReturnPlateEndpoint, {});
      if (response.accepted) action(() => (this.heldPlate = null))();
    } finally {
      action(() => (this.busy = false))();
    }
    this.saveCheckpoint();
  }

  async trashPlate() {
    if (!this.heldPlate || this.busy) return;
    action(() => (this.busy = true))();
    try {
      const response = await this.session.requestPresenter(SushiSyncTrashPlateEndpoint, {});
      if (response.accepted) {
        action(() => (this.heldPlate = null))();
        this.toast("Binned it");
      }
    } finally {
      action(() => (this.busy = false))();
    }
    this.saveCheckpoint();
  }

  async servePlate() {
    if (!this.heldPlate || this.busy) return;
    action(() => (this.busy = true))();
    try {
      const response = await this.session.requestPresenter(SushiSyncServePlateEndpoint, {});
      action(() => (this.heldPlate = null))();
      if (response.accepted) {
        this.toast(serveResultMessage(response.result, response.payout, response.dishName));
      } else {
        this.toast("That customer already left");
      }
    } finally {
      action(() => (this.busy = false))();
    }
    this.saveCheckpoint();
  }
}

// -------------------------------------------------------------------
// Phone-facing copy for the presenter's terse reason codes.  Exported so they can be unit
// tested without standing up a whole client model.
// -------------------------------------------------------------------
export function pullFailureMessage(reason?: string): string {
  switch (reason) {
    case "taken":
      return "Someone beat you to it";
    case "busy":
      return "Finish your current plate first";
    case "outofreach":
      return "That plate has passed you";
    default:
      return "Can't grab that right now";
  }
}

export function serveResultMessage(result?: string, payout?: number, dishName?: string): string {
  const amount = payout ?? 0;
  switch (result) {
    case "exact":
      return `Perfect ${dishName ?? "roll"}!  +${amount}`;
    case "wrongOrder":
      return `Right layers, wrong order  +${amount}`;
    default:
      return `They wanted ${dishName ?? "something else"}  +${amount}`;
  }
}
