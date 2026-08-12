// The shared-screen view.  One page component per presenter game state, chosen by
// renderSubScreen().  All observers over the presenter model - they render state, never own it.
//
// The big screen is DELIBERATELY ignorant about the field: it draws the silhouette, the
// start, the goal and each team's trail, and nothing else.  Cells, hazards and walls never
// appear here, because everyone in the room can see this screen and half of them are not
// supposed to know what is buried where.
import React from "react";
import { observer, inject } from "mobx-react";
import styles from "./Presenter.module.css";
import classNames from "classnames";
import MinefieldAssets from "../assets/Assets";
import {
  DIFFICULTY_PRESETS,
  MAX_TEAMS,
  MINEFIELD_VERSION_HISTORY,
  TEAM_COLORS,
  TEAM_NAMES,
} from "../models/GameSettings";
import {
  MediaHelper,
  UIProperties,
  PresenterGameEvent,
  PresenterGameState,
  GeneralGameState,
  DevUI,
  UINormalizer,
  PlayerAvatar,
  GameVersionTag,
} from "libs";
import {
  MinefieldPresenterModel,
  MinefieldGameState,
  MinefieldGameEvent,
  MinefieldTeam,
} from "../models/PresenterModel";
import { MapPoint } from "../models/minefieldMap";
import { Pt, polyPoints, trailPoints, viewBoxFor } from "./mapGeometry";

const flatten = (points: MapPoint[]): number[] => {
  const out: number[] = [];
  for (const p of points) out.push(p.x, p.y);
  return out;
};

// -------------------------------------------------------------------
// The silhouette.  Shape, start, goal, and where everybody is - and that is the whole
// contract.  A rival's ghost trail with a skull on the end is the one legitimate way to
// learn where a mine is without an advisor telling you, which is why it is drawn.
// -------------------------------------------------------------------
@inject("appModel")
@observer
class SilhouetteMap extends React.Component<{ appModel?: MinefieldPresenterModel }> {
  render() {
    const { appModel } = this.props;
    const map = appModel?.currentMap;
    if (!appModel || !map) return <div className={styles.mapPlaceholder}>NO FIELD</div>;

    const centers = new Map<number, Pt>(map.cells.map((c) => [c.id, c.center]));
    const rings = map.outline.map(flatten);
    const start = centers.get(map.startCell);
    const goal = centers.get(map.goalCell);

    return (
      <svg className={styles.silhouette} viewBox={viewBoxFor(rings, 40, 1.35)}>
        {rings.map((ring, index) => (
          <polygon
            key={index}
            points={polyPoints(ring)}
            fill={index === 0 ? "#0f1410" : "#05070a"}
            stroke="#4dff9e"
            strokeWidth={index === 0 ? 7 : 4}
            opacity={index === 0 ? 1 : 0.75}
          />
        ))}

        {appModel.teams.map((team) => {
          const color = TEAM_COLORS[team.teamId] ?? "#ffffff";
          const here = centers.get(team.run.cell);
          return (
            <g key={team.teamId}>
              {team.run.ghosts.map((ghost, index) => (
                <g key={index}>
                  <polyline
                    points={trailPoints(centers, ghost)}
                    fill="none"
                    stroke={color}
                    strokeWidth={5}
                    opacity={0.2}
                    strokeDasharray="8 12"
                  />
                  {centers.has(ghost[ghost.length - 1]) && (
                    <text
                      x={centers.get(ghost[ghost.length - 1])!.x}
                      y={centers.get(ghost[ghost.length - 1])!.y + 12}
                      textAnchor="middle"
                      fontSize={34}
                      opacity={0.65}
                    >
                      💀
                    </text>
                  )}
                </g>
              ))}
              <polyline
                points={trailPoints(centers, team.run.path)}
                fill="none"
                stroke={color}
                strokeWidth={9}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.95}
              />
              {here && (
                <>
                  <circle
                    cx={here.x}
                    cy={here.y}
                    r={20}
                    fill={color}
                    stroke="#05070a"
                    strokeWidth={5}
                  />
                  {team.run.armed.length > 0 && (
                    <circle
                      cx={here.x}
                      cy={here.y}
                      r={34}
                      fill="none"
                      stroke="#ff6a2b"
                      strokeWidth={6}
                    />
                  )}
                </>
              )}
            </g>
          );
        })}

        {start && (
          <text x={start.x} y={start.y + 16} textAnchor="middle" fontSize={54} fill="#7fb7ff">
            ★
          </text>
        )}
        {goal && (
          <text x={goal.x} y={goal.y + 18} textAnchor="middle" fontSize={58} fill="#7dff8a">
            ⚑
          </text>
        )}
      </svg>
    );
  }
}

