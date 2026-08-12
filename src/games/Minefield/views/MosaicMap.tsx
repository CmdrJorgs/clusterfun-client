// The advisor's screen: the whole field, drawn with exactly the intel this player was
// dealt and not one hazard more (the presenter did that filtering - see minefieldEndpoints).
//
// Nothing here labels a cell.  The explorer's neighbours are outlined so an advisor knows the
// real menu of options, but naming them is the players' problem to solve out loud, which is
// the game.  Orientation is shared with the explorer's view and never rotated, so "the long
// thin one at the top" means the same thing on both screens.
import React from "react";
import {
  MinefieldFieldView,
  MinefieldHazardView,
  MinefieldTeamStatus,
} from "../models/minefieldEndpoints";
import { Pt, polyPoints, sharedEdges, trailPoints, viewBoxFor } from "./mapGeometry";

export interface MosaicMapProps {
  field: MinefieldFieldView;
  status?: MinefieldTeamStatus;
  teamColor: string;
  /** The round is over and the field has been declassified. */
  revealed: boolean;
  aspect: number;
  className?: string;
}

const HAZARD_GLYPH: Record<string, string> = {
  standard: "◉",
  freeze: "❄",
  motion: "◎",
  invisible: "?",
};

const HAZARD_COLOR: Record<string, string> = {
  standard: "#ff4646",
  multistep: "#ffb020",
  freeze: "#6fe8ff",
  motion: "#ff8a2b",
  invisible: "#c56bff",
};

function hazardLabel(hazard: MinefieldHazardView): string {
  // A multi-step mine shows its TOTAL and is never counted down: keeping the tally is the
  // advisors' job, and it is the one piece of memory work the game deliberately refuses to
  // do for them.
  if (hazard.kind === "multistep") return String(hazard.steps);
  return HAZARD_GLYPH[hazard.kind] ?? "•";
}

export default class MosaicMap extends React.Component<MosaicMapProps> {
  render() {
    const { field, status, teamColor, revealed, aspect, className } = this.props;

    const polyById = new Map<number, number[]>();
    const centers = new Map<number, Pt>();
    for (const cell of field.cells) {
      polyById.set(cell.id, cell.poly);
      centers.set(cell.id, { x: cell.cx, y: cell.cy });
    }

    const options = new Set(status?.options ?? []);
    const walked = new Set(status?.path ?? []);
    const switchCells = new Map(field.walls.map((w) => [w.switchCell, w.id]));

    return (
      <svg
        className={className}
        viewBox={viewBoxFor([...field.cells.map((c) => c.poly)], 24, aspect)}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* The field itself */}
        {field.cells.map((cell) => (
          <polygon
            key={cell.id}
            points={polyPoints(cell.poly)}
            fill={
              cell.id === field.goalCell
                ? "#1d3a20"
                : cell.id === field.startCell
                  ? "#1d2d3a"
                  : walked.has(cell.id)
                    ? "#191d19"
                    : "#101310"
            }
            stroke="#2f3d2f"
            strokeWidth={2}
          />
        ))}

        {/* Cells the explorer may step to right now. No labels - just the menu. */}
        {field.cells
          .filter((cell) => options.has(cell.id))
          .map((cell) => (
            <polygon
              key={`opt-${cell.id}`}
              points={polyPoints(cell.poly)}
              fill="none"
              stroke={teamColor}
              strokeWidth={6}
              strokeDasharray="14 10"
              opacity={0.9}
            />
          ))}

        {/* Start and goal */}
        <text
          x={centers.get(field.startCell)?.x ?? 0}
          y={(centers.get(field.startCell)?.y ?? 0) + 12}
          textAnchor="middle"
          fontSize={36}
          fill="#7fb7ff"
        >
          ★
        </text>
        <text
          x={centers.get(field.goalCell)?.x ?? 0}
          y={(centers.get(field.goalCell)?.y ?? 0) + 14}
          textAnchor="middle"
          fontSize={40}
          fill="#7dff8a"
        >
          ⚑
        </text>

        {/* Failed runs, then the live one */}
        {(status?.ghosts ?? []).map((ghost, index) => (
          <polyline
            key={`ghost-${index}`}
            points={trailPoints(centers, ghost)}
            fill="none"
            stroke={teamColor}
            strokeWidth={4}
            opacity={0.22}
            strokeDasharray="6 10"
          />
        ))}
        {status && (
          <polyline
            points={trailPoints(centers, status.path)}
            fill="none"
            stroke={teamColor}
            strokeWidth={7}
            strokeLinejoin="round"
            opacity={0.85}
          />
        )}

        {/* Hazards this advisor was told about */}
        {field.hazards.map((hazard) => {
          const at = centers.get(hazard.cellId);
          if (!at) return null;
          return (
            <text
              key={`hz-${hazard.id}`}
              x={at.x}
              y={at.y + 13}
              textAnchor="middle"
              fontSize={hazard.kind === "multistep" ? 38 : 34}
              fontWeight={700}
              fill={HAZARD_COLOR[hazard.kind] ?? "#ffffff"}
            >
              {hazardLabel(hazard)}
            </text>
          );
        })}

        {/* Walls, and the switches that open them */}
        {field.walls.map((wall) => {
          const a = polyById.get(wall.a);
          const b = polyById.get(wall.b);
          if (!a || !b) return null;
          return sharedEdges(a, b).map(([p, q], index) => (
            <line
              key={`wall-${wall.id}-${index}`}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke="#ffd24a"
              strokeWidth={12}
              strokeLinecap="round"
            />
          ));
        })}
        {Array.from(switchCells.keys()).map((cellId) => {
          const at = centers.get(cellId);
          if (!at) return null;
          return (
            <text
              key={`sw-${cellId}`}
              x={at.x}
              y={at.y + 12}
              textAnchor="middle"
              fontSize={32}
              fill="#ffd24a"
            >
              ◈
            </text>
          );
        })}

        {/* The explorer */}
        {status && centers.has(status.cell) && (
          <g>
            <circle
              cx={centers.get(status.cell)!.x}
              cy={centers.get(status.cell)!.y}
              r={17}
              fill={teamColor}
              stroke="#05070a"
              strokeWidth={4}
            />
            {status.armedCount > 0 && (
              <circle
                cx={centers.get(status.cell)!.x}
                cy={centers.get(status.cell)!.y}
                r={30}
                fill="none"
                stroke="#ff6a2b"
                strokeWidth={5}
                opacity={0.85}
              />
            )}
          </g>
        )}

        {revealed && (
          <text x={0} y={-6} fontSize={26} fill="#7dff8a">
            FIELD DECLASSIFIED
          </text>
        )}
      </svg>
    );
  }
}
