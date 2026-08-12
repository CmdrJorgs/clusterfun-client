// The player's phone.  Two completely different screens behind one model, because this game
// gives two players on the same team deliberately different information:
//
//   Exploring - your own cell and the cells you can reach, in true relative geometry, with
//               no labels of any kind.  You cannot see the field and you cannot see what is
//               buried in anything.
//   Advising  - the whole field, marked up with YOUR fragment of the intel.
//
// Neither screen names a cell.  Agreeing on what to call things is the game (see DESIGN.md),
// so the only thing both screens share for free is orientation: up is up on both.
import React from "react";
import { observer, inject } from "mobx-react";
import styles from "./Client.module.css";
import classNames from "classnames";
import {
  UIProperties,
  GeneralGameState,
  GeneralClientGameState,
  UINormalizer,
  ErrorBoundary,
  ClientHeader,
} from "libs";
import { MINEFIELD_VERSION_HISTORY } from "../models/GameSettings";
import { MinefieldClientModel, MinefieldClientState } from "../models/ClientModel";
import MosaicMap from "./MosaicMap";
import { polyPoints, sharedEdges, viewBoxFor } from "./mapGeometry";

const KILLED_BY_TEXT: Record<string, string> = {
  standard: "You stepped on a mine.",
  multistep: "That mine had nothing left in it.",
  motion: "A motion mine went off beside you.",
  invisible: "Something nobody could see went off beside you.",
};

// -------------------------------------------------------------------
// The explorer's screen.  Everything you are allowed to know, which is not much.
// -------------------------------------------------------------------
@inject("appModel")
@observer
class ExploringPage extends React.Component<{ appModel?: MinefieldClientModel }, { tick: number }> {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(props: { appModel?: MinefieldClientModel }) {
    super(props);
    this.state = { tick: 0 };
  }

  // The freeze countdown runs off the wall clock, so it needs a heartbeat of its own - the
  // model has no observable that changes while a player is simply standing there frozen.
  componentDidMount() {
    this.timer = setInterval(() => {
      if (this.props.appModel?.isFrozen) this.setState({ tick: Date.now() });
    }, 250);
  }

  componentWillUnmount() {
    if (this.timer) clearInterval(this.timer);
  }

