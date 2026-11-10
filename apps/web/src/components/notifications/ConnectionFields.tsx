import { useState, type ReactNode } from "react";
import { ChevronDown, CircleHelp, Dices, Plus, Undo2, X } from "lucide-react";
import type { NotificationDestination, NotificationKind } from "@lambdata/shared";
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  Field,
  FieldGroup,
  Input,
  SegmentedControl,
  SelectMenu,
} from "../ui";
import { Code, Steps } from "../network/parts";
import {
  MAX_HEADERS,
  generateSecret,
  generateTopic,
  headerRow,
  targetHost,
  type DestinationDraft,
  type DraftErrors,
  type DraftMode,
  type SecretMode,
} from "./model";
import { DocsLink } from "./parts";

type Patch = (next: Partial<DestinationDraft>) => void;

const PRIORITIES = [
  { value: "event", label: "Follow the event", description: "Problems are high, routine news low" },
  { value: "1", label: "1 · min", description: "No sound or vibration" },
  { value: "2", label: "2 · low", description: "No sound, shown in the list" },
  { value: "3", label: "3 · default", description: "The phone's normal alert" },
  { value: "4", label: "4 · high", description: "Long vibration, pop-up" },
  { value: "5", label: "5 · max", description: "Long bursts, stays on screen" },
];

export function priorityLabel(priority: number | null): string {
  if (!priority) return "Follows the event";
  return PRIORITIES.find((p) => p.value === String(priority))?.label ?? String(priority);
}

function DiscordGuide() {
  return (
    <Steps
      items={[
        <>
          In Discord, open your server, hover over the channel that should get the messages and click the gear: <strong>Edit Channel</strong>.
        </>,
        <>
          Open <strong>Integrations</strong> → <strong>Webhooks</strong> → <strong>New Webhook</strong>. No Integrations tab? You need the{" "}
          <strong>Manage Webhooks</strong> permission in that server.
        </>,
        <>
          Click <strong>Copy Webhook URL</strong> and paste it below. Its name and picture do not matter: LambData sets its own on every message.
        </>,
      ]}
    />
  );
}

function SlackGuide() {
  const [app, setApp] = useState("slack");
  return (
    <div className="space-y-3">
      <SegmentedControl
        size="xs"
        value={app}
        onValueChange={setApp}
        aria-label="Chat app"
        options={[
          { value: "slack", label: "Slack" },
          { value: "mattermost", label: "Mattermost" },
        ]}
      />
      {app === "slack" ? (
        <Steps
          items={[
            <>
              Go to <Code>api.slack.com/apps</Code> and choose <strong>Create New App</strong> → <strong>From scratch</strong>. Name it LambData and
              pick your workspace.
            </>,
            <>
              Under <strong>Features</strong>, open <strong>Incoming Webhooks</strong> and switch it on.
            </>,
            <>
              Click <strong>Add New Webhook to Workspace</strong>, pick the channel and allow it.
            </>,
            <>
              Copy the <strong>Webhook URL</strong>, which starts with <Code>https://hooks.slack.com/services/</Code>, and paste it below.
            </>,
          ]}
        />
      ) : (
        <Steps
          items={[
            <>
              In Mattermost open the product menu → <strong>Integrations</strong> → <strong>Incoming Webhooks</strong> →{" "}
              <strong>Add Incoming Webhook</strong>.
            </>,
            <>Pick the channel, save, and copy the URL it shows. Paste it below.</>,
            <>
              To show LambData's name and icon, a Mattermost admin must allow integrations to override usernames and profile picture icons
              (System Console → Integrations).
            </>,
          ]}
        />
      )}
    </div>
  );
}

function NtfyGuide() {
  return (
    <Steps
      items={[
        <>
          Install the <strong>ntfy</strong> app on your phone (Android or iOS), or open <Code>ntfy.sh</Code> in a browser. No account is needed.
        </>,
        <>
          Pick a topic name below, or press <strong>Suggest one</strong>. The topic is the address: on the public server anyone who knows it can
          read the messages, so make it hard to guess.
        </>,
        <>
          In the app, tap <strong>+</strong> and subscribe to the same topic. If you run your own ntfy server, enter its address in both places.
        </>,
      ]}
    />
  );
}

