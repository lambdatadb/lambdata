import { useEffect, useRef, useState, type ReactElement } from "react";
import { ArrowUpToLine, Trash2, TriangleAlert } from "lucide-react";
import type { Database, SetAsideSchema, SetAsideTable } from "@lambdata/shared";
import { Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, Field, Input, SimpleTooltip, toast } from "../ui";
import { errorMessage } from "../../lib/api";
import { formatBytes, formatDate, formatNumber, formatRelativeTime, pluralize } from "../../lib/format";
import { SET_ASIDE_TEXT, suggestedName, tableNameError, useSetAsideActions } from "./setAside";

const KIND_TITLE: Record<SetAsideSchema["kind"], string> = {
  quarantine: "A new table caught during a swap",
  kept: "A table that could not be put back",
};

function rowsText(rows: number | null): string {
  return rows === null ? "rows unknown" : rows === 1 ? "1 row" : `${formatNumber(rows)} rows`;
}

function tableFacts(t: SetAsideTable): string {
  return [rowsText(t.rowCount), t.sizeBytes !== null ? formatBytes(t.sizeBytes) : null, t.nameFreeInDatabase ? null : "its name is in use in the database"]
    .filter(Boolean)
    .join(" · ");
}

export function MoveBackAsFields({
  table,
  value,
  onChange,
  error,
}: {
  table: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
}) {
  return (
    <div className="space-y-4">
      <p className="text-body text-text-muted">
        <span className="font-mono text-code text-text">{table}</span> is in use in the database, so this one needs another name. It
        arrives with its rows and indexes as they are now.
      </p>
      <Field label="New name" required error={error ?? undefined} hint="Letters, numbers, _ and $, up to 64 characters.">
        <Input mono value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} maxLength={64} />
      </Field>
    </div>
  );
}

function MoveBackAsDialog({
  db,
  target,
  onClose,
}: {
  db: Database;
  target: { schema: string; table: SetAsideTable } | null;
  onClose: () => void;
}) {
  const { moveBack } = useSetAsideActions(db.id);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!target) return;
    setName(suggestedName(target.table.name));
    setTouched(false);
    moveBack.reset();
  }, [target]);

  const problem = target ? tableNameError(name, target.table.name) : null;
  const shown = touched ? problem : null;
  const submit = () => {
    if (!target) return;
    setTouched(true);
    if (problem) return;
    moveBack.mutate(
      { schema: target.schema, body: { table: target.table.name, as: name.trim() } },
      {
        onSuccess: (res) => {
          onClose();
          toast.success(`${res.table} is back in ${db.name} as ${res.movedTo}`, {
            description: res.schemaRemoved ? "Nothing else was set aside there." : undefined,
          });
        },
      },
    );
  };

  return (
    <Dialog
      open={!!target}
      onClose={() => !moveBack.isPending && onClose()}
      title="Move back under another name"
      initialFocus={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={moveBack.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="move-back-as-form" loading={moveBack.isPending}>
            <ArrowUpToLine aria-hidden /> Move back
          </Button>
        </>
      }
    >
      <form
        id="move-back-as-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {target && (
          <MoveBackAsFields
            table={target.table.name}
            value={name}
            onChange={(v) => {
              setTouched(true);
              moveBack.reset();
              setName(v);
            }}
            error={shown ?? (moveBack.error ? errorMessage(moveBack.error) : null)}
          />
        )}
      </form>
    </Dialog>
  );
}

export function deleteSummary(schema: SetAsideSchema): string {
  return schema.tables.map((t) => `${t.name} (${rowsText(t.rowCount)})`).join(", ");
}

interface CardProps {
  db: Database;
  schemas: SetAsideSchema[];
  canAct: boolean;
  busyReason?: string | null;
}