  render() {
    const { appModel } = this.props;
    if (!appModel) return null;
    const local = appModel.local;
    const status = appModel.status;

    if (!local) {
      return <div className={styles.waitBig}>Waiting for the field…</div>;
    }

    const polys = [local.here.poly, ...local.options.map((o) => o.poly)];
    const frozen = appModel.isFrozen;

    return (
      <div className={styles.explorer}>
        <div className={styles.statusStrip}>
          <span>💀 {status?.deaths ?? 0}</span>
          <span>{status?.steps ?? 0} steps</span>
          {(status?.armedCount ?? 0) > 0 && <span className={styles.armed}>⚠ ARMED</span>}
        </div>

        <div className={styles.localWrap}>
          <svg className={styles.localMap} viewBox={viewBoxFor(polys, 30, 0.82)}>
            {/* Reachable cells - tap one. No names, no hints, just the shapes. */}
            {local.options.map((option) => (
              <polygon
                key={option.id}
                points={polyPoints(option.poly)}
                fill={option.walled ? "#1a1508" : option.visited ? "#1b2118" : "#16301f"}
                stroke={option.walled ? "#5c4a15" : "#4dff9e"}
                strokeWidth={5}
                opacity={frozen ? 0.4 : 1}
                className={option.walled || frozen ? styles.cellBlocked : styles.cellOpen}
                onClick={() => {
                  if (!option.walled && !frozen) appModel.doMove(option.id);
                }}
              />
            ))}

            {/* Where you are standing */}
            <polygon
              points={polyPoints(local.here.poly)}
              fill="#0d1a2a"
              stroke={appModel.teamColor}
              strokeWidth={8}
            />
            <circle
              cx={local.here.cx}
              cy={local.here.cy}
              r={16}
              fill={appModel.teamColor}
              stroke="#05070a"
              strokeWidth={4}
            />
            {local.onGoal && (
              <text x={local.here.cx} y={local.here.cy - 30} textAnchor="middle" fontSize={44}>
                ⚑
              </text>
            )}
            {local.onStart && !local.onGoal && (
              <text
                x={local.here.cx}
                y={local.here.cy - 30}
                textAnchor="middle"
                fontSize={40}
                fill="#7fb7ff"
              >
                ★
              </text>
            )}

            {/* Walls are physically visible - it is the SWITCH that is a secret. */}
            {local.options
              .filter((option) => option.walled)
              .map((option) =>
                sharedEdges(local.here.poly, option.poly).map(([p, q], index) => (
                  <line
                    key={`w-${option.id}-${index}`}
                    x1={p.x}
                    y1={p.y}
                    x2={q.x}
                    y2={q.y}
                    stroke="#ffd24a"
                    strokeWidth={14}
                    strokeLinecap="round"
                  />
                )),
              )}
          </svg>

          {frozen && (
            <div className={styles.freezeOverlay}>
              <div className={styles.freezeIcon}>❄</div>
              <div className={styles.freezeCount}>{appModel.frozenSecondsLeft}</div>
              <div>Frozen — you cannot move</div>
            </div>
          )}
        </div>

        <div className={styles.hint}>
          Tap a shape to step onto it. Describe them out loud — nobody else can see what you see.
        </div>

        {appModel.lastOutcome === "dead" && (
          <button className={styles.banner} onClick={appModel.acknowledgeOutcome}>
            <div className={styles.bannerTitle}>💥 YOU DIED</div>
            <div>{KILLED_BY_TEXT[appModel.killedBy] ?? "Something got you."}</div>
            <div className={styles.bannerHint}>Back to the start. Tap to continue.</div>
          </button>
        )}
        {appModel.lastOutcome === "goal" && (
          <button className={styles.bannerGood} onClick={appModel.acknowledgeOutcome}>
            <div className={styles.bannerTitle}>⚑ YOU MADE IT</div>
            <div className={styles.bannerHint}>Tap to continue.</div>
          </button>
        )}
        {appModel.lastOutcome === "blocked" && (
          <button className={styles.bannerWarn} onClick={appModel.acknowledgeOutcome}>
            <div>Blocked — there is a wall in the way.</div>
          </button>
        )}
      </div>
    );
  }
}

// -------------------------------------------------------------------
// The advisor's screen: the whole field, with their fragment of the intel on it.
// -------------------------------------------------------------------
@inject("appModel")
@observer
class AdvisingPage extends React.Component<{ appModel?: MinefieldClientModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return null;
    if (!appModel.field) return <div className={styles.waitBig}>Waiting for intel…</div>;

    const intelCount = appModel.field.hazards.length + appModel.field.walls.length;

    return (
      <div className={styles.advisor}>
        <div className={styles.statusStrip}>
          <span>{appModel.explorerName || "explorer"} is walking</span>
          <span>💀 {appModel.status?.deaths ?? 0}</span>
          {(appModel.status?.armedCount ?? 0) > 0 && <span className={styles.armed}>⚠ ARMED</span>}
        </div>

        <MosaicMap
          className={styles.advisorMap}
          field={appModel.field}
          status={appModel.status}
          teamColor={appModel.teamColor}
          revealed={appModel.revealed}
          aspect={0.78}
        />

        <div className={styles.legend}>
          <span>
            <b style={{ color: "#ff4646" }}>◉</b> mine
          </span>
          <span>
            <b style={{ color: "#ffb020" }}>3</b> steps left in it
          </span>
          <span>
            <b style={{ color: "#6fe8ff" }}>❄</b> freeze
          </span>
          <span>
            <b style={{ color: "#ff8a2b" }}>◎</b> motion
          </span>
          <span>
            <b style={{ color: "#ffd24a" }}>◈</b> switch
          </span>
        </div>
        <div className={styles.hint}>
          {appModel.revealed
            ? "The whole field, declassified. This is what you were walking through."
            : `You hold ${intelCount} piece${intelCount === 1 ? "" : "s"} of intel${
                appModel.advisorCount > 1 ? " — your team has the rest" : ""
              }. The dashed cells are what they can reach. Talk.`}
        </div>
      </div>
    );
  }
}

