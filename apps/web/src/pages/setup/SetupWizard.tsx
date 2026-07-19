import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import type { ExperienceLevel, PathValidationResponse, SetupState, TailscaleStatus } from "@kilndb/shared";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Input";
import { Icon } from "../../components/ui/Icon";
import { DataDirPicker } from "../../components/storage/DataDirPicker";

type Step = "welcome" | "storage" | "admin" | "experience" | "tailscale" | "done";

const ORDER: Step[] = ["welcome", "storage", "admin", "experience", "tailscale", "done"];

function defaultStoragePresets(home: string) {
  if (/^[A-Za-z]:[\\/]/.test(home)) {
    return [
      { label: "App data", path: `${home}\\AppData\\Local\\KilnDB` },
      { label: "Home folder", path: `${home}\\KilnDBData` },
    ];
  }
  if (home.startsWith("/Users/")) {
    return [
      { label: "Application Support", path: `${home}/Library/Application Support/KilnDB` },
      { label: "Home folder", path: `${home}/KilnDBData` },
      { label: "/usr/local/var", path: "/usr/local/var/kilndb" },
    ];
  }
  return [
    { label: "XDG data", path: `${home}/.local/share/kilndb` },
    { label: "Home folder", path: `${home}/KilnDBData` },
    { label: "/var/lib", path: "/var/lib/kilndb" },
  ];
}

