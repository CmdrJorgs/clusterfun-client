import { observable } from "mobx";
import { PLAYTIME_MS } from "./GameSettings";
import {
  ClusterFunPlayer,
  ISessionHelper,
  ClusterFunGameProps,
  ClusterfunPresenterModel,
  ReconnectInfo,
  ITelemetryLogger,
  IStorage,
  ITypeHelper,
  PresenterGameState,
  GeneralGameState,
} from "libs";
import Logger from "js-logger";
import {
  MinefieldColorChangeActionEndpoint,
  MinefieldColorChangeRequest,
  MinefieldMessageActionEndpoint,
  MinefieldMessageRequest,
  MinefieldOnboardClientEndpoint,
  MinefieldOnboardClientMessage,
  MinefieldTapActionEndpoint,
  MinefieldTapRequest,
} from "./minefieldEndpoints";
import { findWinners } from "./minefieldLogic";
import { GameOverEndpoint, InvalidateStateEndpoint } from "libs/messaging/basicEndpoints";

export enum MinefieldPlayerStatus {
  Unknown = "Unknown",
  WaitingForStart = "WaitingForStart",
}

// The presenter's record for one player.  Fields marked @observable drive the
// presenter UI; everything here is serialized into the checkpoint unless the
// type helper below excludes it.
export class MinefieldPlayer extends ClusterFunPlayer {
  @observable totalScore = 0;
  @observable status = MinefieldPlayerStatus.Unknown;
  @observable message = "";
  @observable colorStyle = "#ffffff";
  @observable x = 0;
  @observable y = 0;
}

// -------------------------------------------------------------------
// The Game state - add one entry per presenter screen your game has.
// (Gathering, Paused, GameOver, etc. come from the framework enums.)
// -------------------------------------------------------------------
export enum MinefieldGameState {
  Playing = "Playing",
  EndOfRound = "EndOfRound",
}

// -------------------------------------------------------------------
// Game events - in-process notifications the views subscribe to,
// mostly to trigger sounds and animations.
// -------------------------------------------------------------------
export enum MinefieldGameEvent {
  ResponseReceived = "ResponseReceived",
  ColorChanged = "ColorChanged",
  ScoreChanged = "ScoreChanged",
  WinnerAnnounced = "WinnerAnnounced",
}

// -------------------------------------------------------------------
// Create the typehelper needed for loading and saving the game.
// The serializer uses this to save/restore the whole model on refresh -
// register EVERY custom class that can appear in your model's object
// graph, or save/restore will silently drop it.
// -------------------------------------------------------------------
export const getMinefieldPresenterTypeHelper = (
  sessionHelper: ISessionHelper,
  gameProps: ClusterFunGameProps,
): ITypeHelper => {
  return {
    rootTypeName: "MinefieldPresenterModel",
    getTypeName(o) {
      switch (o.constructor) {
        case MinefieldPresenterModel:
          return "MinefieldPresenterModel";
        case MinefieldPlayer:
          return "MinefieldPlayer";
      }
      return undefined;
    },
    constructType(typeName: string): any {
      switch (typeName) {
        case "MinefieldPresenterModel":
          return new MinefieldPresenterModel(sessionHelper, gameProps.logger, gameProps.storage);
        case "MinefieldPlayer":
          return new MinefieldPlayer();
        // TODO: add a case for each custom class in your game model
      }
      return null;
    },
    shouldStringify(typeName: string, propertyName: string, object: any): boolean {
      if (object instanceof MinefieldPresenterModel) {
        const doNotSerializeMe = [
          // TODO: list presenter properties that should NOT be saved in the
          //       checkpoint (large caches, derived data, DOM handles...)
          "Name_of_presenter_property_to_not_serialize",
        ];

        if (doNotSerializeMe.indexOf(propertyName) !== -1) return false;
      }
      return true;
    },
    reconstitute(typeName: string, propertyName: string, rehydratedObject: any) {
      if (typeName === "MinefieldPresenterModel") {
        // TODO: properties needing special treatment on deserialization go here,
        // e.g. re-wrapping arrays as MobX observables:
        // switch(propertyName) {
        //     case "myObservableCollection":
        //         return observable<ItemType>(rehydratedObject as ItemType[]);
        // }
      }
      return rehydratedObject;
    },
  };
};

