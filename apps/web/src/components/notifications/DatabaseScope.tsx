import type { Database, NotificationCatalogResponse } from "@lambdata/shared";
import { Badge, Checkbox, FieldError, RadioGroup, RadioGroupItem, Skeleton, cn } from "../ui";
import { anyPerDatabase, type DestinationDraft } from "./model";

interface Props {
  catalog: NotificationCatalogResponse;
  draft: DestinationDraft;
  patch: (next: Partial<DestinationDraft>) => void;
  databases: Pick<Database, "id" | "name" | "displayName" | "kind">[] | undefined;
  loading?: boolean;
  error?: string;
}

export function DatabaseScope({ catalog, draft, patch, databases, loading = false, error }: Props) {
  if (!anyPerDatabase(catalog, draft.events)) {
    return (
      <p className="text-label text-text-muted">
        None of the events you picked belong to one database, so this does not apply: each of them is always sent.
      </p>
    );
  }

  const known = new Set((databases ?? []).map((d) => d.id));
  const missing = draft.databaseIds.filter((id) => !known.has(id));
  const chosen = new Set(draft.databaseIds);
  const toggle = (id: string, on: boolean) =>
    patch({ databaseIds: on ? [...draft.databaseIds.filter((x) => x !== id), id] : draft.databaseIds.filter((x) => x !== id) });

  return (
    <div className="space-y-3" data-invalid={error ? "" : undefined}>
      <RadioGroup value={draft.scope} onValueChange={(v) => patch({ scope: v as DestinationDraft["scope"] })} aria-label="Which databases" className="gap-3">
        <RadioGroupItem value="all" label="All databases" description="Including databases created later." />
        <RadioGroupItem value="some" label="Only the databases I pick" description="Events about other databases are not sent here." />
      </RadioGroup>

      {draft.scope === "some" && (
        <div className={cn("ml-6 rounded-md border bg-bg-inset", error ? "border-danger/50" : "border-border")}>
          {loading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-32" />
            </div>
          ) : (databases?.length ?? 0) === 0 && missing.length === 0 ? (
            <p className="p-3 text-label text-text-muted">There are no databases yet. Choose all databases to include the ones you create later.</p>
          ) : (
            <ul className="max-h-60 space-y-2.5 overflow-y-auto p-3">
              {(databases ?? []).map((db) => (
                <li key={db.id}>
                  <Checkbox
                    checked={chosen.has(db.id)}
                    onCheckedChange={(next) => toggle(db.id, next === true)}
                    label={
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {db.displayName}
                        {db.kind === "mirror" && (
                          <Badge variant="info" size="sm">
                            mirror
                          </Badge>
                        )}
                      </span>
                    }
                    description={<span className="font-mono">{db.name}</span>}
                  />
                </li>
              ))}
              {missing.map((id) => (
                <li key={id}>
                  <Checkbox
                    checked={chosen.has(id)}
                    onCheckedChange={(next) => toggle(id, next === true)}
                    label="A deleted database"
                    description={<span className="font-mono">{id}</span>}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <FieldError className="ml-6">{error}</FieldError>}
      <p className="text-micro text-text-subtle">
        Events that are not about one database, such as console users, the network policy and disk space, are always sent.
      </p>
    </div>
  );
}
