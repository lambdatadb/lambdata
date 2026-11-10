export interface GraphNode {
  id: string;
  parentId: string | null;
}

export type EdgeKind = "solid" | "working";

export interface LaneEdge {
  lane: number;
  kind: EdgeKind;
}

export interface GraphRow {
  id: string;
  lane: number;
  through: LaneEdge[];
  incoming: LaneEdge[];
  outgoing: LaneEdge | null;
  parentMissing: boolean;
  width: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  laneCount: number;
}

export interface LayoutOptions {
  workingId?: string;
}

interface OpenLane {
  target: string;
  kind: EdgeKind;
}

export function layoutGraph(nodes: readonly GraphNode[], options: LayoutOptions = {}): GraphLayout {
  const position = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (!position.has(node.id)) position.set(node.id, index);
  });

  const lanes: (OpenLane | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;

  nodes.forEach((node, index) => {
    const waiting: number[] = [];
    lanes.forEach((open, lane) => {
      if (open && open.target === node.id) waiting.push(lane);
    });

    let lane: number;
    if (waiting.length > 0) {
      lane = waiting[0]!;
    } else {
      const free = lanes.indexOf(null);
      lane = free === -1 ? lanes.length : free;
      if (free === -1) lanes.push(null);
    }

    const through: LaneEdge[] = [];
    lanes.forEach((open, l) => {
      if (open && !waiting.includes(l)) through.push({ lane: l, kind: open.kind });
    });
    const incoming: LaneEdge[] = waiting.map((l) => ({ lane: l, kind: lanes[l]!.kind }));

    for (const l of waiting) lanes[l] = null;

    const parentIndex = node.parentId === null ? undefined : position.get(node.parentId);
    const parentBelow = parentIndex !== undefined && parentIndex > index;
    const parentMissing = node.parentId !== null && !parentBelow;
    const kind: EdgeKind = options.workingId !== undefined && node.id === options.workingId ? "working" : "solid";

    let outgoing: LaneEdge | null = null;
    if (parentBelow) {
      lanes[lane] = { target: node.parentId!, kind };
      outgoing = { lane, kind };
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const used = [lane, ...through.map((e) => e.lane), ...incoming.map((e) => e.lane)];
    const width = Math.max(...used) + 1;
    laneCount = Math.max(laneCount, width);
    rows.push({ id: node.id, lane, through, incoming, outgoing, parentMissing, width });
  });

  return { rows, laneCount };
}

export function topLanes(row: GraphRow): number[] {
  return [...row.through, ...row.incoming].map((e) => e.lane).sort((a, b) => a - b);
}

export function bottomLanes(row: GraphRow): number[] {
  const lanes = row.through.map((e) => e.lane);
  if (row.outgoing) lanes.push(row.outgoing.lane);
  return lanes.sort((a, b) => a - b);
}