// -------------------------------------------------------------------
// Setup: difficulty, teams, and who is walking.
// -------------------------------------------------------------------
@inject("appModel")
@observer
class GatheringPage extends React.Component<
  { appModel?: MinefieldPresenterModel },
  { advanced: boolean }
> {
  constructor(props: { appModel?: MinefieldPresenterModel }) {
    super(props);
    this.state = { advanced: false };
  }

  private knob(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    apply: (v: number) => void,
  ) {
    return (
      <div className={styles.knob} key={label}>
        <span className={styles.knobLabel}>{label}</span>
        <button className={styles.knobButton} onClick={() => apply(Math.max(min, value - step))}>
          –
        </button>
        <span className={styles.knobValue}>{step < 1 ? `${Math.round(value * 100)}%` : value}</span>
        <button className={styles.knobButton} onClick={() => apply(Math.min(max, value + step))}>
          +
        </button>
      </div>
    );
  }

  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;
    const d = appModel.difficulty;

    return (
      <div className={styles.setup}>
        <div className={styles.joinPanel}>
          <div className={styles.bigTitle}>MINEFIELD</div>
          <div className={styles.joinLine}>
            Join at <b>{window.location.host}</b> with room code <b>{appModel.roomId}</b>
          </div>
          <div className={styles.pitch}>
            One of you walks it blind. The rest of you can see the mines — but only some of them.
            Talk fast.
          </div>
          <div className={styles.roster}>
            {appModel.players.length === 0 && (
              <span className={styles.dim}>Waiting for players…</span>
            )}
            {appModel.players.map((player) => (
              <div className={styles.nameBox} key={player.playerId}>
                <PlayerAvatar
                  avatarId={player.avatarId}
                  colorIndex={player.avatarColor}
                  size={44}
                />
                <span className={player.isConnected ? "" : styles.dim}>{player.name}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.controlPanel}>
          <div className={styles.sectionTitle}>DIFFICULTY</div>
          <div className={styles.presetRow}>
            {DIFFICULTY_PRESETS.map((preset, index) => (
              <button
                key={preset.name}
                className={classNames(
                  styles.preset,
                  appModel.difficultyIndex === index && styles.presetOn,
                )}
                onClick={() => appModel.setDifficultyIndex(index)}
              >
                {preset.name}
              </button>
            ))}
          </div>
          <div className={styles.blurb}>
            <b>{d.name}</b> — {d.blurb}
          </div>

          <button
            className={styles.advancedToggle}
            onClick={() => this.setState({ advanced: !this.state.advanced })}
          >
            {this.state.advanced ? "▾" : "▸"} Advanced
          </button>
          {this.state.advanced && (
            <div className={styles.knobs}>
              {this.knob("Mines", d.mineCount, 0, 40, 1, (v) =>
                appModel.updateDifficulty({ mineCount: v }),
              )}
              {this.knob("Mine types", d.mineKinds, 1, 5, 1, (v) =>
                appModel.updateDifficulty({ mineKinds: v }),
              )}
              {this.knob("Missing cells", d.holeCount, 0, 8, 1, (v) =>
                appModel.updateDifficulty({ holeCount: v }),
              )}
              {this.knob("Walls", d.wallCount, 0, 3, 1, (v) =>
                appModel.updateDifficulty({ wallCount: v }),
              )}
              {this.knob("Viable paths", d.viablePaths, 1, 4, 1, (v) =>
                appModel.updateDifficulty({ viablePaths: v }),
              )}
              {this.knob("Intel overlap", d.intelOverlap, 0, 1, 0.25, (v) =>
                appModel.updateDifficulty({ intelOverlap: v }),
              )}
            </div>
          )}

          <div className={styles.sectionTitle}>TEAMS</div>
          <div className={styles.presetRow}>
            {Array.from({ length: MAX_TEAMS }, (_, i) => i + 1).map((count) => (
              <button
                key={count}
                className={classNames(
                  styles.preset,
                  appModel.teamCount === count && styles.presetOn,
                )}
                onClick={() => appModel.setTeamCount(count)}
              >
                {count}
              </button>
            ))}
            <button
              className={styles.advancedToggle}
              onClick={() => appModel.randomizeAllExplorers()}
            >
              🎲 Random explorers
            </button>
          </div>

          <div className={styles.teamGrid}>
            {appModel.teams.map((team) => (
              <TeamSetupCard key={team.teamId} team={team} />
            ))}
          </div>

          <button
            className={styles.startButton}
            disabled={appModel.players.length < appModel.minPlayers}
            onClick={() => appModel.startGame()}
          >
            {appModel.players.length < appModel.minPlayers
              ? `Need ${appModel.minPlayers} players`
              : "START"}
          </button>
        </div>
      </div>
    );
  }
}

@inject("appModel")
@observer
class TeamSetupCard extends React.Component<{
  appModel?: MinefieldPresenterModel;
  team: MinefieldTeam;
}> {
  render() {
    const { appModel, team } = this.props;
    if (!appModel) return null;
    const members = appModel.teamMembers(team.teamId);
    const color = TEAM_COLORS[team.teamId] ?? "#fff";

    return (
      <div className={styles.teamCard} style={{ borderColor: color }}>
        <div className={styles.teamName} style={{ color }}>
          {TEAM_NAMES[team.teamId] ?? `Team ${team.teamId + 1}`}
        </div>
        {members.length === 0 && <div className={styles.dim}>nobody yet</div>}
        {members.map((player) => (
          <button
            key={player.playerId}
            className={classNames(
              styles.memberRow,
              team.explorerId === player.playerId && styles.memberExplorer,
            )}
            onClick={() => appModel.setExplorer(team.teamId, player.playerId)}
          >
            <PlayerAvatar avatarId={player.avatarId} colorIndex={player.avatarColor} size={32} />
            <span>{player.name}</span>
            {team.explorerId === player.playerId && (
              <span className={styles.bootTag}>EXPLORER</span>
            )}
          </button>
        ))}
        {members.length > 0 && (
          <button
            className={styles.advancedToggle}
            onClick={() => appModel.randomizeExplorer(team.teamId)}
          >
            🎲 random
          </button>
        )}
      </div>
    );
  }
}

// -------------------------------------------------------------------
// Briefing: who is walking, and one last look at the shape before it starts.
// -------------------------------------------------------------------
@inject("appModel")
@observer
class BriefingPage extends React.Component<{ appModel?: MinefieldPresenterModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return null;
    return (
      <div className={styles.playArea}>
        <div className={styles.mapPane}>
          <SilhouetteMap />
        </div>
        <div className={styles.sidePane}>
          <div className={styles.roundTag}>
            ROUND {appModel.currentRound} / {appModel.totalRounds}
          </div>
          <div className={styles.briefTitle}>BRIEFING</div>
          <div className={styles.pitch}>
            Explorers: your phone shows only what you can reach. Advisors: you each hold part of the
            map. Nothing is labelled — agree on what to call things.
          </div>
          {appModel.teams.map((team) => {
            const explorer = appModel.explorerOf(team);
            return (
              <div
                key={team.teamId}
                className={styles.briefTeam}
                style={{ borderColor: TEAM_COLORS[team.teamId] }}
              >
                <span style={{ color: TEAM_COLORS[team.teamId] }}>
                  {TEAM_NAMES[team.teamId] ?? `Team ${team.teamId + 1}`}
                </span>
                <span className={styles.bootTag}>
                  {explorer ? `${explorer.name} is walking` : "no explorer"}
                </span>
                <span className={styles.dim}>{appModel.advisorsOf(team).length} advising</span>
              </div>
            );
          })}
          <div className={styles.clock}>{appModel.secondsLeftInStage}</div>
        </div>
      </div>
    );
  }
}

