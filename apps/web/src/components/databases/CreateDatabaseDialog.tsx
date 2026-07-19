import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DatabaseCredentials, DatabaseKind } from "@kilndb/shared";
import { api, ApiError } from "../../lib/api";
import { useConnectionInfo } from "../../lib/useConnectionInfo";
import { useToast } from "../ui/Toast";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { CredentialsReveal } from "./CredentialsReveal";
import { cn } from "../ui/cn";

interface Props {
  open: boolean;
  onClose: () => void;
}

function deriveSchema(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "db";
}

export function CreateDatabaseDialog({ open, onClose }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const conn = useConnectionInfo();
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<DatabaseKind>("standard");
  const [connectionsFrom, setConnectionsFrom] = useState("%");
  const [tailnetOnly, setTailnetOnly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<DatabaseCredentials | null>(null);

  const schema = useMemo(() => (displayName ? deriveSchema(displayName) : ""), [displayName]);
  const effectiveHost = tailnetOnly ? "100.%" : connectionsFrom || "%";

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ credentials: DatabaseCredentials }>("/databases", {
        displayName,
        kind,
        connectionsFrom,
        tailnetOnly,
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["databases"] });
      setCredentials(data.credentials);
      toast.show("Database provisioned", "success");
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "failed to provision"),
  });

  const reset = () => {
    setDisplayName("");
    setKind("standard");
    setConnectionsFrom("%");
    setTailnetOnly(false);
    setErr(null);
    setCredentials(null);
  };
  const closeAll = () => {
    reset();
    onClose();
  };

  if (credentials) {
    return (
      <Dialog open={open} onClose={closeAll} size="2xl" title="Database provisioned" hideClose>
        <CredentialsReveal credentials={credentials} onDone={closeAll} />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={closeAll} size="3xl" hideClose>
      <div className="-mt-1 mb-5 flex items-start justify-between gap-3">
        <h2 className="text-title font-semibold">Create a database</h2>
        <button
          onClick={closeAll}
          aria-label="Close"
          className="text-text-muted hover:text-text rounded-md p-1.5 transition-colors -mt-1"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M6 6l12 12M18 6l-12 12"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <form
        className="grid grid-cols-5 gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          setErr(null);
          mutation.mutate();
        }}
      >
        {/* ===== LEFT: form ===== */}
        <div className="col-span-3 space-y-5">
          <div>
            <label className="block">
              <span className="mb-1.5 block text-label font-medium text-text-muted">
                Display name <span className="text-accent">*</span>
              </span>
              <input
                autoFocus
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Customer Portal"
                className="field-input"
              />
              <div className="mt-1.5 flex items-center gap-2 text-micro text-text-subtle">
                <span>schema →</span>
                <AnimatePresence mode="popLayout" initial={false}>
                  {schema ? (
                    <motion.span
                      key={schema}
                      initial={{ opacity: 0, y: -2 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 2 }}
                      transition={{ duration: 0.15 }}
                      className="font-mono text-accent"
                    >
                      {schema}
                    </motion.span>
                  ) : (
                    <span className="font-mono text-text-subtle">—</span>
                  )}
                </AnimatePresence>
              </div>
            </label>
          </div>

          <div>
            <div className="space-y-1.5">
              <span className="block text-label font-medium text-text-muted">Type</span>
              <div className="grid grid-cols-2 gap-2">
                <TypeCard
                  active={kind === "standard"}
                  onClick={() => setKind("standard")}
                  title="Standard"
                  desc="A fresh, empty schema"
                  icon={
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <ellipse cx="12" cy="5" rx="8" ry="2.5" stroke="currentColor" strokeWidth="1.5" />
                      <path
                        d="M4 5v6c0 1.4 3.58 2.5 8 2.5s8-1.1 8-2.5V5M4 11v6c0 1.4 3.58 2.5 8 2.5s8-1.1 8-2.5v-6"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                  }
                />
                <TypeCard
                  active={kind === "mirror"}
                  onClick={() => setKind("mirror")}
                  title="Mirror"
                  desc="Syncs from an external source"
                  icon={
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M4 7h11M15 7l-3-3M15 7l-3 3M20 17H9M9 17l3 3M9 17l3-3"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  }
                />
              </div>
            </div>
          </div>

          <div>
            <div className="space-y-3 pt-1">
              <span className="block text-label font-medium text-text-muted">Access</span>
              <button
                type="button"
                onClick={() => setTailnetOnly(!tailnetOnly)}
                className={cn(
                  "w-full text-left rounded-lg border p-3 flex items-start gap-3 transition-all",
                  tailnetOnly
                    ? "border-accent/60 bg-accent/[0.06]"
                    : "border-border bg-bg-subtle hover:border-border-strong",
                )}
              >
                <div className="mt-0.5 shrink-0">
                  <span
                    className={cn(
                      "relative inline-flex h-5 w-9 rounded-full transition-colors",
                      tailnetOnly ? "bg-accent" : "bg-border-strong",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
                        tailnetOnly ? "translate-x-[18px]" : "translate-x-0.5",
                      )}
                    />
                  </span>
                </div>
                <div className="flex-1 -mt-0.5">
                  <div className="text-sm font-medium flex items-center gap-2">
                    Tailnet only
                    {tailnetOnly && (
                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">
                        100.%
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-muted mt-0.5">
                    Restrict connections to your Tailscale network.
                  </div>
                </div>
              </button>

              <AnimatePresence initial={false}>
                {!tailnetOnly && (
                  <motion.label
                    key="allowed-hosts"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.18 }}
                    className="block overflow-hidden"
                  >
                    <span className="mb-1.5 block text-label font-medium text-text-muted">Allowed hosts</span>
                    <input
                      value={connectionsFrom}
                      onChange={(e) => setConnectionsFrom(e.target.value)}
                      placeholder="%"
                      className="field-input font-mono"
                    />
                    <span className="block mt-1 text-micro text-text-subtle">
                      MySQL pattern. <code className="font-mono">%</code> = any host ·{" "}
                      <code className="font-mono">192.168.%</code> = a subnet ·{" "}
                      <code className="font-mono">10.0.0.5</code> = exact IP.
                    </span>
                  </motion.label>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* ===== RIGHT: build manifest ===== */}
        <motion.aside
          className="col-span-2 relative overflow-hidden rounded-lg border border-border bg-bg p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
        >
          <div className="mb-3 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            <span className="size-1.5 rounded-full bg-accent" />
            build manifest
          </div>

          <div className="font-mono text-xs leading-[1.7] text-text">
            <ManifestRow
              label="kind"
              value={
                <span className={kind === "mirror" ? "text-accent" : "text-text"}>
                  {kind}
                </span>
              }
            />
            <ManifestRow
              label="schema"
              value={schema ? <code className="text-accent">{schema}</code> : <Dim />}
            />
            <ManifestRow
              label="user"
              value={
                schema ? (
                  <code className="text-text-muted">
                    kdb_{schema.slice(0, 12)}_<span className="text-text-subtle">····</span>
                  </code>
                ) : (
                  <Dim />
                )
              }
            />
            <ManifestRow
              label="pass"
              value={
                <span className="text-text-muted">
                  <span className="tracking-[0.25em]">▓▓▓▓▓▓▓▓▓▓▓▓</span>{" "}
                  <span className="text-text-subtle text-[10px]">24 ch · auto</span>
                </span>
              }
            />
            <ManifestRow
              label="host"
              value={
                <span className="text-text-muted">
                  {conn.host}
                  <span className="text-text-subtle">:{conn.port}</span>
                </span>
              }
            />
            <ManifestRow
              label="from"
              last
              value={
                <code className={tailnetOnly ? "text-accent" : "text-text-muted"}>
                  {effectiveHost}
                </code>
              }
            />
          </div>

          <div className="mt-4 pt-3 border-t border-dashed border-border">
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-text-subtle">
              // grant
            </div>
            <pre className="font-mono text-[10.5px] leading-relaxed text-text-muted whitespace-pre-wrap break-words">
              GRANT ALL ON{" "}
              <span className="text-accent">{schema || "—"}</span>
              .*
              {"\n"}TO kdb_{schema ? schema.slice(0, 12) : "—"}_····@
              <span className={tailnetOnly ? "text-accent" : "text-text"}>{effectiveHost}</span>
            </pre>
          </div>
        </motion.aside>

        {/* ===== ERROR + FOOTER ===== */}
        <div className="col-span-5 -mt-1">
          <AnimatePresence>
            {err && (
              <motion.p
                key="err"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="text-sm text-danger mb-3"
              >
                {err}
              </motion.p>
            )}
          </AnimatePresence>
          <div className="flex items-center justify-end pt-3 border-t border-border">
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={closeAll}>
                Cancel
              </Button>
              <Button type="submit" loading={mutation.isPending} disabled={!displayName.trim()}>
                Provision database
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
            </div>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

// ---- helpers ----

function TypeCard({
  active,
  onClick,
  title,
  desc,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative text-left rounded-lg border p-3 transition-all overflow-hidden group",
        active
          ? "border-accent/70 bg-accent/[0.06]"
          : "border-border bg-bg-subtle hover:border-border-strong",
      )}
    >
      {active && (
        <motion.span
          layoutId="type-active"
          className="absolute inset-0 rounded-lg border border-accent/40 pointer-events-none"
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
        />
      )}
      <div className="flex items-center justify-between mb-1.5">
        <span className={cn(active ? "text-accent" : "text-text-muted")}>{icon}</span>
        <span
          className={cn(
            "size-3.5 rounded-full border transition-colors",
            active ? "bg-accent border-accent" : "border-border-strong",
          )}
        />
      </div>
      <div className="text-sm font-medium">{title}</div>
      <div className="text-micro text-text-muted mt-0.5">{desc}</div>
    </button>
  );
}

function ManifestRow({
  label,
  value,
  last,
}: {
  label: string;
  value: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-text-subtle select-none">{last ? "└─" : "├─"}</span>
      <span className="text-text-subtle uppercase text-[10px] tracking-wider w-10 shrink-0">
        {label}
      </span>
      <span className="flex-1 min-w-0 truncate">{value}</span>
    </div>
  );
}

function Dim() {
  return <span className="text-text-subtle">—</span>;
}
