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
import { MinefieldGameState } from "./PresenterModel";
import {
  type MinefieldFieldView,
  type MinefieldLocalView,
  MinefieldMoveEndpoint,
  MinefieldOnboardEndpoint,
  type MinefieldRole,
  type MinefieldTeamStatus,
  MinefieldTeamUpdateEndpoint,
  type MinefieldTeamUpdateMessage,
} from "./minefieldEndpoints";

// -------------------------------------------------------------------
// Type helper for save/restore.
// -------------------------------------------------------------------
export const getMinefieldClientTypeHelper = (
  sessionHelper: ISessionHelper,
  gameProps: ClusterFunGameProps,
): ITypeHelper => {
  return {
    rootTypeName: "MinefieldClientModel",
    getTypeName(o: object) {
      switch (o.constructor) {
        case MinefieldClientModel:
          return "MinefieldClientModel";
      }
      return undefined;
    },
    constructType(typeName: string): any {
      switch (typeName) {
        case "MinefieldClientModel":
          return new MinefieldClientModel(
            sessionHelper,
            gameProps.playerName || "Player",
            gameProps.logger,
            gameProps.storage,
          );
      }
      return null;
    },
    shouldStringify(typeName: string, propertyName: string, object: any): boolean {
      if (object instanceof MinefieldClientModel) {
        // The field, the local view and the run status are all rebuilt by the very next
        // onboard, and the presenter is the authority on every one of them.  Saving them
        // would only create a window where a refreshed phone shows a stale minefield -
        // which in this game is not a cosmetic problem.
        return ["field", "local", "status"].indexOf(propertyName) === -1;
      }
      return true;
    },
    reconstitute(typeName: string, propertyName: string, rehydratedObject: any) {
      return rehydratedObject;
    },
  };
};

// Client-side states - one per screen the phone can show.
export enum MinefieldClientState {
  Briefing = "Briefing",
  Exploring = "Exploring",
  Advising = "Advising",
  RoundScore = "RoundScore",
}

// -------------------------------------------------------------------
// The client: a thin controller.  It captures the explorer's taps and renders whichever
// fragment of the field the presenter decided this player is entitled to see.  It makes no
// authoritative decisions - notably it never works out whether a step was fatal, because
// only the presenter knows what is buried where.
// -------------------------------------------------------------------
export class MinefieldClientModel extends ClusterfunClientModel {
  @observable role: MinefieldRole = "waiting";
  @observable teamId = -1;
  @observable teamName = "";
  @observable teamColor = "#ffffff";
  @observable explorerName = "";
  @observable advisorCount = 0;
  @observable totalRounds = 3;
  @observable secondsLeft = 0;
  @observable revealed = false;
  @observable standings: { teamId: number; teamName: string; teamColor: string; score: number }[] =
    [];

  /** The whole field as this advisor is allowed to see it. Undefined for the explorer. */
  @observable.ref field: MinefieldFieldView | undefined = undefined;
  /** Where the explorer stands and what they may step to. Undefined for advisors. */
  @observable.ref local: MinefieldLocalView | undefined = undefined;
  @observable.ref status: MinefieldTeamStatus | undefined = undefined;

  /** What just happened to the explorer, for the phone's own feedback. */
  @observable lastOutcome = "";
  @observable killedBy = "";
  @observable moveInFlight = false;

  /**
   * Local wall-clock deadline for a freeze, so the phone can count down smoothly instead of
   * waiting for the next message.  The presenter remains the authority: it rejects an early
   * move whatever this says.
   */
  @observable frozenUntilLocalMs = 0;

  get frozenSecondsLeft(): number {
    return Math.max(0, Math.ceil((this.frozenUntilLocalMs - Date.now()) / 1000));
  }

  get isFrozen(): boolean {
    return this.frozenUntilLocalMs > Date.now();
  }

  constructor(
    sessionHelper: ISessionHelper,
    playerName: string,
    logger: ITelemetryLogger,
    storage: IStorage,
  ) {
    super("MinefieldClient", sessionHelper, playerName, logger, storage);
    makeObservable(this);
  }

  reconstitute() {
    super.reconstitute();
    this.listenToEndpointFromPresenter(MinefieldTeamUpdateEndpoint, this.handleTeamUpdate);
  }

  // -------------------------------------------------------------------
  //  requestGameStateFromPresenter - the phone's only sync path, so it rebuilds EVERYTHING
  //  from the response.  A phone can miss any individual push (asleep, tunnel, refreshed),
  //  and an advisor holding a stale field would give advice that gets somebody killed.
  // -------------------------------------------------------------------
  async requestGameStateFromPresenter(): Promise<void> {
    const response = await this.session.requestPresenter(MinefieldOnboardEndpoint, {});
    action(() => {
      this.roundNumber = response.round;
      this.totalRounds = response.totalRounds;
      this.role = response.role;
      this.teamId = response.teamId;
      this.teamName = response.teamName;
      this.teamColor = response.teamColor;
      this.explorerName = response.explorerName;
      this.advisorCount = response.advisorCount;
      this.secondsLeft = response.secondsLeft;
      this.revealed = response.revealed;
      this.standings = response.standings;
      this.field = response.field;
      this.local = response.local;
      this.status = response.status;
      if (response.status) {
        this.frozenUntilLocalMs = Date.now() + response.status.frozenMsLeft;
      }

      switch (response.gameState) {
        case MinefieldGameState.Briefing:
          this.gameState = MinefieldClientState.Briefing;
          break;
        case MinefieldGameState.Running:
          this.gameState =
            response.role === "explorer"
              ? MinefieldClientState.Exploring
              : MinefieldClientState.Advising;
          break;
        case MinefieldGameState.RoundScore:
          this.gameState = MinefieldClientState.RoundScore;
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
  //  handleTeamUpdate - a small delta so an advisor's map follows their explorer live.
  // -------------------------------------------------------------------
  handleTeamUpdate = (message: MinefieldTeamUpdateMessage) => {
    action(() => {
      this.status = message.status;
      this.lastOutcome = message.event;
      this.frozenUntilLocalMs = Date.now() + message.status.frozenMsLeft;
    })();
  };

  // -------------------------------------------------------------------
  //  doMove - the explorer taps a neighbouring cell.
  //
  //  Nothing is applied optimistically.  In every other game in this repo a hopeful local
  //  update is harmless, but here the answer to "did that work" is "you are dead", and a
  //  phone that moved its own marker before the presenter ruled would be showing a lie at
  //  the one moment the player is looking hardest.
  // -------------------------------------------------------------------
  async doMove(cellId: number): Promise<void> {
    if (this.role !== "explorer" || this.moveInFlight || this.isFrozen) return;
    const serial = this.status ? this.status.steps : 0;
    action(() => {
      this.moveInFlight = true;
    })();
    try {
      const response = await this.session.requestPresenter(MinefieldMoveEndpoint, {
        toCellId: cellId,
        stepSerial: serial,
      });
      action(() => {
        this.lastOutcome = response.outcome;
        this.killedBy = response.killedBy ?? "";
        if (response.local) this.local = response.local;
        if (response.status) {
          this.status = response.status;
          this.frozenUntilLocalMs = Date.now() + response.status.frozenMsLeft;
        }
      })();
      this.saveCheckpoint();
    } catch (error) {
      Logger.warn(`Minefield move failed: ${error}`);
    } finally {
      action(() => {
        this.moveInFlight = false;
      })();
    }
  }

  /** Clear the death/goal banner once the player has taken it in. */
  acknowledgeOutcome = () => {
    action(() => {
      this.lastOutcome = "";
      this.killedBy = "";
    })();
  };
}