// -------------------------------------------------------------------
// The round itself.
// -------------------------------------------------------------------
@inject("appModel")
@observer
class RunningPage extends React.Component<{ appModel?: MinefieldPresenterModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return null;
    const minutes = Math.floor(appModel.secondsLeftInStage / 60);
    const seconds = `${appModel.secondsLeftInStage % 60}`.padStart(2, "0");

    return (
      <div className={styles.playArea}>
        <div className={styles.mapPane}>
          <SilhouetteMap />
        </div>
        <div className={styles.sidePane}>
          <div className={styles.roundTag}>
            ROUND {appModel.currentRound} / {appModel.totalRounds}
          </div>
          <div
            className={classNames(styles.clock, appModel.secondsLeftInStage <= 30 && styles.urgent)}
          >
            {minutes}:{seconds}
          </div>
          {appModel.teams.map((team) => {
            const explorer = appModel.explorerOf(team);
            const color = TEAM_COLORS[team.teamId] ?? "#fff";
            return (
              <div key={team.teamId} className={styles.liveTeam} style={{ borderColor: color }}>
                <div className={styles.liveTeamHead}>
                  <span style={{ color }}>
                    {TEAM_NAMES[team.teamId] ?? `Team ${team.teamId + 1}`}
                  </span>
                  {team.run.reachedGoal && <span className={styles.homeTag}>HOME</span>}
                  {team.run.armed.length > 0 && !team.run.reachedGoal && (
                    <span className={styles.armedTag}>⚠ MINE ARMED</span>
                  )}
                </div>
                <div className={styles.liveTeamBody}>
                  <span className={explorer?.isConnected === false ? styles.warn : ""}>
                    {explorer
                      ? explorer.isConnected
                        ? explorer.name
                        : `${explorer.name} — DISCONNECTED`
                      : "no explorer"}
                  </span>
                  <span className={styles.dim}>
                    💀 {team.run.deaths} · {team.run.steps} steps
                  </span>
                </div>
                {explorer && !explorer.isConnected && (
                  <button
                    className={styles.advancedToggle}
                    onClick={() => appModel.randomizeExplorer(team.teamId)}
                  >
                    Reassign explorer
                  </button>
                )}
              </div>
            );
          })}
          <button className={styles.advancedToggle} onClick={() => appModel.skipRound()}>
            Skip round
          </button>
        </div>
      </div>
    );
  }
}

