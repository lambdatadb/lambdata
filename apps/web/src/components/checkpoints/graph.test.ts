import { bottomLanes, layoutGraph, topLanes, type GraphLayout, type GraphNode } from "./graph";

declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
};

function chain(spec: [string, string | null][]): GraphNode[] {
  return spec.map(([id, parentId]) => ({ id, parentId }));
}

function lanesOf(layout: GraphLayout): Record<string, number> {
  return Object.fromEntries(layout.rows.map((r) => [r.id, r.lane]));
}

function expectContinuous(layout: GraphLayout) {
  for (let i = 1; i < layout.rows.length; i++) {
    expect(topLanes(layout.rows[i]!)).toEqual(bottomLanes(layout.rows[i - 1]!));
  }
  expect(topLanes(layout.rows[0]!)).toEqual([]);
  expect(bottomLanes(layout.rows[layout.rows.length - 1]!)).toEqual([]);
}

test("linear history stays in one lane", () => {
  const layout = layoutGraph(chain([["c", "b"], ["b", "a"], ["a", null]]));
  expect(layout.laneCount).toBe(1);
  expect(lanesOf(layout)).toEqual({ c: 0, b: 0, a: 0 });
  expect(layout.rows[0]!.incoming).toEqual([]);
  expect(layout.rows[0]!.outgoing).toEqual({ lane: 0, kind: "solid" });
  expect(layout.rows[1]!.incoming).toEqual([{ lane: 0, kind: "solid" }]);
  expect(layout.rows[2]!.outgoing).toBe(null);
  expect(layout.rows[2]!.parentMissing).toBe(false);
  expectContinuous(layout);
});

test("a rollback followed by new checkpoints branches off the restored node", () => {
  const layout = layoutGraph(
    chain([
      ["e", "d"],
      ["d", "a"],
      ["c", "b"],
      ["b", "a"],
      ["a", null],
    ]),
  );
  expect(layout.laneCount).toBe(2);
  expect(lanesOf(layout)).toEqual({ e: 0, d: 0, c: 1, b: 1, a: 0 });
  const c = layout.rows[2]!;
  expect(c.through).toEqual([{ lane: 0, kind: "solid" }]);
  expect(c.incoming).toEqual([]);
  const a = layout.rows[4]!;
  expect(a.incoming.map((e) => e.lane)).toEqual([0, 1]);
  expectContinuous(layout);
});

test("two branches off different ancestors use three lanes and free them when they join", () => {
  const layout = layoutGraph(
    chain([
      ["g", "f"],
      ["f", "b"],
      ["e", "d"],
      ["d", "a"],
      ["c", "b"],
      ["b", "a"],
      ["a", null],
    ]),
  );
  expect(layout.laneCount).toBe(3);
  expect(lanesOf(layout)).toEqual({ g: 0, f: 0, e: 1, d: 1, c: 2, b: 0, a: 0 });
  const b = layout.rows[5]!;
  expect(b.incoming.map((e) => e.lane)).toEqual([0, 2]);
  expect(b.through.map((e) => e.lane)).toEqual([1]);
  expect(b.width).toBe(3);
  const a = layout.rows[6]!;
  expect(a.incoming.map((e) => e.lane)).toEqual([0, 1]);
  expect(a.width).toBe(2);
  expectContinuous(layout);
});

test("a checkpoint whose parent was deleted ends its lane and is marked", () => {
  const layout = layoutGraph(chain([["c", "b"], ["b", "gone"], ["a", null]]));
  const b = layout.rows[1]!;
  expect(b.parentMissing).toBe(true);
  expect(b.outgoing).toBe(null);
  expect(lanesOf(layout)).toEqual({ c: 0, b: 0, a: 0 });
  expect(layout.rows[2]!.incoming).toEqual([]);
  expectContinuous(layout);
});

test("a parent listed above its child is treated as missing instead of opening an endless lane", () => {
  const layout = layoutGraph(chain([["p", null], ["c", "p"]]));
  expect(layout.rows[1]!.parentMissing).toBe(true);
  expect(layout.rows[1]!.outgoing).toBe(null);
  expectContinuous(layout);
});

test("the working copy draws a dashed edge down to HEAD through newer branches", () => {
  const layout = layoutGraph(
    chain([
      ["working", "b"],
      ["e", "d"],
      ["d", "b"],
      ["c", "b"],
      ["b", "a"],
      ["a", null],
    ]),
    { workingId: "working" },
  );
  expect(lanesOf(layout)).toEqual({ working: 0, e: 1, d: 1, c: 2, b: 0, a: 0 });
  expect(layout.rows[0]!.outgoing).toEqual({ lane: 0, kind: "working" });
  expect(layout.rows[1]!.through).toEqual([{ lane: 0, kind: "working" }]);
  const b = layout.rows[4]!;
  expect(b.incoming).toEqual([
    { lane: 0, kind: "working" },
    { lane: 1, kind: "solid" },
    { lane: 2, kind: "solid" },
  ]);
  expect(b.outgoing).toEqual({ lane: 0, kind: "solid" });
  expectContinuous(layout);
});

test("a working copy with no checkpoint is a lone node", () => {
  const layout = layoutGraph(chain([["working", null]]), { workingId: "working" });
  expect(layout.laneCount).toBe(1);
  expect(layout.rows[0]!.outgoing).toBe(null);
  expect(layout.rows[0]!.parentMissing).toBe(false);
});

test("a freed lane is reused by the next branch tip", () => {
  const layout = layoutGraph(
    chain([
      ["x2", "x1"],
      ["x1", "m"],
      ["y1", "n"],
      ["n", "m"],
      ["m", null],
    ]),
  );
  expect(lanesOf(layout)).toEqual({ x2: 0, x1: 0, y1: 1, n: 1, m: 0 });
  expect(layout.laneCount).toBe(2);
  expectContinuous(layout);
});

test("a hundred linear checkpoints lay out in one lane quickly", () => {
  const nodes: GraphNode[] = Array.from({ length: 100 }, (_, i) => ({
    id: `c${99 - i}`,
    parentId: i === 99 ? null : `c${98 - i}`,
  }));
  const started = performance.now();
  const layout = layoutGraph(nodes);
  expect(performance.now() - started).toBeLessThan(50);
  expect(layout.rows.length).toBe(100);
  expect(layout.laneCount).toBe(1);
  expect(layout.rows.every((r) => r.lane === 0)).toBe(true);
  expectContinuous(layout);
});

test("a hundred checkpoints with a rollback every ten keep the graph narrow and continuous", () => {
  const created: GraphNode[] = [];
  let head: string | null = null;
  for (let i = 0; i < 100; i++) {
    const id = `c${i}`;
    created.push({ id, parentId: head });
    head = id;
    if (i % 10 === 9) head = `c${i - 6}`;
  }
  const newestFirst = created.slice().reverse();
  const layout = layoutGraph([{ id: "working", parentId: head }, ...newestFirst], { workingId: "working" });
  expect(layout.rows.length).toBe(101);
  expect(layout.laneCount).toBeLessThanOrEqual(3);
  expect(layout.rows[0]!.outgoing?.kind).toBe("working");
  expectContinuous(layout);
});

test("deep fan-out from one ancestor converges in a single row", () => {
  const nodes: GraphNode[] = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, parentId: "root" })),
    { id: "root", parentId: null },
  ];
  const layout = layoutGraph(nodes);
  expect(layout.laneCount).toBe(5);
  const root = layout.rows[5]!;
  expect(root.lane).toBe(0);
  expect(root.incoming.map((e) => e.lane)).toEqual([0, 1, 2, 3, 4]);
  expectContinuous(layout);
});
