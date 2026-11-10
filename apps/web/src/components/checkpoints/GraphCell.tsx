import { useId } from "react";
import type { GraphRow, LaneEdge } from "./graph";
import { cn } from "../ui/cn";

export const NODE_Y = 22;
const PAD = 7;

const LANE_STROKE = ["stroke-accent", "stroke-chart-3", "stroke-chart-4", "stroke-chart-5", "stroke-chart-6", "stroke-chart-2"];
const LANE_FILL = ["fill-accent", "fill-chart-3", "fill-chart-4", "fill-chart-5", "fill-chart-6", "fill-chart-2"];

export type WorkingTone = "dirty" | "clean" | "muted";

const WORKING_STROKE: Record<WorkingTone, string> = {
  dirty: "stroke-warn",
  clean: "stroke-text-subtle",
  muted: "stroke-text-subtle",
};

export function laneStroke(lane: number): string {
  return LANE_STROKE[lane % LANE_STROKE.length]!;
}

export function laneFill(lane: number): string {
  return LANE_FILL[lane % LANE_FILL.length]!;
}

export function graphColumnWidth(laneCount: number, laneWidth: number): number {
  return Math.max(30, PAD * 2 + Math.max(1, laneCount) * laneWidth);
}

export type NodeShape = "head" | "commit" | "auto" | "legacy" | "working";

export interface GraphCellProps {
  row: GraphRow;
  laneWidth: number;
  width: number;
  shape: NodeShape;
  workingTone?: WorkingTone;
  pulsing?: boolean;
}

function edgeClass(edge: LaneEdge, tone: WorkingTone) {
  if (edge.kind === "working") return WORKING_STROKE[tone];
  return laneStroke(edge.lane);
}

export function GraphCell({ row, laneWidth, width, shape, workingTone = "muted", pulsing = false }: GraphCellProps) {
  const x = (lane: number) => PAD + lane * laneWidth + laneWidth / 2;
  const xn = x(row.lane);
  const dash = (edge: LaneEdge) => (edge.kind === "working" ? "3 3" : undefined);
  const fadeId = useId().replace(/:/g, "");

  return (
    <svg aria-hidden width={width} height="100%" className="absolute inset-y-0 left-0 overflow-visible" fill="none">
      {row.through.map((edge) => (
        <line
          key={`t${edge.lane}`}
          x1={x(edge.lane)}
          y1={-1}
          x2={x(edge.lane)}
          y2="100%"
          strokeWidth={2}
          strokeLinecap={edge.kind === "working" ? undefined : "square"}
          strokeDasharray={dash(edge)}
          className={edgeClass(edge, workingTone)}
        />
      ))}
      {row.incoming.map((edge) => {
        const xi = x(edge.lane);
        const offset = xi - xn;
        const r = Math.min(9, Math.abs(offset), NODE_Y);
        const sign = offset > 0 ? 1 : -1;
        const d =
          offset === 0
            ? `M ${xi} -1 L ${xi} ${NODE_Y}`
            : `M ${xi} -1 L ${xi} ${NODE_Y - r} Q ${xi} ${NODE_Y} ${xi - sign * r} ${NODE_Y} L ${xn} ${NODE_Y}`;
        return (
          <path
            key={`i${edge.lane}`}
            d={d}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeDasharray={dash(edge)}
            className={edgeClass(edge, workingTone)}
          />
        );
      })}
      {row.outgoing && (
        <line
          x1={xn}
          y1={NODE_Y}
          x2={xn}
          y2="100%"
          strokeWidth={2}
          strokeLinecap={row.outgoing.kind === "working" ? undefined : "square"}
          strokeDasharray={dash(row.outgoing)}
          className={edgeClass(row.outgoing, workingTone)}
        />
      )}
      {row.parentMissing && (
        <>
          <defs>
            <linearGradient id={fadeId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="white" stopOpacity="1" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
            <mask id={`${fadeId}m`}>
              <rect x={xn - 3} y={NODE_Y} width={6} height={20} fill={`url(#${fadeId})`} />
            </mask>
          </defs>
          <line
            x1={xn}
            y1={NODE_Y}
            x2={xn}
            y2={NODE_Y + 20}
            strokeWidth={2}
            strokeDasharray="2 3"
            mask={`url(#${fadeId}m)`}
            className={laneStroke(row.lane)}
          />
        </>
      )}
      <Node shape={shape} cx={xn} lane={row.lane} tone={workingTone} pulsing={pulsing} />
    </svg>
  );
}

function Node({ shape, cx, lane, tone, pulsing }: { shape: NodeShape; cx: number; lane: number; tone: WorkingTone; pulsing: boolean }) {
  const cy = NODE_Y;
  return (
    <g>
      {pulsing && (
        <circle cx={cx} cy={cy} r={10} className={cn(laneFill(lane), "animate-pulse opacity-25 motion-reduce:animate-none")} />
      )}
      {shape === "working" && (
        <>
          <circle cx={cx} cy={cy} r={6} className="fill-bg-panel" />
          <circle
            cx={cx}
            cy={cy}
            r={5}
            strokeWidth={2}
            strokeDasharray="2.6 2"
            className={cn(WORKING_STROKE[tone], "fill-bg-panel")}
          />
          {tone === "dirty" && <circle cx={cx} cy={cy} r={1.75} className="fill-warn" />}
        </>
      )}
      {shape === "head" && (
        <>
          <circle cx={cx} cy={cy} r={10} className="fill-accent/15" />
          <circle cx={cx} cy={cy} r={6} strokeWidth={2.5} className="fill-bg-panel stroke-accent" />
          <circle cx={cx} cy={cy} r={2.5} className="fill-accent" />
        </>
      )}
      {shape === "commit" && (
        <circle cx={cx} cy={cy} r={5} strokeWidth={2.25} className={cn("fill-bg-panel", laneStroke(lane))} />
      )}
      {shape === "auto" && (
        <circle cx={cx} cy={cy} r={3.75} strokeWidth={2} className={cn("fill-bg-panel", laneStroke(lane))} />
      )}
      {shape === "legacy" && (
        <rect
          x={cx - 4.5}
          y={cy - 4.5}
          width={9}
          height={9}
          rx={2}
          strokeWidth={2}
          className={cn("fill-bg-panel", laneStroke(lane))}
        />
      )}
    </g>
  );
}

export function ContinuationCell({ lanes, laneWidth, width }: { lanes: number[]; laneWidth: number; width: number }) {
  const id = useId().replace(/:/g, "");
  const x = (lane: number) => PAD + lane * laneWidth + laneWidth / 2;
  return (
    <svg aria-hidden width={width} height="100%" className="absolute inset-y-0 left-0" fill="none">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="white" stopOpacity="1" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}m`}>
          <rect x={0} y={0} width={width} height="100%" fill={`url(#${id})`} />
        </mask>
      </defs>
      <g mask={`url(#${id}m)`}>
        {lanes.map((lane) => (
          <line
            key={lane}
            x1={x(lane)}
            y1={0}
            x2={x(lane)}
            y2="100%"
            strokeWidth={2}
            strokeDasharray="2 4"
            className={laneStroke(lane)}
          />
        ))}
      </g>
    </svg>
  );
}