// -------------------------------------------------------------------
// Between rounds, and the end.
// -------------------------------------------------------------------
@inject("appModel")
@observer
class RoundScorePage extends React.Component<{ appModel?: MinefieldPresenterModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return null;
    return (
      <div className={styles.playArea}>
        <div className={styles.mapPane}>
          <SilhouetteMap />
        </div>
        <div className={styles.sidePane}>
          <div className={styles.briefTitle}>ROUND {appModel.currentRound}</div>
          <div className={styles.pitch}>
            Field declassified — check your phone to see what you were walking through.
          </div>
          {appModel.roundRankedTeams.map((team) => (
            <div
              key={team.teamId}
              className={styles.liveTeam}
              style={{ borderColor: TEAM_COLORS[team.teamId] }}
            >
              <div className={styles.liveTeamHead}>
                <span style={{ color: TEAM_COLORS[team.teamId] }}>
                  {TEAM_NAMES[team.teamId] ?? `Team ${team.teamId + 1}`}
                </span>
                <span className={styles.score}>{team.score}</span>
              </div>
              <div className={styles.liveTeamBody}>
                <span>{team.run.reachedGoal ? "Reached the goal" : "Did not make it"}</span>
                <span className={styles.dim}>
                  💀 {team.run.deaths} · {team.run.steps} steps
                </span>
              </div>
            </div>
          ))}
          <div className={styles.clock}>{appModel.secondsLeftInStage}</div>
        </div>
      </div>
    );
  }
}