function WebhookGuide() {
  return (
    <Steps
      items={[
        <>
          Create something that accepts a <strong>POST</strong> with a JSON body. In Home Assistant, an automation with a{" "}
          <strong>Webhook</strong> trigger gives you an address like <Code>http://homeassistant.local:8123/api/webhook/your-id</Code>; n8n and
          Node-RED have a Webhook node.
        </>,
        <>
          Paste its address below. Any 2xx answer counts as delivered; on errors LambData tries again with growing pauses for about an hour.
        </>,
        <>
          Optionally add a signing secret, so your endpoint can check that a message really came from LambData. The <DocsLink /> shows the body
          and how to check the signature.
        </>,
      ]}
    />
  );
}

const GUIDES: Record<NotificationKind, () => ReactNode> = {
  discord: DiscordGuide,
  slack: SlackGuide,
  ntfy: NtfyGuide,
  webhook: WebhookGuide,
};

export function SetupGuide({ kind, defaultOpen }: { kind: NotificationKind; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const Guide = GUIDES[kind];
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-bg-inset/60">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start rounded-lg px-3" aria-expanded={open}>
          <CircleHelp aria-hidden />
          Where do I get this?
          <ChevronDown aria-hidden className={open ? "ml-auto rotate-180 transition-transform" : "ml-auto transition-transform"} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 pb-3.5 pt-1">
          <Guide />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const savedRow = "flex min-h-9 items-center justify-between gap-2 rounded-md border border-border bg-bg-inset py-1 pl-3 pr-1.5";

function SavedBadge() {
  return (
    <Badge variant="success" size="sm">
      saved
    </Badge>
  );
}

function SavedValue({ value, onReplace, label }: { value: string; onReplace: () => void; label: string }) {
  return (
    <div className={savedRow} data-saved={label}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-code text-text" title={value}>
          {value}
        </span>
        <SavedBadge />
      </span>
      <Button variant="ghost" size="xs" onClick={onReplace} aria-label={`Replace the ${label}`}>
        Replace
      </Button>
    </div>
  );
}

function SavedSecret({ mode, onMode, label, removedText }: { mode: SecretMode; onMode: (mode: SecretMode) => void; label: string; removedText: string }) {
  if (mode === "remove") {
    return (
      <div className={savedRow} data-saved={label}>
        <span className="min-w-0 text-label text-warn">{removedText}</span>
        <Button variant="ghost" size="xs" onClick={() => onMode("keep")}>
          <Undo2 aria-hidden /> Keep it
        </Button>
      </div>
    );
  }
  return (
    <div className={savedRow} data-saved={label}>
      <span className="flex items-center gap-2">
        <span aria-hidden className="font-mono text-code tracking-[0.2em] text-text-subtle">
          ••••••••
        </span>
        <SavedBadge />
      </span>
      <span className="flex items-center">
        <Button variant="ghost" size="xs" onClick={() => onMode("new")} aria-label={`Replace the ${label}`}>
          Replace
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onMode("remove")} aria-label={`Remove the ${label}`}>
          Remove
        </Button>
      </span>
    </div>
  );
}

function KeepSaved({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="link" size="xs" className="text-label text-text-muted" onClick={onClick}>
      Keep the saved one
    </Button>
  );
}

function HeaderRows({ draft, patch }: { draft: DestinationDraft; patch: Patch }) {
  const rows = draft.headers;
  const set = (key: string, change: Partial<{ name: string; value: string }>) =>
    patch({
      headers: rows.map((r) => (r.key === key ? { ...r, ...change, saved: change.name !== undefined && change.name !== r.name ? false : r.saved } : r)),
    });
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] gap-2" data-header-row={row.saved ? "saved" : "new"}>
          <Input
            mono
            inputSize="sm"
            aria-label={`Header ${i + 1} name`}
            placeholder="X-Api-Key"
            value={row.name}
            onChange={(e) => set(row.key, { name: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            mono
            inputSize="sm"
            aria-label={`Header ${i + 1} value`}
            placeholder={row.saved ? "keep saved" : "value"}
            value={row.value}
            onChange={(e) => set(row.key, { value: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
          <Button variant="ghost" size="icon-sm" aria-label={`Remove header ${row.name || i + 1}`} onClick={() => patch({ headers: rows.filter((r) => r.key !== row.key) })}>
            <X />
          </Button>
        </div>
      ))}
      {rows.length < MAX_HEADERS && (
        <Button variant="secondary" size="xs" onClick={() => patch({ headers: [...rows, headerRow()] })}>
          <Plus aria-hidden /> Add header
        </Button>
      )}
    </div>
  );
}

function urlHint(kind: NotificationKind): string {
  if (kind === "discord") return "Anyone with this URL can post in the channel, so LambData stores it encrypted and never shows it again.";
  if (kind === "slack") return "Works with Slack, Mattermost and other Slack-compatible chats. Stored encrypted and never shown again.";
  return "LambData POSTs JSON here. Inside a container, localhost is the container itself: use the machine's network address instead.";
}

const URL_PLACEHOLDER: Record<NotificationKind, string> = {
  discord: "https://discord.com/api/webhooks/…",
  slack: "https://hooks.slack.com/services/…",
  webhook: "https://example.com/hooks/lambdata",
  ntfy: "",
};

const URL_LABEL: Record<NotificationKind, string> = {
  discord: "webhook URL",
  slack: "webhook URL",
  webhook: "address",
  ntfy: "server and topic",
};

interface Props {
  draft: DestinationDraft;
  patch: Patch;
  errors: DraftErrors;
  mode: DraftMode;
  original: NotificationDestination | null;
}

export function ConnectionFields({ draft, patch, errors, mode, original }: Props) {
  const kind = draft.kind;
  const [generated, setGenerated] = useState(false);
  if (!kind) return null;
  const saved = mode === "edit" ? original : null;
  const keepAddress = !!saved && draft.addressMode === "keep";
  const replaceAddress = () => patch({ addressMode: "replace" });
  const keepAddressAgain = () => patch({ addressMode: "keep", url: "", topic: "", server: "" });
  const storedSecret = !!saved && saved.kind === "webhook" && saved.hasSecret;
  const storedToken = !!saved && saved.kind === "ntfy" && saved.hasSecret;

  return (
    <div className="space-y-4">
      {!keepAddress && <SetupGuide kind={kind} defaultOpen={!saved} />}

      {kind !== "ntfy" && (
        <Field
          label={kind === "webhook" ? "Address" : "Webhook URL"}
          required={!keepAddress}
          error={errors.url}
          hint={keepAddress ? "Stored encrypted and never shown again. Replace it to change it." : urlHint(kind)}
          labelAction={saved && !keepAddress ? <KeepSaved onClick={keepAddressAgain} /> : undefined}
        >
          {keepAddress && saved ? (
            <SavedValue value={saved.target} onReplace={replaceAddress} label={URL_LABEL[kind]} />
          ) : (
            <Input
              mono
              value={draft.url}
              onChange={(e) => patch({ url: e.target.value })}
              placeholder={URL_PLACEHOLDER[kind]}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
          )}
        </Field>
      )}

      {kind === "webhook" && (
        <>
          <Field
            label="Signing secret"
            error={errors.secret}
            labelAction={storedSecret && draft.secretMode === "new" ? <KeepSaved onClick={() => patch({ secretMode: "keep", secret: "" })} /> : undefined}
            hint={
              <>
                Optional. Lets your endpoint check that a message came from LambData: <Code>X-LambData-Signature</Code> carries an HMAC-SHA256
                of the timestamp, a dot and the body.
              </>
            }
          >
            {storedSecret && draft.secretMode !== "new" ? (
              <SavedSecret
                mode={draft.secretMode}
                onMode={(m) => patch({ secretMode: m, secret: "" })}
                label="signing secret"
                removedText="Removed when you save: messages will no longer be signed."
              />
            ) : (
              <div className="flex gap-2">
                <Input
                  mono
                  value={draft.secret}
                  onChange={(e) => {
                    setGenerated(false);
                    patch({ secret: e.target.value });
                  }}
                  placeholder={storedSecret ? "New secret" : "No secret"}
                  autoComplete="off"
                  spellCheck={false}
                />
                {generated && draft.secret ? (
                  <CopyButton value={draft.secret} label="signing secret" variant="secondary" size="icon" />
                ) : (
                  <Button
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => {
                      setGenerated(true);
                      patch({ secret: generateSecret() });
                    }}
                  >
                    <Dices aria-hidden /> Generate
                  </Button>
                )}
              </div>
            )}
          </Field>
          {generated && draft.secretMode === "new" && draft.secret && (
            <p className="-mt-2 text-micro text-warn">Copy it now and give it to your endpoint: it is not shown again after you save.</p>
          )}

          <Field
            label="Custom headers"
            error={errors.headers}
            hint={
              saved && saved.headerNames.length > 0
                ? "Saved values are never shown. Leave a value empty to keep it; remove a row to drop that header."
                : `Optional, up to ${MAX_HEADERS}, for an endpoint that wants a key in a header. Values are stored encrypted.`
            }
          >
            <HeaderRows draft={draft} patch={patch} />
          </Field>
        </>
      )}

      {kind === "ntfy" && (
        <>
          {keepAddress && saved ? (
            <Field label="Server and topic" hint="The topic is never shown again. Replace it to move to another topic or server.">
              <SavedValue value={saved.target} onReplace={replaceAddress} label={URL_LABEL.ntfy} />
            </Field>
          ) : (
            <>
              <Field
                label="Topic"
                required
                error={errors.topic}
                hint="Letters, numbers, - and _. Hard to guess, because the topic is the address."
                labelAction={saved ? <KeepSaved onClick={keepAddressAgain} /> : undefined}
              >
                <div className="flex gap-2">
                  <Input
                    mono
                    value={draft.topic}
                    onChange={(e) => patch({ topic: e.target.value })}
                    placeholder="lambdata-…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button variant="secondary" className="shrink-0" onClick={() => patch({ topic: generateTopic() })}>
                    <Dices aria-hidden /> Suggest one
                  </Button>
                </div>
              </Field>
              <Field
                label="Server"
                error={errors.server}
                hint={saved ? `Leave empty to keep ${targetHost(saved.target)}.` : "Leave empty for ntfy.sh, or enter your own server."}
              >
                <Input
                  mono
                  value={draft.server}
                  onChange={(e) => patch({ server: e.target.value })}
                  placeholder={saved ? targetHost(saved.target) : "https://ntfy.sh"}
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                />
              </Field>
            </>
          )}
          <FieldGroup>
            <Field label="Priority" hint="How loudly your phone announces it.">
              <SelectMenu options={PRIORITIES} value={draft.priority} onValueChange={(v) => patch({ priority: v })} />
            </Field>
            <Field
              label="Access token"
              error={errors.token}
              labelAction={storedToken && draft.tokenMode === "new" ? <KeepSaved onClick={() => patch({ tokenMode: "keep", token: "" })} /> : undefined}
              hint={
                <>
                  Only if your server requires sign-in. ntfy lists tokens under Account; they start with <Code>tk_</Code>.
                </>
              }
            >
              {storedToken && draft.tokenMode !== "new" ? (
                <SavedSecret
                  mode={draft.tokenMode}
                  onMode={(m) => patch({ tokenMode: m, token: "" })}
                  label="access token"
                  removedText="Removed when you save."
                />
              ) : (
                <Input
                  type="password"
                  mono
                  value={draft.token}
                  onChange={(e) => patch({ token: e.target.value })}
                  placeholder="tk_…"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
          </FieldGroup>
        </>
      )}
    </div>
  );
}
