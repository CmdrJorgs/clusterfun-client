// The chef's phone.  One sub-screen per client game state, chosen by renderSubScreen().
//
// Keep this thin: it captures taps and shows feedback, the presenter owns the real game.
// Note what is deliberately NOT here - the recipe.  A plate shows its table number and its
// current layer stack; to learn what Table 3 actually ordered you have to look at the shared
// screen or ask someone.  That is the whole co-op tension (see DESIGN.md).
import React from "react";
import { observer, inject } from "mobx-react";
import { SushiSyncClientModel, SushiSyncClientState } from "../models/ClientModel";
import styles from "./Client.module.css";
import classNames from "classnames";
import {
  UIProperties,
  GeneralGameState,
  SafeBrowser,
  GeneralClientGameState,
  ScaleToWidth,
  ErrorBoundary,
  PlayerAvatar,
} from "libs";
import { ingredientName, progressAcrossStation } from "../models/sushiSyncLogic";
import { ART_INGREDIENT_IDS } from "../models/plateArt";
import { IngredientSwatch, SushiPlate, preloadPlateArt } from "./SushiPlate";
import Logger from "js-logger";

// Rendered widths, in the phone's 1080-wide virtual canvas.  The hero plate is sized so the
// 512px source art lands at roughly 1:1 on a typical high-DPI phone rather than being
// upscaled - see ASSETS.md for the pixel budget behind these numbers.
const HERO_PLATE_ART_SIZE = 460;
const BELT_PLATE_ART_SIZE = 150;

