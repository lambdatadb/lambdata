import { useEffect, useRef, useState } from "react";
import { Download, GitCompareArrows, RotateCcw, ShieldCheck } from "lucide-react";
import type { Checkpoint, CheckpointEntry, WorkingCopyState } from "@lambdata/shared";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { CopyButton } from "../ui/CopyableField";
import { DescriptionItem, DescriptionList } from "../ui/DescriptionList";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "../ui/Sheet";
import { Skeleton, SkeletonRows } from "../ui/Skeleton";
import { Table, TBody, TD, TH, THead, TR } from "../ui/Table";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "../ui/Tabs";
import { SimpleTooltip } from "../ui/Tooltip";
import { QueryError } from "../layout/QueryError";
import { ApiError } from "../../lib/api";
import { formatBytes, formatDate, formatNumber, formatRelativeTime, pluralize } from "../../lib/format";
import { checkpointDownloadUrl, checkpointLimitations, HeadBadge, LegacyBadge, rollbackLabel, TriggerBadge } from "./CheckpointRow";
import { DiffList } from "./DiffList";
import { diffSummary, isLegacy } from "./meta";
import { useCheckpointDetail, useCheckpointDiff, type HistoryPermissions } from "./queries";

export interface CheckpointDrawerProps {
  databaseId: string;
  checkpointId: string | null;
  fallback: Checkpoint | null;
  byId: Map<string, Checkpoint>;
  permissions: HistoryPermissions;
  busyReason: string | null;
  workingState: WorkingCopyState | null;
  onClose: () => void;
  onOpen: (cp: Checkpoint) => void;
  onRestore: (cp: Checkpoint) => void;
}

type View = "changes" | "contents" | "working";

