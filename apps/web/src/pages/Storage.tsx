import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StorageBucket, StorageObject } from "@kilndb/shared";
import { api, ApiError } from "../lib/api";
import { PageHeader } from "../components/layout/PageShell";
import { Card, CardTitle, SectionLabel } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Dialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { Field, Input } from "../components/ui/Input";
import { Skeleton, SkeletonRows } from "../components/ui/Skeleton";
import { StatTile } from "../components/ui/StatTile";
import { Switch } from "../components/ui/Switch";
import { Table, TBody, TD, TH, THead, TR, TableEmpty, TableSkeleton } from "../components/ui/Table";
import { Icon } from "../components/ui/Icon";
import { useToast } from "../components/ui/Toast";
import { useAuth } from "../lib/auth";
import { formatBytes, formatDate, formatRelativeTime } from "../lib/format";
import { cn } from "../components/ui/cn";

export function Storage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null);
  const [bucketToDelete, setBucketToDelete] = useState<StorageBucket | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const bucketsQuery = useQuery({
    queryKey: ["storage", "buckets"],
    queryFn: () => api.get<{ buckets: StorageBucket[] }>("/storage/buckets"),
  });
  const buckets = bucketsQuery.data?.buckets ?? [];
  const selectedBucket = useMemo(
    () => buckets.find((b) => b.id === selectedBucketId) ?? buckets[0] ?? null,
    [buckets, selectedBucketId],
  );
  const canWrite = user?.role !== "viewer";

  const objectsQuery = useQuery({
    queryKey: ["storage", "objects", selectedBucket?.id],
    queryFn: () =>
      api.get<{ objects: StorageObject[] }>(`/storage/buckets/${selectedBucket!.id}/objects`),
    enabled: !!selectedBucket,
  });
  const objects = objectsQuery.data?.objects ?? [];

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedBucket) throw new Error("No bucket selected");
      const body = new FormData();
      body.append("file", file);
      return api.postForm<{ object: StorageObject }>(
        `/storage/buckets/${selectedBucket.id}/objects?upsert=1`,
        body,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["storage"] });
      toast.show("Object uploaded", "success");
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "upload failed", "error"),
  });

  const deleteObject = useMutation({
    mutationFn: (objectId: string) =>
      api.delete(`/storage/buckets/${selectedBucket!.id}/objects/${objectId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["storage"] });
      toast.show("Object deleted", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "delete failed", "error"),
  });

  const deleteBucket = useMutation({
    mutationFn: (bucketId: string) => api.delete(`/storage/buckets/${bucketId}`),
    onSuccess: () => {
      setSelectedBucketId(null);
      setBucketToDelete(null);
      qc.invalidateQueries({ queryKey: ["storage"] });
      toast.show("Bucket deleted", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "delete failed", "error"),
  });

  const totalObjects = buckets.reduce((sum, b) => sum + b.objectCount, 0);
  const totalBytes = buckets.reduce((sum, b) => sum + b.totalSizeBytes, 0);

  return (
    <>
      <PageHeader
        title="Storage"
        subtitle="Self-hosted object buckets backed by the KilnDB data directory."
        actions={
          canWrite && (
            <Button onClick={() => setCreateOpen(true)}>
              <Icon name="create_new_folder" size={15} />
              New bucket
            </Button>
          )
        }
      />

      {bucketsQuery.isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-6 w-24" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          <StatTile label="Buckets" icon="folder" value={buckets.length} />
          <StatTile label="Objects" icon="deployed_code" value={totalObjects} />
          <StatTile label="Stored" icon="hard_drive" value={totalBytes} format={formatBytes} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-5">
        <Card className="p-0 overflow-hidden">
          <div className="p-5 border-b border-border">
            <SectionLabel>Bucket registry</SectionLabel>
            <p className="text-body text-text-muted">
              Buckets are private by default. Public buckets expose read-only file URLs.
            </p>
          </div>
          {bucketsQuery.isLoading ? (
            <div className="p-5">
              <SkeletonRows rows={4} />
            </div>
          ) : buckets.length === 0 ? (
            <EmptyState
              className="border-0 bg-transparent shadow-none"
              icon="folder"
              title="No storage buckets yet"
              action={
                canWrite ? (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Icon name="create_new_folder" size={14} />
                    New bucket
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="divide-y divide-border">
              {buckets.map((bucket) => (
                <button
                  key={bucket.id}
                  type="button"
                  onClick={() => setSelectedBucketId(bucket.id)}
                  className={cn(
                    "w-full px-5 py-4 text-left transition-colors hover:bg-bg-subtle/50",
                    selectedBucket?.id === bucket.id && "bg-bg-subtle",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Icon
                          name={bucket.public ? "public" : "folder"}
                          size={17}
                          className={bucket.public ? "text-success" : "text-accent"}
                        />
                        <span className="font-semibold truncate">{bucket.name}</span>
                      </div>
                      <div className="mt-1 font-mono text-micro text-text-subtle">
                        {bucket.objectCount.toLocaleString()} objects · {formatBytes(bucket.totalSizeBytes)}
                      </div>
                    </div>
                    <Badge tone={bucket.public ? "success" : "muted"}>
                      {bucket.public ? "Public" : "Private"}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-0 overflow-hidden">
          {!selectedBucket ? (
            <EmptyState
              className="border-0 bg-transparent shadow-none"
              icon="folder_open"
              title="No bucket selected"
              description="Create a bucket to start storing objects."
            />
          ) : (
            <>
              <div className="p-5 border-b border-border flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle>{selectedBucket.name}</CardTitle>
                    <Badge tone={selectedBucket.public ? "success" : "muted"}>
                      {selectedBucket.public ? "Public" : "Private"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-body text-text-muted">
                    Created {formatRelativeTime(selectedBucket.createdAt)} · owned by{" "}
                    {selectedBucket.ownerDisplayName ?? "system"}
                  </p>
                </div>
                {canWrite && (
                  <div className="flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.currentTarget.files?.[0];
                        if (file) upload.mutate(file);
                      }}
                    />
                    <Button
                      variant="secondary"
                      loading={upload.isPending}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Icon name="upload_file" size={15} />
                      Upload
                    </Button>
                    <Button variant="danger" onClick={() => setBucketToDelete(selectedBucket)}>
                      <Icon name="delete" size={15} />
                      Delete
                    </Button>
                  </div>
                )}
              </div>

              <ObjectTable
                bucket={selectedBucket}
                objects={objects}
                loading={objectsQuery.isLoading}
                canWrite={canWrite}
                deletingId={deleteObject.variables}
                deleting={deleteObject.isPending}
                onDelete={(objectId) => deleteObject.mutate(objectId)}
              />
            </>
          )}
        </Card>
      </div>

      <CreateBucketDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <ConfirmDialog
        open={!!bucketToDelete}
        onClose={() => setBucketToDelete(null)}
        onConfirm={() => bucketToDelete && deleteBucket.mutate(bucketToDelete.id)}
        title="Delete bucket"
        body={
          <>
            The <span className="font-mono text-text">{bucketToDelete?.name}</span> bucket and all
            of its objects are permanently removed.
          </>
        }
        confirmLabel="Delete bucket"
        tone="danger"
        loading={deleteBucket.isPending}
      />
    </>
  );
}

function ObjectTable({
  bucket,
  objects,
  loading,
  canWrite,
  deletingId,
  deleting,
  onDelete,
}: {
  bucket: StorageBucket;
  objects: StorageObject[];
  loading: boolean;
  canWrite: boolean;
  deletingId?: string;
  deleting: boolean;
  onDelete: (objectId: string) => void;
}) {
  return (
    <Table flush>
      <THead>
        <tr>
          <TH>Name</TH>
          <TH>Type</TH>
          <TH className="text-right">Size</TH>
          <TH>Updated</TH>
          <TH className="text-right">Actions</TH>
        </tr>
      </THead>
      <TBody>
        {loading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : objects.length === 0 ? (
          <TableEmpty colSpan={5}>No objects in this bucket.</TableEmpty>
        ) : (
          objects.map((object) => {
            const downloadUrl = `/api/storage/buckets/${bucket.id}/objects/${object.id}/download`;
            const publicUrl = bucket.public
              ? `/api/storage/public/${encodeURIComponent(bucket.name)}/${encodeObjectPath(object.name)}`
              : null;
            return (
              <TR key={object.id}>
                <TD>
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon name="draft" size={16} className="text-text-muted shrink-0" />
                    <div className="min-w-0">
                      <div className="font-mono text-label text-text truncate">{object.name}</div>
                      {publicUrl && (
                        <a
                          href={publicUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-micro text-success hover:underline"
                        >
                          public URL
                        </a>
                      )}
                    </div>
                  </div>
                </TD>
                <TD className="font-mono text-label text-text-muted whitespace-nowrap">
                  {object.mimeType ?? "application/octet-stream"}
                </TD>
                <TD numeric className="text-label text-text-muted whitespace-nowrap">
                  {formatBytes(object.sizeBytes)}
                </TD>
                <TD className="text-text-muted whitespace-nowrap">
                  {formatDate(object.updatedAt)}
                </TD>
                <TD className="whitespace-nowrap">
                  <div className="flex items-center justify-end gap-2">
                    <a
                      href={downloadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-bg-subtle px-3 text-label font-medium text-text-muted hover:text-text hover:border-border-strong transition-colors"
                    >
                      <Icon name="download" size={14} />
                      Open
                    </a>
                    {canWrite && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={deleting && deletingId === object.id}
                        onClick={() => onDelete(object.id)}
                      >
                        <Icon name="delete" size={14} />
                      </Button>
                    )}
                  </div>
                </TD>
              </TR>
            );
          })
        )}
      </TBody>
    </Table>
  );
}

function CreateBucketDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [isPublic, setPublic] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.post<{ bucket: StorageBucket }>("/storage/buckets", {
        name,
        public: isPublic,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["storage", "buckets"] });
      setName("");
      setPublic(false);
      onClose();
      toast.show("Bucket created", "success");
    },
    onError: (e) => toast.show(e instanceof ApiError ? e.message : "create failed", "error"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New storage bucket"
      description="Create a local bucket for files, exports, and app assets."
    >
      <div className="space-y-4">
        <Field label="Bucket name" hint="3-63 lowercase letters, numbers, underscores, or hyphens.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="avatars"
            autoFocus
          />
        </Field>
        <Switch
          checked={isPublic}
          onChange={setPublic}
          label="Public read URLs"
          description="Objects in this bucket can be read without signing in."
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
            Create bucket
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function encodeObjectPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}