export function SetupWizard() {
  const [step, setStep] = useState<Step>("welcome");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [experienceLevel, setExperienceLevel] = useState<ExperienceLevel>("advanced");
  const [tailscaleAuthKey, setTailscaleAuthKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tsStatus, setTsStatus] = useState<TailscaleStatus | null>(null);
  const [setupState, setSetupState] = useState<SetupState | null>(null);
  const [storagePath, setStoragePath] = useState("");
  const [storageValidation, setStorageValidation] = useState<PathValidationResponse | null>(null);
  const [storageConfigured, setStorageConfigured] = useState(false);
  const nav = useNavigate();
  const { refetch } = useAuth();
  const qc = useQueryClient();

  useEffect(() => {
    api.get<SetupState>("/setup/state")
      .then((s) => {
        setSetupState(s);
        if (s.dataDirConfigured) {
          setStorageConfigured(true);
          setStoragePath(s.dataDir);
        } else {
          setStoragePath(defaultStoragePresets(s.homeDir)[0]!.path);
        }
      })
      .catch(() => {
        // best-effort
      });
  }, []);

  const goto = async (s: Step) => {
    setErr(null);
    setStep(s);
    if (s === "tailscale" && tsStatus === null) {
      // Best-effort probe; setup endpoints don't require auth, but tailscale does. Skip if unauthenticated.
      try {
        const r = await api.get<TailscaleStatus>("/tailscale/status");
        setTsStatus(r);
      } catch {
        setTsStatus({ installed: false, running: false, hostname: null, tailnetIp: null });
      }
    }
  };

  const completeAdmin = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/setup/complete", {
        email,
        password,
        displayName: displayName || null,
        experienceLevel,
      });
      await refetch();
      await qc.invalidateQueries({ queryKey: ["setup", "state"] });
      await goto("tailscale");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "setup failed");
    } finally {
      setBusy(false);
    }
  };

  const tsUp = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post("/tailscale/up", tailscaleAuthKey ? { authKey: tailscaleAuthKey } : {});
      const r = await api.get<TailscaleStatus>("/tailscale/status");
      setTsStatus(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "tailscale up failed");
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    qc.invalidateQueries();
    nav("/");
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center p-6 bg-bg">
      <div className="relative w-full max-w-xl card-surface p-8">
        <div className="mb-5 flex items-center gap-2">
          <div className="size-7 rounded-md bg-bg-subtle border border-border flex items-center justify-center">
            <img src="/kilndb-mark.png" alt="" className="size-5" />
          </div>
          <span className="text-label font-medium text-text-muted">
            <span className="brand-wordmark">KilnDB</span> · first run
          </span>
        </div>
        <Progress step={step} />
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.18 }}
            className="mt-6 space-y-5"
          >
            {step === "welcome" && (
              <>
                <h1 className="text-2xl font-semibold tracking-tight">Welcome to KilnDB</h1>
                <p className="text-sm text-text-muted">
                  We'll set up a self-hosted MySQL-compatible database platform on this machine. Takes about a minute.
                </p>
                <ul className="space-y-2 text-sm">
                  <li className="flex items-center gap-2"><Icon name="dns" size={14} className="text-accent" /> Bundles and manages a local MariaDB server</li>
                  <li className="flex items-center gap-2"><Icon name="vpn_key" size={14} className="text-accent" /> Auto-generates usernames, passwords, and connection strings</li>
                  <li className="flex items-center gap-2"><Icon name="sync_alt" size={14} className="text-accent" /> Mirror external databases, optional Tailscale exposure</li>
                </ul>
                <div className="flex justify-end pt-2">
                  <Button onClick={() => goto("storage")}>
                    Get started
                    <Icon name="arrow_forward" size={14} />
                  </Button>
                </div>
              </>
            )}

            {step === "storage" && (
              <>
                <h1 className="text-xl font-semibold tracking-tight">Where should KilnDB store data?</h1>
                <p className="text-sm text-text-muted">
                  This holds the MariaDB data directory, snapshots, the SQLite metadata file, and your encryption key.
                  Pick a spot that's persistent and easy to back up.
                </p>
                {storageConfigured ? (
                  <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">
                    <div className="flex items-center gap-2 font-medium">
                      <Icon name="check_circle" size={14} className="text-success" />
                      Storage already configured.
                    </div>
                    <div className="mt-1 font-mono text-xs break-all text-text-muted">
                      {setupState?.dataDir}
                    </div>
                    <p className="mt-2 text-xs text-text-muted">
                      You can change this any time from Settings → Storage.
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-text-subtle">
                      Currently using a temporary path:{" "}
                      <span className="font-mono">{setupState?.dataDir}</span>
                    </p>
                    <DataDirPicker
                      value={storagePath}
                      onChange={setStoragePath}
                      onValidation={setStorageValidation}
                      disabled={busy}
                      pickerPrompt="Select KilnDB data directory"
                      presets={setupState ? defaultStoragePresets(setupState.homeDir) : []}
                    />
                  </>
                )}
                {err && <p className="text-sm text-danger">{err}</p>}
                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => goto("welcome")} disabled={busy}>Back</Button>
                  {storageConfigured ? (
                    <Button onClick={() => goto("admin")}>
                      Continue
                      <Icon name="arrow_forward" size={14} />
                    </Button>
                  ) : (
                    <Button
                      loading={busy}
                      disabled={!storageValidation?.ok}
                      onClick={async () => {
                        setErr(null);
                        setBusy(true);
                        try {
                          await api.post("/setup/data-dir", { path: storagePath });
                          setStorageConfigured(true);
                          await goto("admin");
                        } catch (e) {
                          setErr(e instanceof ApiError ? e.message : "failed to set data directory");
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Use this location
                      <Icon name="arrow_forward" size={14} />
                    </Button>
                  )}
                </div>
              </>
            )}

            {step === "admin" && (
              <>
                <h1 className="text-xl font-semibold tracking-tight">Create your admin account</h1>
                <Field label="Email" required>
                  <Input
                    type="text"
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </Field>
                <Field label="Display name">
                  <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" />
                </Field>
                <Field label="Password" required hint="At least 8 characters">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                </Field>
                {err && <p className="text-sm text-danger">{err}</p>}
                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => goto("storage")}>Back</Button>
                  <Button onClick={() => goto("experience")} disabled={!email || password.length < 8}>
                    Continue
                  </Button>
                </div>
              </>
            )}

            {step === "experience" && (
              <>
                <h1 className="text-xl font-semibold tracking-tight">How comfortable are you with SQL?</h1>
                <p className="text-sm text-text-muted">
                  We'll adjust terminology and which options are surfaced by default. You can change this any time.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                  <ExperienceCard
                    selected={experienceLevel === "novice"}
                    onClick={() => setExperienceLevel("novice")}
                    title="I'm new"
                    desc="Plain-English labels and a guided UI."
                  />
                  <ExperienceCard
                    selected={experienceLevel === "advanced"}
                    onClick={() => setExperienceLevel("advanced")}
                    title="I know my way around"
                    desc="Standard MySQL terms and all options visible."
                  />
                </div>
                {err && <p className="text-sm text-danger">{err}</p>}
                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => goto("admin")}>Back</Button>
                  <Button loading={busy} onClick={completeAdmin}>Create account</Button>
                </div>
              </>
            )}

            {step === "tailscale" && (
              <>
                <h1 className="text-xl font-semibold tracking-tight">Tailscale (optional)</h1>
                {tsStatus?.installed === false && (
                  <p className="text-sm text-text-muted">
                    Tailscale isn't installed on this host. You can skip this and configure it later from Settings.
                  </p>
                )}
                {tsStatus?.installed && !tsStatus.running && (
                  <>
                    <p className="text-sm text-text-muted">
                      Bring your tailnet up to optionally expose databases over Tailscale only.
                    </p>
                    <Field label="Auth key (optional)" hint="Leave blank to use the interactive browser flow">
                      <Input
                        value={tailscaleAuthKey}
                        onChange={(e) => setTailscaleAuthKey(e.target.value)}
                        placeholder="tskey-auth-..."
                      />
                    </Field>
                  </>
                )}
                {tsStatus?.running && (
                  <p className="text-sm text-success">
                    Tailscale is up. Hostname: <span className="font-mono">{tsStatus.hostname ?? "?"}</span>
                    {tsStatus.tailnetIp && <> · IP <span className="font-mono">{tsStatus.tailnetIp}</span></>}
                  </p>
                )}
                {err && <p className="text-sm text-danger">{err}</p>}
                <div className="flex justify-between pt-2">
                  <Button variant="ghost" onClick={() => goto("done")}>Skip</Button>
                  {tsStatus?.installed && !tsStatus.running ? (
                    <Button loading={busy} onClick={tsUp}>Bring tailnet up</Button>
                  ) : (
                    <Button onClick={() => goto("done")}>Continue</Button>
                  )}
                </div>
              </>
            )}

            {step === "done" && (
              <>
                <h1 className="text-2xl font-semibold tracking-tight">You're all set</h1>
                <p className="text-sm text-text-muted">
                  KilnDB is ready. Create your first database from the dashboard.
                </p>
                <div className="flex justify-end pt-2">
                  <Button onClick={finish}>Go to dashboard</Button>
                </div>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Progress({ step }: { step: Step }) {
  const idx = ORDER.indexOf(step);
  return (
    <div className="flex items-center gap-2">
      {ORDER.map((s, i) => (
        <div
          key={s}
          className={`h-1 flex-1 rounded-full transition-colors ${
            i <= idx ? "bg-accent" : "bg-border"
          }`}
        />
      ))}
    </div>
  );
}

function ExperienceCard({
  selected,
  onClick,
  title,
  desc,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-4 rounded-lg border transition-colors ${
        selected
          ? "border-accent bg-accent/10"
          : "border-border bg-bg-subtle hover:border-border-strong"
      }`}
    >
      <div className="font-medium text-sm">{title}</div>
      <div className="mt-1 text-xs text-text-muted">{desc}</div>
    </button>
  );
}