export function SetAsideCard({ db, schemas, canAct, busyReason = null }: CardProps) {
  const { moveBack, remove } = useSetAsideActions(db.id);
  const [renaming, setRenaming] = useState<{ schema: string; table: SetAsideTable } | null>(null);
  const [deleting, setDeleting] = useState<SetAsideSchema | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const visible = schemas.filter((s) => s.tables.length > 0);
  if (visible.length === 0) return null;
  const tableCount = visible.reduce((n, s) => n + s.tables.length, 0);

  const moveFree = (schema: string, table: SetAsideTable) => {
    const key = `${schema}/${table.name}`;
    setMoving(key);
    moveBack.mutate(
      { schema, body: { table: table.name } },
      {
        onSuccess: (res) =>
          toast.success(`${res.movedTo} is back in ${db.name}`, {
            description: res.schemaRemoved ? "Nothing else was set aside there." : undefined,
          }),
        onError: (e) => toast.error(`Could not move ${table.name} back`, { description: errorMessage(e) }),
        onSettled: () => setMoving(null),
      },
    );
  };

  const confirmDelete = () => {
    if (!deleting) return;
    const target = deleting;
    remove.mutate(target.schema, {
      onSuccess: () => {
        setDeleting(null);
        toast.success(target.tables.length === 1 ? `${target.tables[0]!.name} deleted` : `${target.tables.length} tables deleted`);
      },
      onError: (e) => toast.error("Could not delete the tables", { description: errorMessage(e) }),
    });
  };

  const gate = (button: ReactElement) =>
    busyReason ? (
      <SimpleTooltip content={busyReason}>
        <span className="inline-flex">{button}</span>
      </SimpleTooltip>
    ) : (
      button
    );

  return (
    <Card flush className="border-warn/40" data-set-aside={tableCount} aria-label="Tables set aside">
      <CardHeader
        divided
        title={
          <span className="flex items-center gap-2">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-warn" />
            Tables set aside
          </span>
        }
        description={
          canAct
            ? "They sit outside the database, so your apps and checkpoints do not see them. Move each one back or delete it."
            : "They sit outside the database, so your apps and checkpoints do not see them. The database's owner or an admin can move them back or delete them."
        }
        action={
          <Badge variant="warn" size="sm">
            {pluralize(tableCount, "table")}
          </Badge>
        }
      />
      <ul className="divide-y divide-border">
        {visible.map((s) => {
          const text = SET_ASIDE_TEXT[s.kind];
          return (
            <li key={s.schema} className="space-y-3 px-4 py-4 sm:px-5" data-set-aside-kind={s.kind}>
              <div className="space-y-1">
                <p className="text-body font-medium text-text">{KIND_TITLE[s.kind]}</p>
                <p className="max-w-3xl text-label text-text-muted">
                  {text.lead} {canAct ? text.next : ""}
                </p>
                <p className="flex flex-wrap gap-x-2 text-micro text-text-subtle">
                  {s.createdAt && <span title={formatDate(s.createdAt)}>Set aside {formatRelativeTime(s.createdAt)}</span>}
                  {s.sizeBytes !== null && <span>{formatBytes(s.sizeBytes)}</span>}
                  <span className="min-w-0 truncate font-mono" title={s.schema}>
                    {s.schema}
                  </span>
                </p>
              </div>
              <ul className="divide-y divide-border rounded-md border border-border bg-bg-inset">
                {s.tables.map((t) => {
                  const key = `${s.schema}/${t.name}`;
                  return (
                    <li key={t.name} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5" data-set-aside-table={t.name}>
                      <div className="min-w-0">
                        <p className="truncate font-mono text-code text-text" title={t.name}>
                          {t.name}
                        </p>
                        <p className="text-micro text-text-subtle">{tableFacts(t)}</p>
                      </div>
                      {canAct &&
                        gate(
                          <Button
                            variant="secondary"
                            size="xs"
                            disabled={!!busyReason || (moving !== null && moving !== key)}
                            loading={moving === key}
                            onClick={() => (t.nameFreeInDatabase ? moveFree(s.schema, t) : setRenaming({ schema: s.schema, table: t }))}
                          >
                            <ArrowUpToLine aria-hidden />
                            {t.nameFreeInDatabase ? "Move back" : "Move back as…"}
                          </Button>,
                        )}
                    </li>
                  );
                })}
              </ul>
              {canAct && (
                <div className="flex justify-end">
                  {gate(
                    <Button variant="danger-soft" size="xs" disabled={!!busyReason} onClick={() => setDeleting(s)}>
                      <Trash2 aria-hidden />
                      {s.tables.length === 1 ? "Delete…" : "Delete all…"}
                    </Button>,
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {canAct && (
        <>
          <MoveBackAsDialog db={db} target={renaming} onClose={() => setRenaming(null)} />
          <ConfirmDialog
            open={!!deleting}
            onClose={() => !remove.isPending && setDeleting(null)}
            onConfirm={confirmDelete}
            tone="danger"
            loading={remove.isPending}
            title={deleting && deleting.tables.length === 1 ? `Delete ${deleting.tables[0]!.name}?` : "Delete these tables?"}
            description={
              deleting ? (
                <>
                  <span className="block">
                    This drops <span className="font-mono text-code text-text">{deleteSummary(deleting)}</span> from the server.
                  </span>
                  <span className="mt-2 block font-medium text-text">This cannot be undone.</span>
                </>
              ) : undefined
            }
            confirmLabel={deleting && deleting.tables.length === 1 ? "Delete table" : "Delete tables"}
          />
        </>
      )}
    </Card>
  );
}
