import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { StorageBucket } from "@lambdata/shared";
import { Boxes, FolderPlus, Globe, HardDrive, Lock, PackageOpen, RotateCcw } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatBytes, pluralize } from "../lib/format";
import { PageHeader } from "../components/layout/PageShell";
import { Alert, Button, Card, CardHeader, EmptyState, Skeleton, StatTile, cn } from "../components/ui";
import { BucketDetail } from "../components/storage/BucketDetail";
import { CreateBucketDialog } from "../components/storage/CreateBucketDialog";

export function Storage() {
  const { user } = useAuth();
  const canWrite = user?.role !== "viewer";
  const [createOpen, setCreateOpen] = useState(false);
  const [params, setParams] = useSearchParams();

  const bucketsQuery = useQuery({
    queryKey: ["storage", "buckets"],
    queryFn: () => api.get<{ buckets: StorageBucket[] }>("/storage/buckets"),
  });
  const buckets = bucketsQuery.data?.buckets ?? [];
  const selected = buckets.find((b) => b.id === params.get("bucket")) ?? buckets[0] ?? null;
  const totalObjects = buckets.reduce((sum, b) => sum + (Number(b.objectCount) || 0), 0);
  const totalBytes = buckets.reduce((sum, b) => sum + (Number(b.totalSizeBytes) || 0), 0);
  const loading = bucketsQuery.isPending;

  const selectBucket = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("bucket", id);
    else next.delete("bucket");
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Storage"
        subtitle="Buckets of files kept in the LambData data directory, private unless you make them public."
        actions={
          canWrite ? (
            <Button onClick={() => setCreateOpen(true)}>
              <FolderPlus aria-hidden /> New bucket
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Buckets" icon={Boxes} loading={loading} value={bucketsQuery.data ? buckets.length : null} />
          <StatTile label="Objects" icon={PackageOpen} loading={loading} value={bucketsQuery.data ? totalObjects : null} />
          <StatTile
            label="Stored"
            className="col-span-2 sm:col-span-1"
            icon={HardDrive}
            loading={loading}
            value={bucketsQuery.data ? totalBytes : null}
            format={formatBytes}
          />
        </div>

        {bucketsQuery.isError ? (
          <Alert
            variant="danger"
            title="Could not load buckets"
            action={
              <Button size="xs" variant="secondary" onClick={() => bucketsQuery.refetch()}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            }
          >
            {errorMessage(bucketsQuery.error, "The server did not answer.")}
          </Alert>
        ) : loading ? (
          <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]" aria-busy="true">
            <Card className="space-y-4">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            </Card>
            <Card className="space-y-4">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-32 w-full" />
            </Card>
          </div>
        ) : buckets.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="No buckets yet"
            description={
              canWrite
                ? "Create a bucket to store uploads, exports or app assets. Buckets are private unless you make them public."
                : "Buckets that you are allowed to read appear here."
            }
            action={
              canWrite ? (
                <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
                  <FolderPlus aria-hidden /> New bucket
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
            <Card flush>
              <CardHeader divided title="Buckets" />
              <nav aria-label="Buckets">
                <ul className="space-y-0.5 p-2">
                  {buckets.map((bucket) => {
                    const active = bucket.id === selected?.id;
                    const next = new URLSearchParams(params);
                    next.set("bucket", bucket.id);
                    return (
                      <li key={bucket.id}>
                        <Link
                          to={`?${next.toString()}`}
                          replace
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-ring/70",
                            active &&
                              "bg-bg-selected text-text before:absolute before:left-0 before:top-2 before:h-[calc(100%-1rem)] before:w-0.5 before:rounded-full before:bg-accent",
                          )}
                        >
                          {bucket.public ? (
                            <Globe className="size-4 shrink-0 text-warn" aria-label="Public" />
                          ) : (
                            <Lock className="size-4 shrink-0 text-text-subtle" aria-label="Private" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-code">{bucket.name}</span>
                            <span className="block truncate text-micro text-text-subtle">
                              {pluralize(Number(bucket.objectCount), "object")} · {formatBytes(Number(bucket.totalSizeBytes))}
                            </span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            </Card>
            {selected && (
              <BucketDetail key={selected.id} bucket={selected} canWrite={canWrite} onDeleted={() => selectBucket(null)} />
            )}
          </div>
        )}
      </div>
      <CreateBucketDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(bucket) => selectBucket(bucket.id)}
      />
    </>
  );
}