// ------------------------------------------------------------------------------------------
// Seating - the physical arrangement step
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
class SeatingScreen extends React.Component<{ appModel?: SushiSyncClientModel }> {
  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    return (
      <div className={styles.centerPanel}>
        <div className={styles.sectionLabel}>YOUR STATION</div>
        <div className={styles.bigStation}>
          {appModel.stationIndex}{" "}
          <span style={{ fontSize: "50%" }}>of {appModel.stationCount}</span>
        </div>

        <div className={styles.neighborRow}>
          <span>&larr; {appModel.leftNeighborName || "?"}</span>
          <span className={styles.neighborYou}>YOU</span>
          <span>{appModel.rightNeighborName || "?"} &rarr;</span>
        </div>

        <div className={styles.subtle}>
          Sit so the table matches this order, going clockwise. Plates travel from your left
          neighbor to you, then on to your right.
        </div>

        <div className={styles.swapRow}>
          <button onClick={() => appModel.swapStation("left")}>
            Swap with {appModel.leftNeighborName || "left"}
          </button>
          <button onClick={() => appModel.swapStation("right")}>
            Swap with {appModel.rightNeighborName || "right"}
          </button>
        </div>
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------
// Briefing - your exclusive ingredients this round
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
class BriefingScreen extends React.Component<{ appModel?: SushiSyncClientModel }> {
  // Warm the image cache while the chef reads their ingredient list, so no layer pops in
  // mid-service.  Preloads EVERY ingredient rather than just this chef's own: plates crossing
  // my segment arrive carrying whatever the chefs upstream put on them, and the phone is not
  // told which ingredients are active this round.  The full set is 13 small files, so this is
  // cheaper than widening the onboard payload just to carry a cache hint.
  componentDidMount() {
    preloadPlateArt(ART_INGREDIENT_IDS);
  }

  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    return (
      <div className={styles.centerPanel}>
        <div className={styles.sectionLabel}>ROUND {appModel.roundNumber}</div>
        <div className={styles.bigStation} style={{ fontSize: "110%" }}>
          {appModel.roundName}
        </div>

        <div className={styles.sectionLabel}>YOU ARE THE ONLY CHEF WITH</div>
        <div className={styles.briefingList}>
          {appModel.myIngredients.length > 0
            ? appModel.myIngredients.map((i) => (
                <span className={styles.briefingIngredient} key={i.id}>
                  <IngredientSwatch id={i.id} size={120} />
                  {i.name}
                </span>
              ))
            : "nothing this round - help call out orders!"}
        </div>

        <div className={styles.subtle}>
          Nobody else can add these. Watch the big screen for what each table ordered.
        </div>
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------
// Playing - belt zone on top, workstation below
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
class GameScreen extends React.Component<{ appModel?: SushiSyncClientModel }> {
  // Belt extrapolation is driven by the model's own onTick subscription (see
  // SushiSyncClientModel.handleBeltTick).  It deliberately does NOT live here: onTick
  // carries absolute game time rather than a frame delta, and a component constructor
  // can run more than once, which would compound the error.

  private renderBeltZone() {
    const { appModel } = this.props;
    if (!appModel) return null;
    const plates = appModel.platesInMyZone;

    return (
      <div className={styles.beltZone}>
        <div className={styles.beltZoneLabel}>CONVEYOR</div>
        <div className={styles.beltRail} />
        {plates.length === 0 ? (
          <div className={styles.beltEmpty}>belt is clear...</div>
        ) : (
          plates.map((plate) => {
            // Progress across MY segment maps directly to horizontal screen position, so a
            // plate leaves my right edge as it enters my neighbor's left edge.
            const fraction = progressAcrossStation(plate.pos, appModel.stationCount);
            // needsYou is only ever populated when the presenter has the soft-mode setting
            // on; in hard mode (the default) no plate is ever highlighted.
            const mine = appModel.showMyTurnHighlight && !!plate.needsYou;
            return (
              <div
                className={classNames(styles.beltPlate, { [styles.beltPlateMine]: mine })}
                key={plate.id}
                style={{ left: `${fraction * 100}%` }}
                onClick={() => appModel.pullPlate(plate.id)}
              >
                <SushiPlate stack={plate.stack} size={BELT_PLATE_ART_SIZE} />
                <div className={styles.beltPlateTable}>T{plate.table}</div>
              </div>
            );
          })
        )}
      </div>
    );
  }

  private renderWorkstation() {
    const { appModel } = this.props;
    if (!appModel) return null;
    const plate = appModel.heldPlate;

    return (
      <div className={styles.workstation}>
        {plate ? (
          <div className={styles.plateCard}>
            <div className={styles.plateTable}>TABLE {plate.table}</div>
            <div className={styles.plateHint}>
              Check the big screen for what Table {plate.table} ordered.
            </div>

            {/* The hero plate.  Sized so 512px of source art lands at roughly 1:1 on a
                typical high-DPI phone - see ASSETS.md for the pixel budget. */}
            <div className={styles.heroPlate}>
              <SushiPlate stack={plate.stack} size={HERO_PLATE_ART_SIZE} />
            </div>

            <div className={styles.stackRow}>
              {plate.stack.length > 0 ? (
                plate.stack.map((id, i) => (
                  <span className={styles.stackChip} key={`${id}-${i}`}>
                    {i + 1}. {ingredientName(id)}
                  </span>
                ))
              ) : (
                <span className={styles.stackEmpty}>empty plate &mdash; needs a base first</span>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.emptyBench}>
            Tap a plate on the belt above to pull it onto your bench.
          </div>
        )}

        <div>
          <div className={styles.sectionLabel}>YOUR INGREDIENTS</div>
          <div className={styles.ingredientGrid}>
            {appModel.myIngredients.map((ingredient) => (
              <button
                className={styles.ingredientButton}
                key={ingredient.id}
                disabled={!plate}
                onClick={() => appModel.addIngredient(ingredient.id)}
              >
                <IngredientSwatch id={ingredient.id} size={110} />
                {ingredient.name}
                <span className={styles.ingredientCategory}>{ingredient.category}</span>
              </button>
            ))}
            {appModel.myIngredients.length === 0 ? (
              <div className={styles.stackEmpty}>
                You have no ingredients this round &mdash; call out the orders!
              </div>
            ) : null}
          </div>
        </div>

        <div className={styles.actionRow}>
          <button
            className={styles.trashButton}
            disabled={!plate || appModel.busy}
            onClick={() => appModel.trashPlate()}
          >
            Trash
          </button>
          <button disabled={!plate || appModel.busy} onClick={() => appModel.returnPlateToBelt()}>
            Back to belt
          </button>
          <button
            className={styles.serveButton}
            disabled={!plate || appModel.busy}
            onClick={() => appModel.servePlate()}
          >
            SERVE
          </button>
        </div>
      </div>
    );
  }

  render() {
    const { appModel } = this.props;
    if (!appModel) return <div>NO APP MODEL</div>;

    return (
      <div>
        <div className={styles.statusStrip}>
          <span>Station {appModel.stationIndex}</span>
          <span>&yen;{appModel.till}</span>
          <span>Strikes {appModel.strikes.toFixed(1)} / 3</span>
        </div>
        {this.renderBeltZone()}
        {this.renderWorkstation()}
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------
// Client frame
// ------------------------------------------------------------------------------------------

@inject("appModel")
@observer
export default class Client extends React.Component<{
  appModel?: SushiSyncClientModel;
  uiProperties: UIProperties;
}> {
  lastState: string = GeneralGameState.Unknown;

  alertUser() {
    const { appModel } = this.props;
    if (appModel!.gameState !== this.lastState) {
      SafeBrowser.vibrate([50, 50, 50, 50]);
    }
    this.lastState = appModel!.gameState as string;
  }

  private renderSubScreen() {
    const { appModel } = this.props;

    Logger.debug(`RENDERING WITH GAME STATE: ${appModel?.gameState}`);

    switch (appModel!.gameState) {
      case GeneralClientGameState.WaitingToStart:
        return (
          <div className={styles.centerPanel}>
            <div className={styles.subtle}>
              Lay your phone flat on the table and wait for the host to assign stations...
            </div>
          </div>
        );
      case SushiSyncClientState.Seating:
        this.alertUser();
        return <SeatingScreen />;
      case SushiSyncClientState.Briefing:
        this.alertUser();
        return <BriefingScreen />;
      case SushiSyncClientState.Playing:
        this.alertUser();
        return <GameScreen />;
      case SushiSyncClientState.EndOfRound:
        this.alertUser();
        return (
          <div className={styles.centerPanel}>
            <div className={styles.bigStation} style={{ fontSize: "100%" }}>
              Service over
            </div>
            <div className={styles.subtle}>
              Ingredients are about to be reshuffled. Watch the big screen.
            </div>
          </div>
        );
      case GeneralGameState.GameOver:
        return (
          <div className={styles.centerPanel}>
            <div className={styles.bigStation} style={{ fontSize: "100%" }}>
              Shift over
            </div>
            <div className={styles.subtle}>Results are on the big screen. Nice work, chef.</div>
            <div style={{ marginTop: 30 }}>
              <button onClick={() => this.props.appModel!.quitApp()}>Quit</button>
            </div>
          </div>
        );
      case GeneralClientGameState.JoinError:
        return (
          <div className={styles.centerPanel}>
            <p>Could not join the game because: {this.props.appModel!.joinError}</p>
          </div>
        );
      default:
        return (
          <div className={styles.centerPanel}>These are not the droids you are looking for...</div>
        );
    }
  }

  render() {
    const { appModel } = this.props;
    return (
      <div>
        <ScaleToWidth
          virtualWidth={1080}
          virtualHeight={1920}
          containerWidth={this.props.uiProperties.containerWidth}
          containerHeight={this.props.uiProperties.containerHeight}
          hoverScrollbar
          fillHeight
        >
          <div className={styles.gameclient}>
            <div className={styles.topBar}>
              <span className={styles.topBarName}>
                <PlayerAvatar avatarId={appModel?.avatarId ?? 0} size={40} />
                {appModel?.playerName}
              </span>
              <span className={styles.topBarStation}>
                {appModel?.roundName ? appModel.roundName : "SUSHI SYNC"}
              </span>
              <button onClick={() => appModel?.quitApp()}>X</button>
            </div>

            <ErrorBoundary>{this.renderSubScreen()}</ErrorBoundary>

            {appModel?.toastMessage ? (
              <div className={styles.toast}>{appModel.toastMessage}</div>
            ) : null}
          </div>
        </ScaleToWidth>
      </div>
    );
  }
}
