// The shared-screen view: the restaurant's order board.  One page component per presenter
// game state, chosen by renderSubScreen().  These are observers over the presenter model -
// they render state, they never own it.
//
// This screen is the ONLY place recipes are visible.  That is deliberate (see DESIGN.md):
// the phones show a table number, so players have to read this board and talk to each other.
import React from "react";
import { observer, inject } from "mobx-react";
import styles from "./Presenter.module.css";
import classNames from "classnames";
import SushiSyncAssets from "../assets/Assets";
import { STRIKES_TO_FAIL, SushiSyncVersion, TOTAL_ROUNDS } from "../models/GameSettings";
import {
  MediaHelper,
  UIProperties,
  PresenterGameEvent,
  PresenterGameState,
  GeneralGameState,
  DevUI,
  UINormalizer,
  PlayerAvatar,
} from "libs";
import {
  SushiSyncPresenterModel,
  SushiSyncGameState,
  SushiSyncGameEvent,
  SushiSyncPlayer,
  SushiSyncOrder,
} from "../models/PresenterModel";
import { ingredientName } from "../models/sushiSyncLogic";

// The patience bar turns red (and the card highlights) below this fraction remaining.
const URGENT_PATIENCE = 0.33;

// Plate radii on the belt ring.  Plates riding the loop sit ON the belt; a plate a chef has
// pulled onto their bench is drawn further in, so the ring only ever shows what is actually
// travelling.  The gap has to be big enough to read at a glance from across the room.
const BELT_RADIUS = 205;
const BENCH_RADIUS = 148;

// ------------------------------------------------------------------------------------------
// Shared bits
// ------------------------------------------------------------------------------------------

const NameWithAvatar = (props: { player: SushiSyncPlayer; size?: number }) => (
  <span className={styles.statName}>
    <PlayerAvatar avatarId={props.player.avatarId} size={props.size ?? 40} />
    {props.player.name}
  </span>
);

/** Three pips; a partial pip shows the accumulated flawed-serve fraction. */
const StrikePips = observer((props: { strikes: number }) => (
  <span className={styles.strikePips}>
    <span>STRIKES</span>
    {Array.from({ length: STRIKES_TO_FAIL }, (_, i) => {
      const filled = props.strikes - i;
      return (
        <span
          key={i}
          className={classNames(styles.pip, {
            [styles.pipLit]: filled >= 1,
            [styles.pipPartial]: filled > 0 && filled < 1,
          })}
        />
      );
    })}
  </span>
));