// -------------------------------------------------------------------
// presenter data and logic
// The presenter is the game's single source of truth: it owns all state,
// decides every transition, and pushes/serves state to the clients.
// -------------------------------------------------------------------
export class MinefieldPresenterModel extends ClusterfunPresenterModel<MinefieldPlayer> {
  // The winner(s) of the game so far - a computed view over player scores.
  // Rule logic lives in minefieldLogic.ts where it is unit tested.
  get winners(): MinefieldPlayer[] {
    return findWinners(this.players.slice());
  }

  // -------------------------------------------------------------------
  // ctor
  // -------------------------------------------------------------------
  constructor(sessionHelper: ISessionHelper, logger: ITelemetryLogger, storage: IStorage) {
    super("Minefield", sessionHelper, logger, storage);
    Logger.info(`Constructing MinefieldPresenterModel ${this.gameState}`);

    // States during which a new player may join (or rejoin) the room
    this.allowedJoinStates = [PresenterGameState.Gathering, MinefieldGameState.Playing];

    this.minPlayers = 2;
  }

  // -------------------------------------------------------------------
  //  reconstitute - runs on fresh construction AND after restoring a
  //  saved game.  Wire up all message listeners here, not in the ctor,
  //  so a restored game hears its clients again.
  // -------------------------------------------------------------------
  reconstitute() {
    super.reconstitute();
    this.listenToEndpoint(MinefieldOnboardClientEndpoint, this.handleOnboardClient);
    this.listenToEndpoint(MinefieldColorChangeActionEndpoint, this.handleColorChangeAction);
    this.listenToEndpoint(MinefieldMessageActionEndpoint, this.handleMessageAction);
    this.listenToEndpoint(MinefieldTapActionEndpoint, this.handleTapAction);
  }

  // -------------------------------------------------------------------
  //  createFreshPlayerEntry
  // -------------------------------------------------------------------
  createFreshPlayerEntry(name: string, id: string): MinefieldPlayer {
    const newPlayer = new MinefieldPlayer();
    newPlayer.playerId = id;
    newPlayer.name = name;

    return newPlayer;
  }

  // -------------------------------------------------------------------
  //  onPlayerReturned - a phone that dropped is back.
  //
  //  Every game must write this one: the base class declares it abstract
  //  precisely so that reconnecting - the most common thing that happens to
  //  a party game - is something you decided rather than something you
  //  forgot.  "Nothing to do, and here is why" is a perfectly good answer.
  //
  //  Player ids are STABLE across a reconnect, so anything this game keys by
  //  playerId (scores, answers, a seat at the table) is still theirs and
  //  needs no migration.  The base class has already put them back on the
  //  new connection and marked them connected, and the phone pulls fresh
  //  state itself via requestGameStateFromPresenter.  So for a simple
  //  round-based game like this one, there is genuinely nothing left to do.
  //
  //  A game with more to hand back - a board being played by a bot, a turn
  //  that was skipped - does it here.  See Eittris for a worked example.
  // -------------------------------------------------------------------
  protected onPlayerReturned(_player: MinefieldPlayer, _info: ReconnectInfo) {}

  // -------------------------------------------------------------------
  //  onPlayerDisconnected - they keep their seat and all their state; they
  //  are expected back.  Grey them out, or hand their turn to a bot if the
  //  game cannot wait.  Do not delete anything.
  // -------------------------------------------------------------------
  protected onPlayerDisconnected(_player: MinefieldPlayer) {}

  // -------------------------------------------------------------------
  //  prepareFreshRound - set up per-round state.  Called by the framework
  //  before round 1 and by startNextRound below, so keep it idempotent.
  // -------------------------------------------------------------------
  prepareFreshRound = () => {
    this.players.forEach((p, i) => {
      p.status = MinefieldPlayerStatus.WaitingForStart;
      p.message = "";
      p.colorStyle = "white";
      p.x = 0.1;
      p.y = i * 0.1 + 0.1;
    });
  };

  // -------------------------------------------------------------------
  //  prepareFreshGame - reset everything for a brand new game
  // -------------------------------------------------------------------
  prepareFreshGame = () => {
    this.gameState = PresenterGameState.Gathering;
    this.currentRound = 0;
    this.players.forEach((p) => (p.totalScore = 0));
  };

