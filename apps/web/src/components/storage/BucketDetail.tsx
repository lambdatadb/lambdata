import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StorageBucket, StorageObject } from "@lambdata/shared";
import { Download, Ellipsis, Eye, File as FileIcon, FolderOpen, Globe, Lock, RotateCcw, Trash2, X } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  CopyButton,
  CopyableField,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FileDropzone,
  Progress,
  SimpleTooltip,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableSkeleton,
  useToast,
} from "../ui";
import { api, absoluteUrl, errorMessage } from "../../lib/api";
import { formatBytes, formatDate, formatRelativeTime } from "../../lib/format";
import { MAX_UPLOAD_BYTES, canPreviewInline, downloadPath, previewPath, publicObjectPath, uploadObject } from "./upload";

export function objectsKey(bucketId: string) {
  return ["storage", "objects", bucketId] as const;
}

interface UploadState {
  name: string;
  index: number;
  total: number;
  progress: number;
}

interface Props {
  bucket: StorageBucket;
  canWrite: boolean;
  onDeleted: () => void;
}

export function BucketDetail({ bucket, canWrite, onDeleted }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [replace, setReplace] = useState<{ files: File[]; existing: string[] } | null>(null);
  const [objectToDelete, setObjectToDelete] = useState<StorageObject | null>(null);
  const [deleteBucketOpen, setDeleteBucketOpen] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);

  const objectsQuery = useQuery({
    queryKey: objectsKey(bucket.id),
    queryFn: () => api.get<{ objects: StorageObject[] }>(`/storage/buckets/${encodeURIComponent(bucket.id)}/objects`),
  });
  const objects = objectsQuery.data?.objects ?? [];

  const deleteObject = useMutation({
    mutationFn: (objectId: string) =>
      api.delete(`/storage/buckets/${encodeURIComponent(bucket.id)}/objects/${encodeURIComponent(objectId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["storage"] }),
  });

  const deleteBucket = useMutation({
    mutationFn: () => api.delete(`/storage/buckets/${encodeURIComponent(bucket.id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["storage"] }),
  });

  const runUploads = async (files: File[], upsert: boolean) => {
    let done = 0;
    for (const [index, file] of files.entries()) {
      setUpload({ name: file.name, index, total: files.length, progress: 0 });
      const handle = uploadObject(bucket.id, file, {
        upsert,
        onProgress: (progress) => setUpload((u) => (u ? { ...u, progress } : u)),
      });
      abortRef.current = handle.abort;
      try {
        await handle.promise;
        done += 1;
      } catch (e) {
        toast.error(`${file.name} was not uploaded`, { description: errorMessage(e, "Upload failed") });
        if (e instanceof Error && e.message === "Upload cancelled") break;
      }
    }
    abortRef.current = null;
    setUpload(null);
    qc.invalidateQueries({ queryKey: ["storage"] });
    if (done > 0) toast.success(done === 1 ? "1 object uploaded" : `${done} objects uploaded`);
  };

  const startUpload = (files: File[]) => {
    const names = new Set(objects.map((o) => o.name));
    const existing = files.filter((f) => names.has(f.name)).map((f) => f.name);
    if (existing.length > 0) {
      setReplace({ files, existing });
      return;
    }
    void runUploads(files, false);
  };

  const publicPrefix = bucket.public ? absoluteUrl(`/api/storage/public/${encodeURIComponent(bucket.name)}/`) : null;

  return (
    <Card flush>
      <CardHeader
        divided
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-mono">{bucket.name}</span>
            {bucket.public ? (
              <Badge variant="warn">
                <Globe aria-hidden /> Public
              </Badge>
            ) : (
              <Badge variant="muted">
                <Lock aria-hidden /> Private
              </Badge>
            )}
          </span>
        }
        description={`${Number(bucket.objectCount).toLocaleString()} ${Number(bucket.objectCount) === 1 ? "object" : "objects"} · ${formatBytes(Number(bucket.totalSizeBytes))} · created ${formatRelativeTime(bucket.createdAt)}${bucket.ownerDisplayName ? ` by ${bucket.ownerDisplayName}` : ""}`}
        action={
          canWrite ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for bucket ${bucket.name}`}>
                  <Ellipsis aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="danger" onSelect={() => setDeleteBucketOpen(true)}>
                  <Trash2 aria-hidden /> Delete bucket
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />

      {(publicPrefix || canWrite) && (
        <div className="space-y-4 border-b border-border px-5 py-4">
          {publicPrefix && (
            <CopyableField label="Public URL prefix" value={publicPrefix} copyLabel="public URL prefix" size="sm" />
          )}
          {canWrite &&
            (upload ? (
              <div className="flex items-end gap-3">
                <Progress
                  className="min-w-0 flex-1"
                  value={Math.round(upload.progress * 100)}
                  showValue
                  label={
                    <>
                      Uploading <span className="font-mono text-text">{upload.name}</span>
                      {upload.total > 1 ? ` (${upload.index + 1} of ${upload.total})` : ""}
                    </>
                  }
                />
                <SimpleTooltip content="Cancel upload">
                  <Button variant="ghost" size="icon-xs" aria-label="Cancel upload" onClick={() => abortRef.current?.()}>
                    <X aria-hidden />
                  </Button>
                </SimpleTooltip>
              </div>
            ) : (
              <FileDropzone
                compact
                multiple
                maxSize={MAX_UPLOAD_BYTES}
                aria-label={`Upload files to ${bucket.name}`}
                description="Up to 250 MB per file. Existing names ask before they are replaced."
                onFiles={startUpload}
              />
            ))}
        </div>
      )}

      {objectsQuery.isError ? (
        <div className="p-5">
          <Alert
            variant="danger"
            title="Could not list objects"
            action={
              <Button size="xs" variant="secondary" onClick={() => objectsQuery.refetch()}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            }
          >
            {errorMessage(objectsQuery.error, "The server did not answer.")}
          </Alert>
        </div>
      ) : !objectsQuery.isPending && objects.length === 0 ? (
        <EmptyState
          variant="bare"
          size="sm"
          icon={FolderOpen}
          title="This bucket is empty"
          description={canWrite ? "Drop a file above to add the first object." : "Objects added to this bucket appear here."}
        />
      ) : (
        <Table flush caption={`Objects in ${bucket.name}`}>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH numeric>Size</TH>
              <TH className="hidden md:table-cell">Type</TH>
              <TH className="hidden lg:table-cell">Updated</TH>
              <TH className="w-px">
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {objectsQuery.isPending ? (
              <TableSkeleton rows={4} cols={3} />
            ) : (
              objects.map((object) => (
                <TR key={object.id}>
                  <TD className="max-w-0 w-full">
                    <div className="flex min-w-0 items-center gap-2">
                      <FileIcon className="size-4 shrink-0 text-text-subtle" aria-hidden />
                      <span className="truncate font-mono text-code text-text" title={object.name}>
                        {object.name}
                      </span>
                    </div>
                  </TD>
                  <TD numeric className="text-text-muted">
                    {formatBytes(Number(object.sizeBytes))}
                  </TD>
                  <TD mono className="hidden whitespace-nowrap text-text-muted md:table-cell">
                    {object.mimeType ?? "application/octet-stream"}
                  </TD>
                  <TD className="hidden whitespace-nowrap text-text-muted lg:table-cell" title={formatDate(object.updatedAt)}>
                    {formatRelativeTime(object.updatedAt)}
                  </TD>
                  <TD className="whitespace-nowrap">
                    <div className="flex items-center justify-end gap-0.5">
                      {bucket.public && (
                        <CopyButton
                          value={absoluteUrl(publicObjectPath(bucket.name, object.name))}
                          label={`public URL of ${object.name}`}
                          size="icon-xs"
                        />
                      )}
                      {canPreviewInline(object.mimeType) && (
                        <SimpleTooltip content="Open in a new tab">
                          <Button asChild variant="ghost" size="icon-xs">
                            <a
                              href={previewPath(bucket.id, object.id)}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open ${object.name} in a new tab`}
                            >
                              <Eye aria-hidden />
                            </a>
                          </Button>
                        </SimpleTooltip>
                      )}
                      <SimpleTooltip content="Download">
                        <Button asChild variant="ghost" size="icon-xs">
                          <a href={downloadPath(bucket.id, object.id)} download aria-label={`Download ${object.name}`}>
                            <Download aria-hidden />
                          </a>
                        </Button>
                      </SimpleTooltip>
                      {canWrite && (
                        <SimpleTooltip content="Delete">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Delete ${object.name}`}
                            loading={deleteObject.isPending && deleteObject.variables === object.id}
                            onClick={() => setObjectToDelete(object)}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </SimpleTooltip>
                      )}
                    </div>
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      )}

      <ConfirmDialog
        open={replace !== null}
        onClose={() => setReplace(null)}
        onConfirm={() => {
          const pending = replace;
          setReplace(null);
          if (pending) void runUploads(pending.files, true);
        }}
        title={replace?.existing.length === 1 ? "Replace an existing object?" : `Replace ${replace?.existing.length} existing objects?`}
        confirmLabel="Replace"
        cancelLabel="Cancel upload"
        body={
          <>
            <span className="font-mono text-text">{replace?.existing.slice(0, 3).join(", ")}</span>
            {(replace?.existing.length ?? 0) > 3 ? ", …" : ""} already {replace?.existing.length === 1 ? "exists" : "exist"} in{" "}
            {bucket.name}. Replacing overwrites the stored file; links to it keep working.
          </>
        }
      />
      <ConfirmDialog
        open={objectToDelete !== null}
        onClose={() => setObjectToDelete(null)}
        onConfirm={() =>
          objectToDelete &&
          deleteObject.mutate(objectToDelete.id, {
            onSuccess: () => {
              toast.success(`${objectToDelete.name} deleted`);
              setObjectToDelete(null);
            },
            onError: (e) => toast.error(errorMessage(e, "Could not delete the object")),
          })
        }
        loading={deleteObject.isPending}
        tone="danger"
        title="Delete this object?"
        confirmLabel="Delete object"
        body={
          <>
            <span className="font-mono text-text">{objectToDelete?.name}</span> (
            {formatBytes(Number(objectToDelete?.sizeBytes ?? 0))}) is removed for good
            {bucket.public ? " and its public URL stops working" : ""}.
          </>
        }
      />
      <ConfirmDialog
        open={deleteBucketOpen}
        onClose={() => setDeleteBucketOpen(false)}
        onConfirm={() =>
          deleteBucket.mutate(undefined, {
            onSuccess: () => {
              toast.success(`Bucket ${bucket.name} deleted`);
              setDeleteBucketOpen(false);
              onDeleted();
            },
            onError: (e) => toast.error(errorMessage(e, "Could not delete the bucket")),
          })
        }
        loading={deleteBucket.isPending}
        tone="danger"
        challenge={bucket.name}
        title={`Delete ${bucket.name}?`}
        confirmLabel="Delete bucket"
        body={`The bucket and its ${Number(bucket.objectCount).toLocaleString()} ${Number(bucket.objectCount) === 1 ? "object" : "objects"} (${formatBytes(Number(bucket.totalSizeBytes))}) are removed for good. This cannot be undone.`}
      />
    </Card>
  );
}
