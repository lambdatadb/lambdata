import type { ReactNode } from "react";
import type { AccessTokenPresetInfo, Database, IngressKind } from "@lambdata/shared";
import { Checkbox } from "../ui/Checkbox";
import { Field, FieldError } from "../ui/Field";
import { Input } from "../ui/Input";
import { SegmentedControl } from "../ui/RadioGroup";
import { Switch } from "../ui/Switch";
import { cn } from "../ui/cn";
import {
  EXPIRY_OPTIONS,
  INGRESS,
  INGRESS_ORDER,
  NAME_MAX,
  createsDatabases,
  type DraftErrors,
  type ExpiryChoice,
  type TokenDraft,
} from "../../lib/accessTokens";

export interface TokenOptionsProps {
  draft: TokenDraft;
  patch: (next: Partial<TokenDraft>) => void;
  errors: DraftErrors;
  info: AccessTokenPresetInfo | undefined;
  databases: Pick<Database, "id" | "displayName" | "name">[] | undefined;
  disabled?: boolean;
  showName?: boolean;
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="space-y-0.5">
        <h3 className="text-body font-semibold text-text">{title}</h3>
        {description && <p className="text-label text-text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function NameField({
  draft,
  patch,
  error,
  disabled,
}: {
  draft: TokenDraft;
  patch: (next: Partial<TokenDraft>) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <Field label="Name" hint="Name it after the agent or script that will use it. It appears in the activity log." error={error} required>
      <Input
        value={draft.name}
        maxLength={NAME_MAX + 20}
        placeholder="Build bot"
        autoComplete="off"
        disabled={disabled}
        onChange={(e) => patch({ name: e.target.value })}
      />
    </Field>
  );
}

export function TokenOptions({ draft, patch, errors, info, databases, disabled = false, showName = true }: TokenOptionsProps) {
  const builder = draft.preset === "builder";
  const toggleIngress = (kind: IngressKind, on: boolean) =>
    patch({ allowedFrom: on ? INGRESS_ORDER.filter((k) => k === kind || draft.allowedFrom.includes(k)) : draft.allowedFrom.filter((k) => k !== kind) });
  const toggleDatabase = (id: string, on: boolean) =>
    patch({ databaseIds: on ? [...draft.databaseIds.filter((x) => x !== id), id] : draft.databaseIds.filter((x) => x !== id) });

  return (
    <div className="space-y-5" data-token-options>
      {showName && <NameField draft={draft} patch={patch} error={errors.name} disabled={disabled} />}

      <Section title="Expiry" description="After this the token stops working. You can always revoke it sooner.">
        <SegmentedControl
          aria-label="Expiry"
          value={draft.expiry}
          onValueChange={(v) => patch({ expiry: v as ExpiryChoice })}
          options={EXPIRY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          disabled={disabled}
          className="flex-wrap"
        />
        {draft.expiry === "date" && (
          <Field label="Last day it works" error={errors.expiryDate} className="max-w-xs">
            <Input type="date" value={draft.expiryDate} disabled={disabled} onChange={(e) => patch({ expiryDate: e.target.value })} />
          </Field>
        )}
      </Section>

      <Section title="Databases">
        {builder ? (
          <p className="text-label text-text-muted" data-builder-scope>
            A Builder token can only ever see and control the databases it creates itself. Databases made by people or by other tokens stay
            invisible to it.
          </p>
        ) : (
          <div className="space-y-3">
            <Switch
              label="Only the databases I pick"
              description="Leave this off to let the token reach every database on this server."
              checked={draft.limitDatabases}
              onCheckedChange={(on) => patch({ limitDatabases: on })}
              disabled={disabled}
            />
            {draft.limitDatabases && (
              <div className="space-y-2 pl-12">
                {databases === undefined ? (
                  <p className="text-label text-text-muted">Loading databases…</p>
                ) : databases.length === 0 ? (
                  <p className="text-label text-text-muted">There are no databases yet.</p>
                ) : (
                  <ul className="max-h-48 space-y-2 overflow-y-auto">
                    {databases.map((db) => (
                      <li key={db.id}>
                        <Checkbox
                          label={db.displayName}
                          description={db.name}
                          checked={draft.databaseIds.includes(db.id)}
                          onCheckedChange={(on) => toggleDatabase(db.id, on === true)}
                          disabled={disabled}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {errors.databaseIds && <FieldError>{errors.databaseIds}</FieldError>}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Where it may be used" description="Requests that arrive any other way are refused.">
        <ul className="grid gap-3 sm:grid-cols-2">
          {INGRESS_ORDER.map((kind) => (
            <li key={kind}>
              <Checkbox
                label={INGRESS[kind].label}
                description={INGRESS[kind].hint}
                checked={draft.allowedFrom.includes(kind)}
                onCheckedChange={(on) => toggleIngress(kind, on === true)}
                disabled={disabled}
              />
            </li>
          ))}
        </ul>
        {draft.allowedFrom.includes("cloudflare") && (
          <p className="text-label text-warn" data-cloudflare-warning>
            With Cloudflare on, anyone on the internet who has this token can use it. Keep the expiry short.
          </p>
        )}
        {errors.allowedFrom && <FieldError>{errors.allowedFrom}</FieldError>}
      </Section>

      <Section title="Safety">
        <div className="space-y-4">
          {info?.canRevealCredentials ? (
            <Switch
              label="Can see database passwords"
              description="Lets the agent read the user name and password of databases it may reach, so it can connect to them directly."
              checked={draft.revealCredentials}
              onCheckedChange={(on) => patch({ revealCredentials: on })}
              disabled={disabled}
            />
          ) : (
            <p className="text-label text-text-muted" data-no-credentials>
              {info ? `${info.label} tokens can never see database passwords.` : "This token cannot see database passwords."}
            </p>
          )}
          <Switch
            label="Ask me first before deleting or rolling back"
            description="Deleting a database or a checkpoint, rolling back, an import that replaces data, and DROP or TRUNCATE wait until you approve them on the Approvals page."
            checked={draft.askFirst}
            onCheckedChange={(on) => patch({ askFirst: on })}
            disabled={disabled}
          />
        </div>
      </Section>

      <Section title="Limits">
        <div className={cn("grid gap-4", createsDatabases(draft.preset) && "sm:grid-cols-2")}>
          {createsDatabases(draft.preset) && (
            <Field label="Most databases it may create" hint="Leave empty for no limit." error={errors.maxDatabases}>
              <Input
                inputMode="numeric"
                value={draft.maxDatabases}
                placeholder="No limit"
                disabled={disabled}
                onChange={(e) => patch({ maxDatabases: e.target.value })}
              />
            </Field>
          )}
          <Field label="Requests per minute" hint="Requests beyond this are asked to wait." error={errors.requestsPerMinute}>
            <Input inputMode="numeric" value={draft.requestsPerMinute} disabled={disabled} onChange={(e) => patch({ requestsPerMinute: e.target.value })} />
          </Field>
        </div>
      </Section>
    </div>
  );
}