  // -------------------------------------------------------------------
  //  handleTick - called every frame by the game clock.  Check for
  //  time-based state transitions here.
  // -------------------------------------------------------------------
  handleTick() {
    if (this.isStageOver) {
      switch (this.gameState) {
        case MinefieldGameState.Playing:
          this.finishPlayingRound();
          this.saveCheckpoint();
          break;
      }
    }
  }

  // -------------------------------------------------------------------
  //  finishPlayingRound - the round timer ran out.  Pause between rounds,
  //  or end the game after the final round.
  // -------------------------------------------------------------------
  finishPlayingRound() {
    if (this.currentRound >= this.totalRounds) {
      this.finishGame();
    } else {
      this.gameState = MinefieldGameState.EndOfRound;
      this.sendToEveryone(InvalidateStateEndpoint, (p, ie) => ({}));
    }
  }

  // -------------------------------------------------------------------
  //  finishGame - announce the winner and tell every client
  // -------------------------------------------------------------------
  finishGame() {
    this.gameState = GeneralGameState.GameOver;
    this.invokeEvent(MinefieldGameEvent.WinnerAnnounced, this.winners);
    this.requestEveryone(GameOverEndpoint, (p, ie) => ({}));
    this.saveCheckpoint();
  }

  // -------------------------------------------------------------------
  //  startNextRound
  // -------------------------------------------------------------------
  startNextRound = () => {
    this.prepareFreshRound();
    this.currentRound++;
    this.gameState = MinefieldGameState.Playing;
    this.timeOfStageEnd = this.gameTime_ms + PLAYTIME_MS;
    this.sendToEveryone(InvalidateStateEndpoint, (p, ie) => ({}));
    this.saveCheckpoint();
  };

  // -------------------------------------------------------------------
  //  handleOnboardClient - answer a client's request for full state.
  //  This is a request/response endpoint, so THROWING here rejects the
  //  client's request with an error it can show.
  // -------------------------------------------------------------------
  handleOnboardClient = (sender: string, message: unknown): MinefieldOnboardClientMessage => {
    this.telemetryLogger.logEvent("Presenter", "Onboard Client");
    return {
      roundNumber: this.currentRound,
      customText: "Hi There",
      gameState: this.gameState,
    };
  };

  // -------------------------------------------------------------------
  //  Fire-and-forget action handlers.  These can't reply, so on a bad
  //  message just log and return - never throw.
  // -------------------------------------------------------------------
  handleColorChangeAction = (sender: string, message: MinefieldColorChangeRequest) => {
    const player = this.players.find((p) => p.playerId === sender);
    if (!player) {
      Logger.warn("No player found for message: " + JSON.stringify(message));
      this.telemetryLogger.logEvent("Presenter", "AnswerMessage", "Deny");
      return;
    }
    player.colorStyle = message.colorStyle;
    this.invokeEvent(MinefieldGameEvent.ColorChanged, player);
    this.saveCheckpoint();
  };

  handleMessageAction = (sender: string, message: MinefieldMessageRequest) => {
    const player = this.players.find((p) => p.playerId === sender);
    if (!player) {
      Logger.warn("No player found for message: " + JSON.stringify(message));
      this.telemetryLogger.logEvent("Presenter", "AnswerMessage", "Deny");
      return;
    }
    player.message = message.message;
    this.invokeEvent(MinefieldGameEvent.ResponseReceived, player);
    this.saveCheckpoint();
  };

  handleTapAction = (sender: string, message: MinefieldTapRequest) => {
    const player = this.players.find((p) => p.playerId === sender);
    if (!player) {
      Logger.warn("No player found for message: " + JSON.stringify(message));
      this.telemetryLogger.logEvent("Presenter", "AnswerMessage", "Deny");
      return;
    }
    player.x = message.point.x;
    player.y = message.point.y;

    // Example scoring rule: every tap during play is worth a point
    if (this.gameState === MinefieldGameState.Playing) {
      player.totalScore++;
      this.invokeEvent(MinefieldGameEvent.ScoreChanged, player);
    }
    this.saveCheckpoint();
  };
}