// -------------------------------------------------------------------
// Briefing and between-rounds
// -------------------------------------------------------------------
@inject("appModel")
@observer
class BriefingPage extends React.Component<{ appModel?: MinefieldClientModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return null;
    const isExplorer = appModel.role === "explorer";
    return (
      <div className={styles.centered}>
        <div className={styles.roleTag} style={{ color: appModel.teamColor }}>
          {appModel.teamName}
        </div>
        <div className={styles.roleTitle}>
          {isExplorer ? "YOU ARE THE EXPLORER" : "YOU ARE AN ADVISOR"}
        </div>
        <div className={styles.roleBody}>
          {isExplorer ? (
            <>
              You walk the field. You will only ever see the cells you can reach — not the map, and
              not what is buried in anything. Describe what you see and do what you are told.
            </>
          ) : (
            <>
              You get the map, marked with part of the intel. Nobody has all of it, so pool what you
              have with the rest of your team and talk {appModel.explorerName || "them"} across.
            </>
          )}
        </div>
        <div className={styles.roundTag}>
          Round {appModel.roundNumber} of {appModel.totalRounds}
        </div>
      </div>
    );
  }
}

@inject("appModel")
@observer
class RoundScorePage extends React.Component<{ appModel?: MinefieldClientModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return null;
    return (
      <div className={styles.scorePage}>
        <div className={styles.roleTitle}>ROUND {appModel.roundNumber}</div>
        {appModel.field ? (
          <MosaicMap
            className={styles.advisorMap}
            field={appModel.field}
            status={appModel.status}
            teamColor={appModel.teamColor}
            revealed={true}
            aspect={0.9}
          />
        ) : (
          <div className={styles.roleBody}>Watch the big screen.</div>
        )}
        <div className={styles.standings}>
          {appModel.standings.map((team) => (
            <div key={team.teamId} className={styles.standingRow}>
              <span style={{ color: team.teamColor }}>{team.teamName}</span>
              <span>{team.score}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
}

// -------------------------------------------------------------------
// Client shell
// -------------------------------------------------------------------
@inject("appModel")
@observer
class GameScreen extends React.Component<{ appModel?: MinefieldClientModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    switch (appModel.gameState) {
      case MinefieldClientState.Briefing:
        return <BriefingPage />;
      case MinefieldClientState.Exploring:
        return <ExploringPage />;
      case MinefieldClientState.Advising:
        return <AdvisingPage />;
      case MinefieldClientState.RoundScore:
        return <RoundScorePage />;
      case GeneralClientGameState.WaitingToStart:
        return (
          <div className={styles.centered}>
            <div className={styles.roleTitle}>STAND BY</div>
            <div className={styles.roleBody}>
              You are in. Watch the big screen — the host starts when everyone has joined.
            </div>
          </div>
        );
      case GeneralClientGameState.JoinError:
        return <div className={styles.centered}>Could not join: {appModel.joinError}</div>;
      case GeneralGameState.GameOver:
        return (
          <div className={styles.centered}>
            <div className={styles.roleTitle}>GAME OVER</div>
            <div className={styles.standings}>
              {appModel.standings.map((team) => (
                <div key={team.teamId} className={styles.standingRow}>
                  <span style={{ color: team.teamColor }}>{team.teamName}</span>
                  <span>{team.score}</span>
                </div>
              ))}
            </div>
          </div>
        );
      case GeneralClientGameState.Paused:
        return <div className={styles.centered}>Paused — waiting for the host.</div>;
      default:
        return <div className={styles.centered}>Stand by…</div>;
    }
  }
}

@inject("appModel")
@observer
export default class Client extends React.Component<{
  appModel?: MinefieldClientModel;
  uiProperties: UIProperties;
}> {
  render() {
    const { appModel } = this.props;
    return (
      <UINormalizer
        className={styles.gameclient}
        backdropClassName={styles.gameclient}
        uiProperties={this.props.uiProperties}
        virtualHeight={1920}
        virtualWidth={1080}
      >
        <div className={classNames(styles.gameclient)}>
          <ClientHeader
            className={styles.topbar}
            title={appModel?.teamName || "Minefield"}
            history={MINEFIELD_VERSION_HISTORY}
            avatarId={appModel?.avatarId ?? 0}
            avatarColor={appModel?.avatarColor}
            playerName={appModel?.playerName}
            onQuit={() => appModel?.quitApp()}
          />
          <div className={styles.body}>
            <ErrorBoundary>
              <GameScreen />
            </ErrorBoundary>
          </div>
        </div>
      </UINormalizer>
    );
  }
}