@inject("appModel")
@observer
class GameOverPage extends React.Component<{ appModel?: MinefieldPresenterModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return null;
    const winners = appModel.winners;
    return (
      <div className={styles.gameOver}>
        <div className={styles.bigTitle}>
          {winners.length === 1 ? `${TEAM_NAMES[winners[0].teamId] ?? "Team"} WINS` : "IT'S A DRAW"}
        </div>
        <div className={styles.finalGrid}>
          {appModel.rankedTeams.map((team) => (
            <div
              key={team.teamId}
              className={styles.teamCard}
              style={{ borderColor: TEAM_COLORS[team.teamId] }}
            >
              <div className={styles.teamName} style={{ color: TEAM_COLORS[team.teamId] }}>
                {TEAM_NAMES[team.teamId] ?? `Team ${team.teamId + 1}`}
              </div>
              <div className={styles.score}>{team.score}</div>
              {appModel.teamMembers(team.teamId).map((player) => (
                <div className={styles.nameBox} key={player.playerId}>
                  <PlayerAvatar
                    avatarId={player.avatarId}
                    colorIndex={player.avatarColor}
                    size={36}
                  />
                  <span>{player.name}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <button className={styles.startButton} onClick={() => appModel.playAgain(false)}>
          PLAY AGAIN
        </button>
      </div>
    );
  }
}

// -------------------------------------------------------------------
// Presenter shell
// -------------------------------------------------------------------
@inject("appModel")
@observer
export default class Presenter extends React.Component<{
  appModel?: MinefieldPresenterModel;
  uiProperties: UIProperties;
}> {
  media: MediaHelper;

  constructor(props: Readonly<{ appModel?: MinefieldPresenterModel; uiProperties: UIProperties }>) {
    super(props);
    const { appModel } = this.props;

    this.media = new MediaHelper();
    for (let soundName in MinefieldAssets.sounds) {
      this.media.loadSound((MinefieldAssets.sounds as any)[soundName]);
    }
    const sfxVolume = 1.0;

    // Model events -> sounds. Audio stays in the view layer, out of the game logic.
    appModel?.subscribe(PresenterGameEvent.PlayerJoined, "play joined sound", () =>
      this.media.playSound(MinefieldAssets.sounds.hello, { volume: sfxVolume * 0.2 }),
    );
    appModel?.subscribe(MinefieldGameEvent.TeamStepped, "play step sound", () =>
      this.media.playSound(MinefieldAssets.sounds.ding, { volume: sfxVolume * 0.18 }),
    );
    appModel?.subscribe(MinefieldGameEvent.TeamArmedMine, "play armed sound", () =>
      this.media.repeatSound(MinefieldAssets.sounds.ding, 2, 120),
    );
    appModel?.subscribe(MinefieldGameEvent.TeamThrewSwitch, "play switch sound", () =>
      this.media.playSound(MinefieldAssets.sounds.response, { volume: sfxVolume * 0.7 }),
    );
    appModel?.subscribe(MinefieldGameEvent.TeamFroze, "play freeze sound", () =>
      this.media.playSound(MinefieldAssets.sounds.response, { volume: sfxVolume * 0.5 }),
    );
    appModel?.subscribe(MinefieldGameEvent.TeamDied, "play death sound", () =>
      this.media.repeatSound(MinefieldAssets.sounds.ding, 5, 70),
    );
    appModel?.subscribe(MinefieldGameEvent.TeamReachedGoal, "play goal sound", () =>
      this.media.playSound(MinefieldAssets.sounds.score, { volume: sfxVolume * 0.8 }),
    );
    appModel?.subscribe(MinefieldGameEvent.WinnerAnnounced, "play winner sound", () =>
      this.media.playSound(MinefieldAssets.sounds.winner, { volume: sfxVolume }),
    );
  }

  private renderSubScreen() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    switch (appModel.gameState) {
      case PresenterGameState.Gathering:
        return <GatheringPage />;
      case MinefieldGameState.Briefing:
        return <BriefingPage />;
      case MinefieldGameState.Running:
        return <RunningPage />;
      case MinefieldGameState.RoundScore:
        return <RoundScorePage />;
      case GeneralGameState.GameOver:
        return <GameOverPage />;
      case GeneralGameState.Paused:
        return (
          <div className={styles.gameOver}>
            <div className={styles.bigTitle}>PAUSED</div>
            <button className={styles.startButton} onClick={() => appModel.resumeGame()}>
              Resume
            </button>
          </div>
        );
      default:
        return <div>Unexpected state: {appModel.gameState}</div>;
    }
  }

  private renderFrame() {
    const { appModel } = this.props;
    if (!appModel) return null;
    return (
      <div className={styles.frame}>
        <button className={styles.frameButton} onClick={() => appModel.quitApp()}>
          Quit
        </button>
        <button
          className={styles.frameButton}
          disabled={appModel.gameState === PresenterGameState.Gathering}
          onClick={() => appModel.pauseGame()}
        >
          Pause
        </button>
        <div className={styles.frameSpacer} />
        <div className={styles.frameRoom}>Room {appModel.roomId}</div>
        <DevUI context={appModel} children={<div></div>} />
        <GameVersionTag title="Minefield" history={MINEFIELD_VERSION_HISTORY} showChanges />
      </div>
    );
  }

  render() {
    return (
      <UINormalizer
        className={styles.gamepresenter}
        backdropClassName={styles.gamepresenter}
        uiProperties={this.props.uiProperties}
        virtualHeight={1080}
        virtualWidth={1920}
      >
        {this.renderFrame()}
        <div className={styles.stage}>{this.renderSubScreen()}</div>
      </UINormalizer>
    );
  }
}
