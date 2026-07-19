import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import type {
  Database,
  DatabaseCredentials,
  MetricSample,
  QueryResult,
  Snapshot,
  SyncJob,
  SyncSourceKind,
  TableBreakdownEntry,
} from "@kilndb/shared";
import { api, ApiError } from "../lib/api";
import { PageHeader } from "../components/layout/PageShell";
import { Card, CardTitle } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Dialog } from "../components/ui/Dialog";
import { Field, Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { StatTile } from "../components/ui/StatTile";
import { Table, TBody, TD, TH, THead, TR, TableEmpty, TableSkeleton } from "../components/ui/Table";
import { Tabs } from "../components/ui/Tabs";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { CopyableField } from "../components/ui/CopyableField";
import { CredentialsReveal } from "../components/databases/CredentialsReveal";
import { VitalsStrip } from "../components/databases/VitalsStrip";
import { useAuth } from "../lib/auth";
import { useConnectionInfo } from "../lib/useConnectionInfo";
import { useTerminology } from "../lib/terminology";
import { formatBytes, formatDate, formatRelativeTime } from "../lib/format";

type TabId = "overview" | "query" | "tables" | "snapshots" | "sync" | "metrics" | "danger";

export function DatabaseDetail() {
  const { id = "" } = useParams();
  const [tab, setTab] = useState<TabId>("overview");
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const conn = useConnectionInfo();

  const dbq = useQuery({
    queryKey: ["databases", id],
    queryFn: () => api.get<{ database: Database }>(`/databases/${id}`),
    enabled: !!id,
  });
  const db = dbq.data?.database;

  const deleteMu = useMutation({
    mutationFn: () => api.delete(`/databases/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["databases"] });
      toast.show("Database deleted", "success");
      nav("/databases");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "delete failed", "error"),
  });

  if (dbq.isLoading) return <div className="py-20 flex justify-center"><Spinner /></div>;
  if (!db) return <p className="text-sm text-text-muted">Database not found.</p>;

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "query", label: "Query" },
    { id: "tables", label: "Tables" },
    { id: "snapshots", label: "Snapshots" },
    { id: "sync", label: "Sync", hidden: db.kind !== "mirror" },
    { id: "metrics", label: "Metrics" },
    { id: "danger", label: "Danger" },
  ];

  return (
    <>
      <PageHeader
        title={db.displayName}
        subtitle={
          <>
            Provisioned {formatRelativeTime(db.createdAt)} ·{" "}
            <span className="font-mono">{conn.host}:{conn.port}</span>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {db.kind === "mirror" && <Badge tone="accent">Mirror</Badge>}
            {db.tailscaleExposed && <Badge tone="success">Tailnet</Badge>}
            <Badge tone="muted">{db.status}</Badge>
          </div>
        }
      />
      <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />
      <motion.div
        key={tab}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16 }}
        className="mt-5"
      >
        {tab === "overview" && <Overview db={db} />}
        {tab === "query" && <QueryTab db={db} />}
        {tab === "tables" && <TablesTab db={db} />}
        {tab === "snapshots" && <SnapshotsTab db={db} />}
        {tab === "sync" && <SyncTab db={db} />}
        {tab === "metrics" && <MetricsTab db={db} />}
        {tab === "danger" && (
          <DangerTab
            db={db}
            onDelete={() => deleteMu.mutate()}
            deleting={deleteMu.isPending}
          />
        )}
      </motion.div>
    </>
  );
}

// ---------- Overview ----------

function Overview({ db }: { db: Database }) {
  const t = useTerminology();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const conn = useConnectionInfo();
  const [allowedHost, setAllowedHost] = useState(db.connectionsFrom);
  const [creds, setCreds] = useState<DatabaseCredentials | null>(null);

  const saveAllowed = useMutation({
    mutationFn: () =>
      api.patch<{ database: Database }>(`/databases/${db.id}`, {
        connectionsFrom: allowedHost,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["databases"] });
      qc.invalidateQueries({ queryKey: ["databases", db.id] });
      toast.show("Allowed hosts updated", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "update failed", "error"),
  });

  const rotate = useMutation({
    mutationFn: () =>
      api.post<{ credentials: DatabaseCredentials }>(`/databases/${db.id}/rotate-password`),
    onSuccess: (data) => {
      setCreds(data.credentials);
      toast.show("Password rotated", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "rotate failed", "error"),
  });

  return (
    <>
      <div className="space-y-6">
        {user?.dataViewEnabled && <VitalsStrip databaseId={db.id} />}
        <Card>
          <CardTitle>Connection</CardTitle>
          <div className="grid grid-cols-2 gap-3">
            <CopyableField label="Host" value={conn.host} />
            <CopyableField label="Port" value={String(conn.port)} />
            <CopyableField label="Schema" value={db.name} />
            <CopyableField label="User" value={db.mysqlUser} />
          </div>
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-text-muted">
              Password is stored encrypted. {t("rotatePassword")} to reveal a fresh one.
            </span>
            <Button variant="secondary" loading={rotate.isPending} onClick={() => rotate.mutate()}>
              {t("rotatePassword")}
            </Button>
          </div>
        </Card>

        <Card>
          <CardTitle>Access</CardTitle>
          <div className="grid grid-cols-1 gap-4">
            <Field label={t("connectionsFrom")} hint={t("connectionsFromHelp")}>
              <Input
                value={allowedHost}
                onChange={(e) => setAllowedHost(e.target.value)}
                placeholder="%"
              />
            </Field>
            <div className="flex justify-end">
              <Button
                size="sm"
                loading={saveAllowed.isPending}
                disabled={allowedHost === db.connectionsFrom}
                onClick={() => saveAllowed.mutate()}
              >
                Save
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle>Metadata</CardTitle>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-text-muted">Created</dt>
            <dd>{formatDate(db.createdAt)}</dd>
            <dt className="text-text-muted">Owner</dt>
            <dd>{db.ownerDisplayName ?? "—"}</dd>
            <dt className="text-text-muted">Kind</dt>
            <dd className="capitalize">{db.kind}</dd>
            <dt className="text-text-muted">Status</dt>
            <dd className="capitalize">{db.status}</dd>
          </dl>
        </Card>
      </div>

      <Dialog
        open={!!creds}
        onClose={() => setCreds(null)}
        size="xl"
        title="New password"
        hideClose
      >
        {creds && <CredentialsReveal credentials={creds} onDone={() => setCreds(null)} />}
      </Dialog>
    </>
  );
}

// ---------- Query ----------

function QueryTab({ db }: { db: Database }) {
  const [sql, setSql] = useState("SELECT 1;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => api.post<QueryResult>(`/databases/${db.id}/query`, { sql }),
    onSuccess: (data) => {
      setResult(data);
      setErr(null);
    },
    onError: (e) => {
      setErr(e instanceof ApiError ? e.message : "query failed");
      setResult(null);
    },
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run.mutate();
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Query console</CardTitle>
        <Textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={6}
          spellCheck={false}
        />
        <div className="mt-3 flex justify-end">
          <Button loading={run.isPending} onClick={() => run.mutate()}>
            Run
          </Button>
        </div>
      </Card>

      {err && (
        <Card>
          <pre className="text-xs text-danger whitespace-pre-wrap">{err}</pre>
        </Card>
      )}

      {result && (
        <Card>
          <div className="flex items-center justify-between mb-3 text-xs text-text-muted">
            <span>{result.rowCount} row(s)</span>
            <span>{result.durationMs.toFixed(1)}ms</span>
          </div>
          <Table flush>
            <THead>
              <tr>
                {result.columns.map((c) => (
                  <TH key={c} className="font-mono">
                    {c}
                  </TH>
                ))}
              </tr>
            </THead>
            <TBody>
              {result.rows.map((row, i) => (
                <TR key={i}>
                  {row.map((v, j) => (
                    <TD key={j} className="align-top font-mono text-label">
                      {v === null ? <span className="text-text-subtle">NULL</span> : String(v)}
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

// ---------- Snapshots ----------

function SnapshotsTab({ db }: { db: Database }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useTerminology();
  const [restoreTarget, setRestoreTarget] = useState<Snapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Snapshot | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["snapshots", db.id],
    queryFn: () => api.get<{ snapshots: Snapshot[] }>(`/databases/${db.id}/snapshots`),
  });
  const snapshots = data?.snapshots ?? [];
  const create = useMutation({
    mutationFn: () => api.post(`/databases/${db.id}/snapshots`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["snapshots", db.id] });
      toast.show("Snapshot created", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "snapshot failed", "error"),
  });
  const restore = useMutation({
    mutationFn: (sid: string) => api.post(`/databases/${db.id}/snapshots/${sid}/restore`),
    onSuccess: () => {
      toast.show("Restored", "success");
      setRestoreTarget(null);
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "restore failed", "error"),
  });
  const drop = useMutation({
    mutationFn: (sid: string) => api.delete(`/databases/${db.id}/snapshots/${sid}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["snapshots", db.id] });
      setDeleteTarget(null);
    },
  });

  return (
    <>
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <CardTitle>{t("snapshots")}</CardTitle>
            <p className="mt-1 text-sm text-text-muted">{t("snapshotsHelp")}</p>
          </div>
          <Button loading={create.isPending} onClick={() => create.mutate()}>
            Take snapshot
          </Button>
        </div>
        <Table flush>
          <THead>
            <tr>
              <TH>Created</TH>
              <TH>Trigger</TH>
              <TH className="text-right">Size</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {isLoading ? (
              <TableSkeleton rows={3} cols={4} />
            ) : snapshots.length === 0 ? (
              <TableEmpty colSpan={4}>No snapshots yet.</TableEmpty>
            ) : (
              snapshots.map((s) => (
                <TR key={s.id}>
                  <TD>{formatDate(s.createdAt)}</TD>
                  <TD className="capitalize">{s.trigger}</TD>
                  <TD numeric>{formatBytes(s.sizeBytes)}</TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mr-2"
                      onClick={() => setRestoreTarget(s)}
                    >
                      Restore
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(s)}>
                      Delete
                    </Button>
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </Card>

      <ConfirmDialog
        open={!!restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => restoreTarget && restore.mutate(restoreTarget.id)}
        title="Restore snapshot"
        body={
          <>
            The <span className="font-mono text-text">{db.name}</span> schema is dropped and
            recreated from this dump. Anything written since the snapshot is lost.
          </>
        }
        confirmLabel="Restore"
        tone="danger"
        loading={restore.isPending}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && drop.mutate(deleteTarget.id)}
        title="Delete snapshot"
        body={
          deleteTarget
            ? `The snapshot from ${formatDate(deleteTarget.createdAt)} is permanently removed.`
            : undefined
        }
        confirmLabel="Delete"
        tone="danger"
        loading={drop.isPending}
      />
    </>
  );
}

// ---------- Sync ----------

function SyncTab({ db }: { db: Database }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useTerminology();
  const { data } = useQuery({
    queryKey: ["sync", db.id],
    queryFn: () => api.get<{ sync: SyncJob | null }>(`/databases/${db.id}/sync`),
  });
  const current = data?.sync ?? null;

  const [sourceKind, setSourceKind] = useState<SyncSourceKind>(current?.sourceKind ?? "mysql");
  const [sourceHost, setSourceHost] = useState(current?.sourceHost ?? "");
  const [sourcePort, setSourcePort] = useState(current?.sourcePort ?? 3306);
  const [sourceUser, setSourceUser] = useState(current?.sourceUser ?? "");
  const [sourcePassword, setSourcePassword] = useState("");
  const [sourceDatabase, setSourceDatabase] = useState(current?.sourceDatabase ?? "");
  const [intervalSeconds, setIntervalSeconds] = useState(current?.intervalSeconds ?? 3600);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/databases/${db.id}/sync`, {
        sourceKind,
        sourceHost,
        sourcePort: Number(sourcePort),
        sourceUser,
        sourcePassword: sourcePassword || undefined,
        sourceDatabase,
        intervalSeconds: Number(intervalSeconds),
        enabled: true,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sync", db.id] });
      toast.show("Sync saved", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "save failed", "error"),
  });

  const runNow = useMutation({
    mutationFn: () => api.post<{ status: string; error?: string }>(`/databases/${db.id}/sync/run`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["sync", db.id] });
      if (r.status === "ok") toast.show("Sync ran", "success");
      else toast.show(r.error ?? "sync error", "error");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "run failed", "error"),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>{t("mirrorSource")}</CardTitle>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Source kind">
            <Select value={sourceKind} onChange={(e) => setSourceKind(e.target.value as SyncSourceKind)}>
              <option value="mysql">MySQL / MariaDB</option>
              <option value="postgres">PostgreSQL</option>
            </Select>
          </Field>
          <Field label={t("intervalSeconds")}>
            <Input
              type="number"
              value={intervalSeconds}
              min={60}
              onChange={(e) => setIntervalSeconds(Number(e.target.value))}
            />
          </Field>
          <Field label="Source host" required>
            <Input value={sourceHost} onChange={(e) => setSourceHost(e.target.value)} placeholder="db.example.com" />
          </Field>
          <Field label="Source port" required>
            <Input
              type="number"
              value={sourcePort}
              onChange={(e) => setSourcePort(Number(e.target.value))}
            />
          </Field>
          <Field label="Source user" required>
            <Input value={sourceUser} onChange={(e) => setSourceUser(e.target.value)} />
          </Field>
          <Field
            label="Source password"
            hint={current ? "Leave blank to keep current password" : undefined}
            required={!current}
          >
            <Input
              type="password"
              value={sourcePassword}
              onChange={(e) => setSourcePassword(e.target.value)}
            />
          </Field>
          <Field label="Source database" required>
            <Input value={sourceDatabase} onChange={(e) => setSourceDatabase(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <div className="text-xs text-text-muted">
            {current?.lastRunAt ? (
              <>
                Last run {formatRelativeTime(current.lastRunAt)} ·{" "}
                <span className={current.lastStatus === "ok" ? "text-success" : "text-danger"}>
                  {current.lastStatus}
                </span>
                {current.lastError && <span> — {current.lastError}</span>}
              </>
            ) : (
              <>Never run</>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              loading={runNow.isPending}
              disabled={!current}
              onClick={() => runNow.mutate()}
            >
              Run now
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ---------- Metrics ----------

const RANGE_MS_CLIENT: Record<"24h" | "7d" | "30d", number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function MetricsTab({ db }: { db: Database }) {
  const [range, setRange] = useState<"24h" | "7d" | "30d">("30d");
  const { data, isLoading } = useQuery({
    queryKey: ["metrics", db.id, range],
    queryFn: () =>
      api.get<{ samples: MetricSample[] }>(`/databases/${db.id}/metrics?range=${range}`),
    // The sync worker pushes a fresh metric sample at the end of each run, so
    // refetching every 30s is enough to feel "alive" without the chart
    // visibly redrawing every few seconds when nothing is happening.
    refetchInterval: 30_000,
  });
  const samples = data?.samples ?? [];
  const latest = samples[samples.length - 1];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <CardTitle>Metrics</CardTitle>
        <Select value={range} onChange={(e) => setRange(e.target.value as "24h" | "7d" | "30d")} className="w-32 h-8 py-0">
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </Select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile label="Size" value={latest?.sizeBytes ?? null} format={formatBytes} />
        <StatTile label="Tables" value={latest?.tableCount ?? null} />
        <StatTile label="Connections" value={latest?.connectionCount ?? null} />
      </div>
      <Card>
        <CardTitle>Size over time</CardTitle>
        {isLoading ? <Spinner /> : <SparkLine samples={samples} range={range} />}
      </Card>
      <Card>
        <div className="flex items-baseline justify-between">
          <CardTitle>Write activity</CardTitle>
          <span className="text-label font-medium text-text-muted">
            cells = time · shade = rows written
          </span>
        </div>
        {isLoading ? (
          <Spinner />
        ) : (
          <WriteActivityGrid samples={samples} range={range} />
        )}
      </Card>
    </div>
  );
}

function SparkLine({ samples, range }: { samples: MetricSample[]; range: "24h" | "7d" | "30d" }) {
  if (samples.length === 0) {
    return <p className="text-sm text-text-muted">No samples yet — first poll runs within ~60s of database creation.</p>;
  }
  const values = samples.map((s) => s.sizeBytes ?? 0);
  const max = Math.max(1, ...values);
  const w = 600, h = 80;
  // Time-based X so new samples appear at the right edge instead of pushing
  // older samples leftward each refetch.
  const now = Date.now();
  const start = now - RANGE_MS_CLIENT[range];
  const span = Math.max(1, now - start);
  const points = samples.map((s, i) => {
    const x = ((s.collectedAt - start) / span) * w;
    const y = h - ((values[i] ?? 0) / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-20" preserveAspectRatio="none">
      <polyline
        fill="none"
        stroke="#D85D3F"
        strokeWidth="2"
        points={points.join(" ")}
      />
    </svg>
  );
}

function WriteActivityGrid({
  samples,
  range,
}: {
  samples: MetricSample[];
  range: "24h" | "7d" | "30d";
}) {
  const [hover, setHover] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Track the card's inner width so the grid can fill it horizontally. More
  // available width = more time buckets = finer resolution.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const ROWS = 7;
  const CELL = 12;
  const GAP = 3;
  // Aim for as many columns as fit, with a sensible floor while we wait for
  // the first measurement pass.
  const COLS = Math.max(
    20,
    containerWidth > 0
      ? Math.floor((containerWidth + GAP) / (CELL + GAP))
      : 30,
  );
  const total = ROWS * COLS;

  const rangeMs = RANGE_MS_CLIENT[range];
  const now = Date.now();
  const rangeStart = now - rangeMs;
  const bucketMs = rangeMs / total;

  // Sum positive row-count deltas into time buckets so a big sync pull lights
  // up the cells corresponding to when it happened. Negative deltas (table
  // drops, mirror resets) are ignored — they aren't "writes".
  const buckets = new Array<number>(total).fill(0);
  let totalWrites = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    if (prev.rowCount == null || cur.rowCount == null) continue;
    const delta = cur.rowCount - prev.rowCount;
    if (delta <= 0) continue;
    const idx = Math.floor((cur.collectedAt - rangeStart) / bucketMs);
    if (idx < 0 || idx >= total) continue;
    buckets[idx] = (buckets[idx] ?? 0) + delta;
    totalWrites += delta;
  }

  const maxBucket = Math.max(0, ...buckets);
  const levelFor = (n: number): number => {
    if (n <= 0 || maxBucket <= 0) return 0;
    const t = Math.log10(1 + n) / Math.log10(1 + maxBucket);
    return Math.max(1, Math.min(4, Math.ceil(t * 4)));
  };

  const w = COLS * CELL + (COLS - 1) * GAP;
  const h = ROWS * CELL + (ROWS - 1) * GAP;

  return (
    <div className="space-y-3">
      <div ref={containerRef} className="w-full">
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          shapeRendering="crispEdges"
          className="block"
        >
          {buckets.map((count, i) => {
            const col = Math.floor(i / ROWS);
            const row = i % ROWS;
            const x = col * (CELL + GAP);
            const y = row * (CELL + GAP);
            const level = levelFor(count);
            const isHover = hover === i;
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                rx={2}
                fill={levelFill(level)}
                // Stroke is "inside" via paint-order so it doesn't visually
                // grow the cell when hovering (no layout jump).
                stroke={isHover ? "rgb(216 93 63)" : "transparent"}
                strokeWidth={1}
                paintOrder="stroke"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() =>
                  setHover((cur) => (cur === i ? null : cur))
                }
                style={{ cursor: "pointer", transition: "stroke 100ms ease-out" }}
              />
            );
          })}
        </svg>
      </div>

      <WriteActivityLegend
        hoverIdx={hover}
        hoverCount={hover != null ? buckets[hover] ?? 0 : 0}
        bucketMs={bucketMs}
        totalBuckets={total}
        totalWrites={totalWrites}
        range={range}
      />
    </div>
  );
}

function WriteActivityLegend({
  hoverIdx,
  hoverCount,
  bucketMs,
  totalBuckets,
  totalWrites,
  range,
}: {
  hoverIdx: number | null;
  hoverCount: number;
  bucketMs: number;
  totalBuckets: number;
  totalWrites: number;
  range: "24h" | "7d" | "30d";
}) {
  const hovered = hoverIdx != null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
      {hovered ? (
        <>
          <span className="font-mono text-text">
            {formatBucketAgo(hoverIdx, bucketMs, totalBuckets)}
          </span>
          <span className="text-text-muted">
            <span className="text-text">{formatCount(hoverCount)}</span>{" "}
            {hoverCount === 1 ? "row" : "rows"} written
          </span>
        </>
      ) : (
        <span className="text-text-muted">
          <span className="text-text">{formatCount(totalWrites)}</span> rows written in
          the last {rangeWord(range)}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2 text-text-subtle">
        <span className="text-label font-medium text-text-muted">light</span>
        {[1, 2, 3, 4].map((lvl) => (
          <span
            key={lvl}
            aria-hidden
            className="inline-block size-2.5 rounded-[2px]"
            style={{ background: levelFill(lvl) }}
          />
        ))}
        <span className="text-label font-medium text-text-muted">heavy</span>
      </div>
    </div>
  );
}

function levelFill(level: number): string {
  switch (level) {
    case 4:
      return "rgba(62, 207, 142, 0.9)";
    case 3:
      return "rgba(62, 207, 142, 0.65)";
    case 2:
      return "rgba(62, 207, 142, 0.4)";
    case 1:
      return "rgba(62, 207, 142, 0.2)";
    default:
      return "rgba(62, 207, 142, 0.08)";
  }
}

function formatBucketAgo(idx: number, bucketMs: number, total: number): string {
  // Each bucket represents a window starting `(total - idx - 1) * bucketMs` ago.
  const start = (total - idx - 1) * bucketMs;
  const end = (total - idx) * bucketMs;
  const label = (ms: number): string => {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
    if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
    return `${Math.round(ms / (24 * 60 * 60_000))}d`;
  };
  return `${label(end)} → ${label(start)} ago`;
}

function rangeWord(range: "24h" | "7d" | "30d"): string {
  switch (range) {
    case "24h":
      return "24 hours";
    case "7d":
      return "7 days";
    case "30d":
      return "30 days";
  }
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

// ---------- Tables ----------

function TablesTab({ db }: { db: Database }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["databases", db.id, "tables"],
    queryFn: () => api.get<{ tables: TableBreakdownEntry[] }>(`/databases/${db.id}/tables`),
    refetchInterval: 30_000,
  });

  const list = data?.tables ?? [];

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <div>
          <CardTitle>Tables</CardTitle>
          <p className="mt-1 text-sm text-text-muted">
            Overview of the tables, estimated row counts, and data size in this database.
          </p>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-danger">Failed to load tables.</p>
      ) : (
        <Table flush>
          <THead>
            <tr>
              <TH>Name</TH>
              <TH className="text-right">Row Count</TH>
              <TH className="text-right">Size</TH>
              <TH className="text-right">Avg Row Size</TH>
            </tr>
          </THead>
          <TBody>
            {isLoading ? (
              <TableSkeleton rows={4} cols={4} />
            ) : list.length === 0 ? (
              <TableEmpty colSpan={4}>
                No tables found. Run a query or migrate a schema to get started.
              </TableEmpty>
            ) : (
              list.map((t) => (
                <TR key={t.name}>
                  <TD className="font-mono text-label">{t.name}</TD>
                  <TD numeric>{t.rowCount.toLocaleString()}</TD>
                  <TD numeric>{formatBytes(t.sizeBytes)}</TD>
                  <TD numeric>{t.avgRowBytes > 0 ? formatBytes(t.avgRowBytes) : "—"}</TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

// ---------- Danger ----------

function DangerTab({ db, onDelete, deleting }: { db: Database; onDelete: () => void; deleting: boolean }) {
  const t = useTerminology();
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <Card className="border-danger/40">
        <CardTitle>{t("danger")}</CardTitle>
        <p className="mt-1 text-sm text-text-muted">
          This permanently drops the schema and the MySQL user. Snapshots will also be removed.
        </p>
        <div className="mt-4">
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Delete database
          </Button>
        </div>
      </Card>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={onDelete}
        title="Delete database"
        body="This permanently drops the schema and the MySQL user. Snapshots will also be removed."
        confirmLabel="Delete database"
        tone="danger"
        loading={deleting}
        challenge={db.name}
      />
    </>
  );
}
