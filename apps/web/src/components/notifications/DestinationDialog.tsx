import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { Database, NotificationCatalogResponse, NotificationDestination, NotificationKind } from "@lambdata/shared";
import { Alert, Button, Dialog, Field, FieldError, Input, RadioCard, RadioGroup } from "../ui";
import { errorMessage } from "../../lib/api";
import { useDatabases } from "../../lib/queries";
import { ConnectionFields } from "./ConnectionFields";
import { DatabaseScope } from "./DatabaseScope";
import { EventPicker } from "./EventPicker";
import { IconField } from "./IconField";
import {
  KIND_ORDER,
  KINDS,
  NAME_MAX,
  createRequest,
  draftFrom,
  isEmptyUpdate,
  newDraft,
  updateRequest,
  useDestinationMutations,
  validateDraft,
  type DestinationDraft,
  type DraftErrors,
  type DraftMode,
} from "./model";

export const FORM_ID = "notification-destination-form";

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-6 first:border-t-0 first:pt-0">
      <div className="space-y-0.5">
        <h3 className="text-heading font-semibold text-text">{title}</h3>
        {description && <p className="text-label text-text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function KindPicker({ value, onChange, error }: { value: NotificationKind | null; onChange: (kind: NotificationKind) => void; error?: string }) {
  const compact = value !== null;
  return (
    <div className="space-y-2" data-invalid={error ? "" : undefined}>
      <RadioGroup
        value={value ?? ""}
        onValueChange={(v) => onChange(v as NotificationKind)}
        aria-label="Where to send"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {KIND_ORDER.map((kind) => {
          const Icon = KINDS[kind].icon;
          return (
            <RadioCard
              key={kind}
              value={kind}
              icon={<Icon aria-hidden />}
              title={compact && kind === "slack" ? "Slack" : KINDS[kind].label}
              description={compact ? undefined : KINDS[kind].short}
              layout={compact ? "inline" : "stacked"}
              className={compact ? "items-center p-2.5 [&>span:first-child]:size-7" : "p-3"}
              aria-label={KINDS[kind].label}
            />
          );
        })}
      </RadioGroup>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

export interface DestinationFormProps {
  draft: DestinationDraft;
  patch: (next: Partial<DestinationDraft>) => void;
  onKind: (kind: NotificationKind) => void;
  errors: DraftErrors;
  mode: DraftMode;
  original: NotificationDestination | null;
  catalog: NotificationCatalogResponse;
  databases: Pick<Database, "id" | "name" | "displayName" | "kind">[] | undefined;
  databasesLoading?: boolean;
  serverError?: unknown;
  onSubmit?: () => void;
  alertRef?: Ref<HTMLDivElement>;
}

export function DestinationForm({
  draft,
  patch,
  onKind,
  errors,
  mode,
  original,
  catalog,
  databases,
  databasesLoading,
  serverError,
  onSubmit,
  alertRef,
}: DestinationFormProps) {
  const kind = draft.kind;
  return (
    <form
      id={FORM_ID}
      noValidate
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      {serverError ? (
        <Alert ref={alertRef} variant="danger" title="Not saved">
          {errorMessage(serverError)}
        </Alert>
      ) : null}

      {mode === "add" && (
        <Section title="Where to send" description={kind ? undefined : "Pick one. You can add more later, each with its own events."}>
          <KindPicker value={kind} onChange={onKind} error={errors.kind} />
        </Section>
      )}

      {kind && (
        <>
          <Section title={mode === "add" ? "Connection" : "Where it goes"}>
            <ConnectionFields key={`${kind}-${mode}`} draft={draft} patch={patch} errors={errors} mode={mode} original={original} />
            <Field label="Name" required error={errors.name} hint="Only for you, to tell destinations apart in this list.">
              <Input
                value={draft.name}
                maxLength={NAME_MAX}
                onChange={(e) => patch({ name: e.target.value, nameTouched: true })}
                placeholder={KINDS[kind].defaultName}
                autoComplete="off"
              />
            </Field>
          </Section>

          <Section
            title="Events"
            description="On by default: things a person did, and anything that needs a person. Open a group to choose single events."
          >
            <EventPicker catalog={catalog} value={draft.events} onChange={(events) => patch({ events })} error={errors.events} />
          </Section>

          <Section title="Databases">
            <DatabaseScope catalog={catalog} draft={draft} patch={patch} databases={databases} loading={databasesLoading} error={errors.databases} />
          </Section>

          <Section title="Icon">
            <IconField kind={kind} draft={draft} patch={patch} defaultIconUrl={catalog.defaultIconUrl} error={errors.iconUrl} />
          </Section>
        </>
      )}
    </form>
  );
}

export interface DestinationDialogProps {
  open: boolean;
  mode: DraftMode;
  initialKind: NotificationKind | null;
  destination: NotificationDestination | null;
  catalog: NotificationCatalogResponse;
  onClose: () => void;
  onSaved: (destination: NotificationDestination, created: boolean) => void;
}

function focusFirstProblem(): void {
  window.setTimeout(() => {
    const form = document.getElementById(FORM_ID);
    const target = form?.querySelector<HTMLElement>("[data-invalid]");
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    const control = target.querySelector<HTMLElement>("input:not([type=hidden]), button[role=checkbox], button[role=radio], textarea");
    control?.focus({ preventScroll: true });
  }, 30);
}

export function DestinationDialog({ open, mode, initialKind, destination, catalog, onClose, onSaved }: DestinationDialogProps) {
  const { create, update } = useDestinationMutations();
  const databases = useDatabases({ enabled: open });
  const init = () => (mode === "edit" && destination ? draftFrom(destination) : newDraft(initialKind, catalog));
  const [draft, setDraft] = useState<DestinationDraft>(init);
  const [attempted, setAttempted] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(init());
    setAttempted(false);
    create.reset();
    update.reset();
  }, [open, mode, destination?.id, initialKind]);

  const errors = validateDraft(draft, catalog);
  const shown = attempted ? errors : {};
  const saving = create.isPending || update.isPending;
  const serverError = create.error ?? update.error;

  useEffect(() => {
    if (serverError) alertRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [serverError]);

  const patch = (next: Partial<DestinationDraft>) => setDraft((d) => ({ ...d, ...next }));
  const pickKind = (kind: NotificationKind) =>
    setDraft((d) => ({
      ...newDraft(kind, catalog),
      events: d.events,
      scope: d.scope,
      databaseIds: d.databaseIds,
      iconMode: d.iconMode,
      iconUrl: d.iconUrl,
      name: d.nameTouched ? d.name : KINDS[kind].defaultName,
      nameTouched: d.nameTouched,
    }));

  const submit = () => {
    if (saving) return;
    setAttempted(true);
    create.reset();
    update.reset();
    if (Object.keys(errors).length > 0) {
      focusFirstProblem();
      return;
    }
    if (mode === "add") {
      create.mutate(createRequest(draft), { onSuccess: (res) => onSaved(res.destination, true) });
      return;
    }
    if (!destination) return;
    const body = updateRequest(draft, destination);
    if (isEmptyUpdate(body)) {
      onClose();
      return;
    }
    update.mutate({ id: destination.id, body }, { onSuccess: (res) => onSaved(res.destination, false) });
  };

  const kind = draft.kind;
  const title =
    mode === "edit" && destination
      ? `Edit ${destination.name}`
      : kind === "webhook"
        ? "Send to a webhook"
        : kind
          ? `Send to ${KINDS[kind].label}`
          : "Add a destination";

  return (
    <Dialog
      open={open}
      onClose={() => !saving && onClose()}
      size="2xl"
      title={title}
      description={kind ? KINDS[kind].description : "Messages go out only to destinations you add here."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} loading={saving} disabled={!kind}>
            {mode === "add" ? "Add destination" : "Save changes"}
          </Button>
        </>
      }
    >
      <DestinationForm
        draft={draft}
        patch={patch}
        onKind={pickKind}
        errors={shown}
        mode={mode}
        original={destination}
        catalog={catalog}
        databases={databases.data}
        databasesLoading={databases.isPending}
        serverError={serverError}
        onSubmit={submit}
        alertRef={alertRef}
      />
    </Dialog>
  );
}
