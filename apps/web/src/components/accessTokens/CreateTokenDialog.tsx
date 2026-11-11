import { useReducer, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck, Wrench, Eye, TriangleAlert } from "lucide-react";
import type { AccessToken, AccessTokenPreset, AccessTokenPresetInfo, Database } from "@lambdata/shared";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { CopyButton, CopyableField } from "../ui/CopyableField";
import { Dialog } from "../ui/Dialog";
import { RadioCard, RadioGroup } from "../ui/RadioGroup";
import { errorMessage } from "../../lib/api";
import {
  applyPreset,
  createAccessToken,
  createRequest,
  hasErrors,
  newDraft,
  orderedPresets,
  presetInfo,
  validateDraft,
  type DraftErrors,
  type TokenDraft,
} from "../../lib/accessTokens";
import { ConnectAgent } from "./ConnectAgent";
import { PresetLists } from "./parts";
import { NameField, TokenOptions } from "./TokenOptions";

const PRESET_ICONS: Record<AccessTokenPreset, typeof Eye> = { read_only: Eye, builder: Wrench, admin: ShieldCheck };

export function PresetPicker({
  presets,
  value,
  onChange,
  disabled,
}: {
  presets: AccessTokenPresetInfo[];
  value: AccessTokenPreset;
  onChange: (preset: AccessTokenPreset) => void;
  disabled?: boolean;
}) {
  const Icon = (p: AccessTokenPreset) => {
    const C = PRESET_ICONS[p] ?? KeyRound;
    return <C aria-hidden />;
  };
  return (
    <RadioGroup
      aria-label="What the token may do"
      value={value}
      onValueChange={(v) => onChange(v as AccessTokenPreset)}
      disabled={disabled}
      className="grid gap-3 sm:grid-cols-3"
    >
      {orderedPresets(presets).map((info) => (
        <RadioCard
          key={info.preset}
          value={info.preset}
          layout="stacked"
          icon={Icon(info.preset)}
          title={info.label}
          data-preset={info.preset}
          description={info.summary}
        />
      ))}
    </RadioGroup>
  );
}

export interface CreateTokenFormProps {
  draft: TokenDraft;
  patch: (next: Partial<TokenDraft>) => void;
  onPreset: (preset: AccessTokenPreset) => void;
  errors: DraftErrors;
  presets: AccessTokenPresetInfo[];
  databases: Pick<Database, "id" | "displayName" | "name">[] | undefined;
  serverError?: unknown;
  busy?: boolean;
}

export function CreateTokenForm({ draft, patch, onPreset, errors, presets, databases, serverError, busy }: CreateTokenFormProps) {
  const info = presetInfo(presets, draft.preset);
  return (
    <div className="space-y-6">
      {serverError !== undefined && serverError !== null && (
        <Alert variant="danger" title="The token was not created">
          {errorMessage(serverError)}
        </Alert>
      )}
      <NameField draft={draft} patch={patch} error={errors.name} disabled={busy} />
      <section className="space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-body font-semibold text-text">What it may do</h3>
          <p className="text-label text-text-muted">This is enforced by the server on every request and cannot be changed later.</p>
        </div>
        <PresetPicker presets={presets} value={draft.preset} onChange={onPreset} disabled={busy} />
        {info && (
          <div className="space-y-2 rounded-lg border border-border bg-bg-inset p-4" data-selected-preset={info.preset}>
            <p className="text-body font-medium text-text">What a {info.label} token can and cannot do</p>
            <PresetLists info={info} compact />
          </div>
        )}
      </section>
      <TokenOptions draft={draft} patch={patch} errors={errors} info={info} databases={databases} disabled={busy} showName={false} />
    </div>
  );
}

export function CreatedTokenPanel({ token, secret, origin }: { token: AccessToken; secret: string; origin: string }) {
  return (
    <div className="space-y-6" data-created-token={token.id}>
      <div className="space-y-3">
        <CopyableField value={secret} label="Secret" copyLabel="token secret" />
        <div className="flex flex-wrap items-center gap-3">
          <CopyButton value={secret} label="token secret" text="Copy token" variant="secondary" size="sm" />
        </div>
        <Alert variant="warning" title="This is the only time the secret is shown" icon={<TriangleAlert aria-hidden />}>
          Copy it now and keep it somewhere safe, such as a password manager. LambData stores only a fingerprint of it. If you lose it, revoke this
          token and create a new one.
        </Alert>
      </div>
      <ConnectAgent origin={origin} secret={secret} />
    </div>
  );
}

export type CreateFlowState = { phase: "form" } | { phase: "created"; token: AccessToken; secret: string };

export type CreateFlowAction = { type: "created"; token: AccessToken; secret: string } | { type: "reset" };

export function createFlow(_state: CreateFlowState, action: CreateFlowAction): CreateFlowState {
  if (action.type === "created") return { phase: "created", token: action.token, secret: action.secret };
  return { phase: "form" };
}

export interface CreateTokenDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (token: AccessToken) => void;
  presets: AccessTokenPresetInfo[];
  databases: Pick<Database, "id" | "displayName" | "name">[] | undefined;
  origin: string;
}

export function CreateTokenDialog({ open, onClose, onCreated, presets, databases, origin }: CreateTokenDialogProps) {
  const qc = useQueryClient();
  const [flow, dispatch] = useReducer(createFlow, { phase: "form" });
  const [draft, setDraft] = useState<TokenDraft>(() => newDraft(presets));
  const [showErrors, setShowErrors] = useState(false);
  const [serverError, setServerError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const errors: DraftErrors = showErrors ? validateDraft(draft) : {};

  const patch = (next: Partial<TokenDraft>) => setDraft((d) => ({ ...d, ...next }));
  const onPreset = (preset: AccessTokenPreset) => {
    const info = presetInfo(presets, preset);
    if (info) setDraft((d) => applyPreset(d, info));
  };

  const close = () => {
    if (busy) return;
    dispatch({ type: "reset" });
    setDraft(newDraft(presets));
    setShowErrors(false);
    setServerError(null);
    onClose();
  };

  const submit = async () => {
    setShowErrors(true);
    if (hasErrors(validateDraft(draft))) return;
    setBusy(true);
    setServerError(null);
    try {
      const res = await createAccessToken(qc, createRequest(draft, presetInfo(presets, draft.preset)));
      dispatch({ type: "created", token: res.token, secret: res.secret });
      onCreated?.(res.token);
    } catch (error) {
      setServerError(error);
    } finally {
      setBusy(false);
    }
  };

  if (flow.phase === "created") {
    return (
      <Dialog
        open={open}
        onClose={close}
        dismissible={false}
        hideClose
        size="2xl"
        title={`${flow.token.name} is ready`}
        description="Give the secret below to the agent or script. It will not be shown again."
        footer={<Button onClick={close}>I have saved the secret</Button>}
      >
        <CreatedTokenPanel token={flow.token} secret={flow.secret} origin={origin} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!busy}
      size="2xl"
      title="Create an access token"
      description="An access token lets an AI agent or a script manage databases here without signing in."
      footer={
        <>
          {hasErrors(errors) && (
            <p role="status" className="mr-auto self-center text-label text-danger">
              Some fields need attention.
            </p>
          )}
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            Create token
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <CreateTokenForm
          draft={draft}
          patch={patch}
          onPreset={onPreset}
          errors={errors}
          presets={presets}
          databases={databases}
          serverError={serverError}
          busy={busy}
        />
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