// ------------------------------------------------------------------------------------------
// Gathering
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
class GatheringPlayersPage extends React.Component<{ appModel?: SushiSyncPresenterModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    return (
      <div>
        <div className={styles.joinHeadline}>SUSHI SYNC</div>
        <div className={styles.joinHint}>
          Everyone sits around this screen and lays their phone face up on the table. Together your
          phones become one conveyor belt.
        </div>
        <p>
          To join: go to http://{window.location.host} and enter room code <b>{appModel.roomId}</b>
        </p>

        {appModel.players.length > 0 ? (
          <div>
            <p style={{ fontWeight: 600 }}>Chefs on shift:</p>
            <div className={styles.playerWrap}>
              {appModel.players.map((player) => (
                <div className={styles.nameBox} key={player.playerId}>
                  <PlayerAvatar avatarId={player.avatarId} size={48} /> {player.name}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {appModel.players.length < appModel.minPlayers ? (
          <div>{`Waiting for at least ${appModel.minPlayers} chefs (${appModel.players.length} so far)...`}</div>
        ) : (
          <button className={styles.presenterButton} onClick={() => appModel.beginSeating()}>
            Assign stations
          </button>
        )}
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------
// Seating - the belt ring, so everyone can physically arrange themselves to match
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
class SeatingPage extends React.Component<{ appModel?: SushiSyncPresenterModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    const seated = appModel.playersByStation;
    const count = Math.max(1, seated.length);

    return (
      <div>
        <div className={styles.joinHeadline}>TAKE YOUR STATIONS</div>
        <div className={styles.joinHint}>
          Sit in this order around the table, going clockwise. Plates travel from station 0 onward
          and loop back around. Not happy? Swap with a neighbor on your phone.
        </div>

        <div className={styles.ringFrame}>
          <div className={styles.ringTrack} />
          <div className={styles.ringCenter}>
            <div>Put this screen in the middle</div>
            <div style={{ marginTop: 16 }}>{seated.length} stations</div>
          </div>
          {seated.map((player) => {
            // Station i is centered on the midpoint of its arc.  -90deg puts station 0 at
            // the top of the ring, which reads as "the head of the table".
            const angle = ((player.stationIndex + 0.5) / count) * 2 * Math.PI - Math.PI / 2;
            const left = 380 + Math.cos(angle) * 330;
            const top = 380 + Math.sin(angle) * 330;
            return (
              <div className={styles.seatChip} key={player.playerId} style={{ left, top }}>
                <div className={styles.seatIndex}>STATION {player.stationIndex}</div>
                <PlayerAvatar avatarId={player.avatarId} size={40} />
                <div>{player.name}</div>
              </div>
            );
          })}
        </div>

        <div style={{ textAlign: "center", marginTop: 20 }}>
          <button onClick={() => appModel.startGame()}>Start the shift</button>
        </div>
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------
// Round briefing - who owns what this round
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
class RoundBriefingPage extends React.Component<{ appModel?: SushiSyncPresenterModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    return (
      <div>
        <div className={styles.joinHeadline}>
          ROUND {appModel.currentRound} of {TOTAL_ROUNDS} &mdash; {appModel.roundConfig.name}
        </div>
        <div className={styles.joinHint}>
          Each ingredient belongs to exactly one chef, so every roll has to be passed along the
          belt. Learn who has what &mdash; you are about to need it. Starting in{" "}
          {appModel.secondsLeftInStage}s.
        </div>

        <div className={styles.briefingTable}>
          {appModel.playersByStation.map((player) => (
            <div className={styles.briefingChef} key={player.playerId}>
              <div className={styles.briefingChefName}>
                <PlayerAvatar avatarId={player.avatarId} size={40} />
                {player.name}
                <span className={styles.seatIndex}>#{player.stationIndex}</span>
              </div>
              <div className={styles.briefingIngredients}>
                {player.ingredientIds.map(ingredientName).join(" · ") || "nothing this round"}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------
// Playing - the order board plus a live belt ring
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
class PlayingPage extends React.Component<{
  appModel?: SushiSyncPresenterModel;
  media: MediaHelper;
}> {
  private renderOrder(order: SushiSyncOrder, now: number) {
    const remaining = Math.max(0, 1 - (now - order.createdAt) / Math.max(1, order.patienceMs));
    const urgent = remaining < URGENT_PATIENCE;
    return (
      <div
        className={classNames(styles.orderCard, { [styles.orderCardUrgent]: urgent })}
        key={order.id}
      >
        <div className={styles.orderTable}>TABLE {order.tableNumber}</div>
        <div className={styles.orderDish}>{order.dishName}</div>
        <div className={styles.orderRecipe}>
          {order.recipe.map((id, i) => (
            <span className={styles.layerChip} key={`${id}-${i}`}>
              {i + 1}. {ingredientName(id)}
            </span>
          ))}
        </div>
        <div className={styles.patienceTrack}>
          <div
            className={classNames(styles.patienceFill, {
              [styles.patienceFillUrgent]: urgent,
            })}
            style={{ width: `${remaining * 100}%` }}
          />
        </div>
      </div>
    );
  }

  private renderBeltRing() {
    const { appModel } = this.props;
    if (!appModel) return null;
    const seated = appModel.playersByStation;
    const count = Math.max(1, appModel.stationCount);

    return (
      <div className={styles.ringFrame} style={{ width: 620, height: 620, flex: "0 0 auto" }}>
        <div className={styles.ringTrack} style={{ inset: 70 }} />
        <div className={styles.ringCenter} style={{ inset: 170 }}>
          <div className={styles.tillAmount}>&yen;{appModel.till}</div>
          <div style={{ fontSize: "80%" }}>{appModel.roundConfig.name}</div>
        </div>

        {seated.map((player) => {
          const angle = ((player.stationIndex + 0.5) / count) * 2 * Math.PI - Math.PI / 2;
          const left = 310 + Math.cos(angle) * 262;
          const top = 310 + Math.sin(angle) * 262;
          return (
            <div
              className={styles.seatChip}
              key={player.playerId}
              style={{ left, top, minWidth: 100, fontSize: "40%" }}
            >
              <div className={styles.seatIndex}>#{player.stationIndex}</div>
              <PlayerAvatar avatarId={player.avatarId} size={30} />
              <div>{player.name}</div>
            </div>
          );
        })}

        {appModel.plates.map((plate) => {
          // A held plate has been lifted OFF the conveyor onto a chef's bench.  Draw it
          // inside the loop, next to whoever is holding it - at the belt radius it reads as
          // still riding the belt, which is exactly the confusion we want to avoid.
          const holder = plate.heldBy
            ? appModel.players.find((p) => p.playerId === plate.heldBy)
            : undefined;
          const pos = holder ? holder.stationIndex + 0.5 : plate.beltPos;
          const radius = holder ? BENCH_RADIUS : BELT_RADIUS;
          const angle = (pos / count) * 2 * Math.PI - Math.PI / 2;
          const left = 310 + Math.cos(angle) * radius;
          const top = 310 + Math.sin(angle) * radius;
          return (
            <div
              className={classNames(styles.beltPlateDot, {
                [styles.beltPlateDotHeld]: !!holder,
              })}
              key={plate.id}
              style={{ left, top }}
              title={
                holder
                  ? `Table ${plate.tableNumber} - on ${holder.name}'s bench`
                  : `Table ${plate.tableNumber}`
              }
            >
              {plate.tableNumber}
            </div>
          );
        })}
      </div>
    );
  }

  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;
    const now = appModel.gameTime_ms;
    const lowTime = appModel.secondsLeftInStage <= 15;

    return (
      <div>
        <div className={styles.statusRail}>
          <span>
            Round {appModel.currentRound}/{TOTAL_ROUNDS}
          </span>
          <span className={classNames(styles.roundClock, { [styles.roundClockLow]: lowTime })}>
            {appModel.secondsLeftInStage}s left
          </span>
          <span className={styles.tillAmount}>&yen;{appModel.till}</span>
          <StrikePips strikes={appModel.strikes} />
        </div>

        <div className={styles.playingGrid}>
          <div className={styles.orderBoard}>
            {appModel.orders.length === 0 ? (
              <div className={styles.emptyBoard}>No customers waiting... yet.</div>
            ) : (
              appModel.orders.map((order) => this.renderOrder(order, now))
            )}
          </div>
          {this.renderBeltRing()}
        </div>
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------
// End of round
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
class EndOfRoundPage extends React.Component<{ appModel?: SushiSyncPresenterModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    return (
      <div>
        <div className={styles.joinHeadline}>{appModel.roundConfig.name} &mdash; service over</div>
        <div className={styles.reportRow}>
          <div className={styles.reportStat}>
            <span className={styles.reportStatLabel}>EARNED</span>
            <span className={styles.tillAmount}>&yen;{appModel.roundEarnings}</span>
          </div>
          <div className={styles.reportStat}>
            <span className={styles.reportStatLabel}>PERFECT</span>
            <span>{appModel.roundPerfect}</span>
          </div>
          <div className={styles.reportStat}>
            <span className={styles.reportStatLabel}>FLAWED</span>
            <span>{appModel.roundFlawed}</span>
          </div>
          <div className={styles.reportStat}>
            <span className={styles.reportStatLabel}>WALKED OUT</span>
            <span>{appModel.roundTimedOut}</span>
          </div>
        </div>
        <div className={styles.joinHint}>
          Ingredients get reshuffled for the next round. Next up in {appModel.secondsLeftInStage}s.
        </div>
        <StrikePips strikes={appModel.strikes} />
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------
// Game over - team result plus the Top Chef crown
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
class GameOverPage extends React.Component<{ appModel?: SushiSyncPresenterModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    const stars = appModel.stars;
    const topChefs = appModel.topChefs;

    return (
      <div>
        <div
          className={classNames(styles.joinHeadline, { [styles.failBanner]: appModel.shiftFailed })}
        >
          {appModel.shiftFailed ? "THREE STRIKES - SHIFT OVER" : "SHIFT COMPLETE"}
        </div>

        <div className={styles.starRow}>
          {"★".repeat(stars)}
          {"☆".repeat(5 - stars)}
        </div>

        <div className={styles.reportRow}>
          <div className={styles.reportStat}>
            <span className={styles.reportStatLabel}>TOTAL TAKINGS</span>
            <span className={styles.tillAmount}>&yen;{appModel.till}</span>
          </div>
          <div className={styles.reportStat}>
            <span className={styles.reportStatLabel}>ROUNDS SURVIVED</span>
            <span>
              {appModel.roundsCompleted}/{TOTAL_ROUNDS}
            </span>
          </div>
        </div>

        {topChefs.length > 0 ? (
          <div className={styles.winnerBanner}>
            {topChefs.map((chef) => (
              <PlayerAvatar avatarId={chef.avatarId} size={64} key={chef.playerId} />
            ))}
            {topChefs.length === 1
              ? `🏆 Top Chef: ${topChefs[0].name}`
              : `🏆 Joint Top Chefs: ${topChefs.map((c) => c.name).join(" & ")}`}
          </div>
        ) : null}

        <table className={styles.statTable}>
          <thead>
            <tr>
              <th>Chef</th>
              <th>Layers</th>
              <th>Served</th>
              <th>Perfect</th>
            </tr>
          </thead>
          <tbody>
            {appModel.playersByStation.map((player) => (
              <tr key={player.playerId}>
                <td>
                  <NameWithAvatar player={player} size={32} />
                </td>
                <td>{player.layersAdded}</td>
                <td>{player.platesServed}</td>
                <td>{player.perfectPlates}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: 24 }}>
          <button onClick={() => appModel.playAgain(false)}>Run it back, same chefs</button>
        </div>
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------
// Paused
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
class PausedGamePage extends React.Component<{ appModel?: SushiSyncPresenterModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;
    return (
      <div>
        <p>{appModel.name} is paused</p>
        <div className={styles.playerWrap}>
          {appModel.players.map((player) => (
            <div className={styles.nameBox} key={player.playerId}>
              <PlayerAvatar avatarId={player.avatarId} size={32} /> {player.name}
            </div>
          ))}
        </div>
        <button
          className={styles.button}
          disabled={appModel.players.length < appModel.minPlayers}
          onClick={() => appModel.resumeGame()}
        >
          Resume Game
        </button>
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------
// Presenter frame
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
export default class Presenter extends React.Component<{
  appModel?: SushiSyncPresenterModel;
  uiProperties: UIProperties;
}> {
  media: MediaHelper;

  constructor(props: Readonly<{ appModel?: SushiSyncPresenterModel; uiProperties: UIProperties }>) {
    super(props);

    const { appModel } = this.props;

    this.media = new MediaHelper();
    for (let soundName in SushiSyncAssets.sounds) {
      this.media.loadSound((SushiSyncAssets.sounds as any)[soundName]);
    }

    const sfxVolume = 1.0;

    // Countdown alert as a round runs out.
    let timeAlertLoaded = false;
    appModel?.onTick.subscribe("Timer Watcher", () => {
      if (appModel!.secondsLeftInStage > 10) timeAlertLoaded = true;
      if (
        appModel!.gameState === SushiSyncGameState.Playing &&
        timeAlertLoaded &&
        appModel!.secondsLeftInStage <= 10
      ) {
        timeAlertLoaded = false;
        this.media.repeatSound("ding.wav", 5, 100);
      }
    });

    // Model events -> sounds.  Audio stays in the view layer, out of the game logic.
    appModel?.subscribe(PresenterGameEvent.PlayerJoined, "play joined sound", () =>
      this.media.playSound(SushiSyncAssets.sounds.hello, { volume: sfxVolume * 0.2 }),
    );
    appModel?.subscribe(SushiSyncGameEvent.RoundStarted, "play round start sound", () =>
      this.media.playSound(SushiSyncAssets.sounds.ding, { volume: sfxVolume * 0.5 }),
    );
    appModel?.subscribe(SushiSyncGameEvent.PlateServed, "play score sound", () =>
      this.media.playSound(SushiSyncAssets.sounds.score, { volume: sfxVolume * 0.6 }),
    );
    appModel?.subscribe(SushiSyncGameEvent.PlateTrashed, "play trash sound", () =>
      this.media.playSound(SushiSyncAssets.sounds.response, { volume: sfxVolume * 0.4 }),
    );
    appModel?.subscribe(SushiSyncGameEvent.OrderTimedOut, "play timeout sound", () =>
      this.media.playSound(SushiSyncAssets.sounds.response, { volume: sfxVolume }),
    );
    appModel?.subscribe(SushiSyncGameEvent.ShiftOver, "play winner sound", () =>
      this.media.playSound(SushiSyncAssets.sounds.winner, { volume: sfxVolume }),
    );
  }

  private renderSubScreen() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    switch (appModel.gameState) {
      case PresenterGameState.Gathering:
        return <GatheringPlayersPage />;
      case SushiSyncGameState.Seating:
        return <SeatingPage />;
      case SushiSyncGameState.RoundBriefing:
        return <RoundBriefingPage />;
      case SushiSyncGameState.Playing:
        return <PlayingPage media={this.media} />;
      case SushiSyncGameState.EndOfRound:
        return <EndOfRoundPage />;
      case GeneralGameState.GameOver:
        return <GameOverPage />;
      case GeneralGameState.Paused:
        return <PausedGamePage />;
      default:
        return <div>Whoops! No display for this state: {appModel.gameState}</div>;
    }
  }

  private renderFrame() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;
    return (
      <div className={classNames(styles.divRow)}>
        <button
          className={classNames(styles.button)}
          style={{ marginRight: "30px" }}
          onClick={() => appModel.quitApp()}
        >
          Quit
        </button>
        <button
          className={classNames(styles.button)}
          disabled={appModel.gameState === PresenterGameState.Gathering}
          style={{ marginRight: "30px" }}
          onClick={() => appModel.pauseGame()}
        >
          Pause
        </button>
        <div className={classNames(styles.roomCode)}>Room Code: {appModel.roomId}</div>
        <DevUI context={appModel} children={<div></div>} />
        <div style={{ marginLeft: "50px" }}>v{SushiSyncVersion}</div>
      </div>
    );
  }

  render() {
    return (
      <UINormalizer
        className={styles.gamepresenter}
        uiProperties={this.props.uiProperties}
        virtualHeight={1080}
        virtualWidth={1920}
      >
        {this.renderFrame()}
        <div style={{ margin: "30px 40px" }}>{this.renderSubScreen()}</div>
      </UINormalizer>
    );
  }
}