export function CheckpointDrawer({
  databaseId,
  checkpointId,
  fallback,
  byId,
  permissions,
  busyReason,
  workingState,
  onClose,
  onOpen,
  onRestore,
}: CheckpointDrawerProps) {
  const [view, setView] = useState<View>("changes");
  const contentRef = useRef<HTMLDivElement>(null);
  const detail = useCheckpointDetail(databaseId, checkpointId);
  const cp = detail.data?.checkpoint ?? fallback;
  const legacy = cp ? isLegacy(cp) : false;
  const working = useCheckpointDiff(databaseId, checkpointId, "working", { enabled: view === "working" && !legacy });

  useEffect(() => {
    setView("changes");
  }, [checkpointId]);

  const parent = cp?.parentId ? byId.get(cp.parentId) ?? null : null;
  const limitations = cp ? checkpointLimitations(cp) : [];
  const rollback = cp ? rollbackLabel(cp, workingState) : null;
  const blocked = rollback?.disabled ?? busyReason;
  const notFound = detail.error instanceof ApiError && detail.error.status === 404;

  return (
    <Sheet open={!!checkpointId} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        ref={contentRef}
        side="right"
        size="lg"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
      >
        <SheetHeader>
          {cp ? (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-mono text-code text-text-muted">{cp.shortHash}</span>
                {cp.isBase && <HeadBadge />}
                {legacy ? <LegacyBadge /> : <TriggerBadge cp={cp} />}
              </div>
              <SheetTitle className="break-words">{cp.message}</SheetTitle>
              <SheetDescription className="text-label">
                {cp.createdByDisplayName ?? "LambData"} · {formatRelativeTime(cp.createdAt)} · {formatDate(cp.createdAt)}
              </SheetDescription>
            </>
          ) : (
            <>
              <SheetTitle className="sr-only">Checkpoint</SheetTitle>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-6 w-64" />
            </>
          )}
        </SheetHeader>
        <SheetBody className="space-y-6">
          {notFound ? (
            <Alert variant="neutral" title="Checkpoint not found">
              It may have been deleted or removed by retention.
            </Alert>
          ) : detail.isError && !cp ? (
            <QueryError error={detail.error} title="Could not load this checkpoint" onRetry={detail.refetch} retrying={detail.isFetching} />
          ) : !cp ? (
            <SkeletonRows rows={6} label="Loading checkpoint" />
          ) : (
            <>
              <DescriptionList>
                <DescriptionItem term="Hash">
                  <span className="inline-flex max-w-full items-center gap-1">
                    <span className="min-w-0 truncate font-mono text-code" title={cp.hash}>
                      {cp.hash.slice(0, 20)}…
                    </span>
                    <CopyButton value={cp.hash} label="full hash" size="icon-xs" />
                  </span>
                </DescriptionItem>
                <DescriptionItem term="Parent">
                  {parent ? (
                    <button
                      type="button"
                      onClick={() => onOpen(parent)}
                      className="max-w-full truncate rounded-sm text-right underline decoration-border-control underline-offset-4 outline-none hover:decoration-accent focus-visible:decoration-accent"
                    >
                      <span className="font-mono text-code">{parent.shortHash}</span>{" "}
                      <span className="text-text-muted">{parent.message}</span>
                    </button>
                  ) : cp.parentId ? (
                    <span className="text-text-muted">deleted</span>
                  ) : (
                    <span className="text-text-muted">none, this is where history starts</span>
                  )}
                </DescriptionItem>
                <DescriptionItem term="Contents">
                  {cp.tableCount !== null ? pluralize(cp.tableCount, "table") : "—"}
                  {cp.rowCount !== null && ` · ${pluralize(cp.rowCount, "row")}`}
                </DescriptionItem>
                <DescriptionItem term="Size">
                  <span className="block">
                    <span className="font-mono text-code">{formatBytes(cp.logicalBytes)}</span>
                    <span className="text-text-muted"> of SQL, </span>
                    <span className="font-mono text-code">{formatBytes(cp.storedBytes)}</span>
                    <span className="text-text-muted"> compressed</span>
                  </span>
                  <span className="block text-label text-text-muted">
                    {cp.newBytes > 0 ? (
                      <>
                        <span className="font-mono text-code text-text">+{formatBytes(cp.newBytes)}</span> new on disk; the rest is shared
                      </>
                    ) : (
                      "Nothing new on disk: every table is shared with other checkpoints"
                    )}
                  </span>
                </DescriptionItem>
                <DescriptionItem term="Verified">
                  {cp.verifiedAt ? (
                    <span className="block">
                      <span className="inline-flex items-center gap-1.5 text-success">
                        <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
                        <time dateTime={new Date(cp.verifiedAt).toISOString()} title={formatDate(cp.verifiedAt)}>
                          {formatRelativeTime(cp.verifiedAt)}
                        </time>
                      </span>
                      <span className="block text-label text-text-muted">Loaded into a scratch copy and matched what was recorded</span>
                    </span>
                  ) : (
                    <span className="text-text-muted">Not verified by loading</span>
                  )}
                </DescriptionItem>
              </DescriptionList>

              {limitations.length > 0 && (
                <Alert
                  variant="warning"
                  title={`Captured with ${limitations.length === 1 ? "a limitation" : `${limitations.length} limitations`}`}
                  data-limitations={limitations.length}
                >
                  <p>Not everything could be captured exactly. You can still roll back to it, with these exceptions:</p>
                  <ul className="mt-1.5 max-h-48 list-disc space-y-1 overflow-y-auto pl-5">
                    {limitations.map((item, i) => (
                      <li key={i} className="break-words">
                        {item}
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}

              {legacy ? (
                <Alert variant="neutral" title="Converted snapshot">
                  This checkpoint was converted from a snapshot taken before checkpoints existed. It is stored as one SQL file, so
                  there is no per-table breakdown or diff. You can roll back to it and download it like any other checkpoint.
                </Alert>
              ) : (
                <TabsRoot value={view} onValueChange={(v) => setView(v as View)} className="flex min-w-0 flex-col gap-3">
                  <TabsList variant="pills" aria-label="Checkpoint details">
                    <TabsTrigger value="changes">Changes</TabsTrigger>
                    <TabsTrigger value="contents">Tables</TabsTrigger>
                    <TabsTrigger value="working">
                      <GitCompareArrows />
                      vs working copy
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="changes" className="space-y-2">
                    <p className="text-label text-text-muted">
                      {parent ? (
                        <>
                          Compared with its parent <span className="font-mono text-code text-text">{parent.shortHash}</span>
                        </>
                      ) : cp.parentId ? (
                        "Its parent was deleted, so everything is listed as added."
                      ) : (
                        "The first checkpoint: everything is new."
                      )}
                    </p>
                    {detail.isPending ? (
                      <SkeletonRows rows={3} />
                    ) : detail.data?.diffFromParent ? (
                      <>
                        <p className="text-body text-text">{diffSummary(detail.data.diffFromParent)}</p>
                        <DiffList diff={detail.data.diffFromParent} emptyLabel="Same data as its parent" />
                      </>
                    ) : (
                      <p className="text-label text-text-muted">No comparison is available: the parent was converted from an older snapshot.</p>
                    )}
                  </TabsContent>
                  <TabsContent value="contents">
                    <EntriesTable entries={detail.data?.entries} loading={detail.isPending} />
                  </TabsContent>
                  <TabsContent value="working" className="space-y-2">
                    <p className="text-label text-text-muted">
                      How the live data differs from <span className="font-mono text-code text-text">{cp.shortHash}</span>.
                    </p>
                    {working.isPending ? (
                      <SkeletonRows rows={3} label="Comparing with the live data" />
                    ) : working.isError ? (
                      <QueryError error={working.error} title="Could not compare" onRetry={working.refetch} retrying={working.isFetching} />
                    ) : (
                      <>
                        <p className="text-body text-text">{diffSummary(working.data)}</p>
                        <DiffList diff={working.data} emptyLabel="The live data is identical to this checkpoint" />
                      </>
                    )}
                  </TabsContent>
                </TabsRoot>
              )}
            </>
          )}
        </SheetBody>
        {cp && !notFound && (
          <SheetFooter>
            <Button asChild variant="secondary">
              <a href={checkpointDownloadUrl(cp)} download>
                <Download />
                Download .sql.gz
              </a>
            </Button>
            {permissions.canRestore && rollback && (
              <SimpleTooltip content={blocked} disabled={!blocked}>
                <span className="inline-flex sm:w-auto [&>button]:w-full">
                  <Button variant="danger-soft" disabled={!!blocked} onClick={() => onRestore(cp)}>
                    <RotateCcw />
                    {rollback.label.replace("…", "")}
                  </Button>
                </span>
              </SimpleTooltip>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

function EntriesTable({ entries, loading }: { entries: CheckpointEntry[] | undefined; loading: boolean }) {
  if (loading) return <SkeletonRows rows={4} label="Loading tables" />;
  const list = entries ?? [];
  const tables = list.filter((e) => e.kind === "table");
  const code = list.find((e) => e.kind === "code");
  return (
    <Table caption="Tables in this checkpoint">
      <THead>
        <TR>
          <TH>Table</TH>
          <TH numeric>Rows</TH>
          <TH numeric>SQL</TH>
          <TH numeric className="hidden sm:table-cell">
            Stored
          </TH>
        </TR>
      </THead>
      <TBody>
        {tables.map((e) => (
          <TR key={e.name}>
            <TD mono className="max-w-[12rem] truncate" title={`${e.name} · object ${e.objectHash.slice(0, 12)}`}>
              {e.name}
            </TD>
            <TD numeric>{formatNumber(e.rowCount)}</TD>
            <TD numeric>{formatBytes(e.logicalBytes)}</TD>
            <TD numeric className="hidden text-text-muted sm:table-cell">
              {formatBytes(e.storedBytes)}
            </TD>
          </TR>
        ))}
        {code && (
          <TR>
            <TD className="text-text-muted">Views, triggers and routines</TD>
            <TD numeric className="text-text-subtle">—</TD>
            <TD numeric>{formatBytes(code.logicalBytes)}</TD>
            <TD numeric className="hidden text-text-muted sm:table-cell">
              {formatBytes(code.storedBytes)}
            </TD>
          </TR>
        )}
        {tables.length === 0 && !code && (
          <tr>
            <td colSpan={4} className="px-4 py-6 text-center text-body text-text-muted">
              This checkpoint has no tables.
            </td>
          </tr>
        )}
      </TBody>
    </Table>
  );
}
