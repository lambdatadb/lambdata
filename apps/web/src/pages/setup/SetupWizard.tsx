import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, CircleCheck, Database, GitCommitHorizontal, KeyRound, Network } from "lucide-react";
import type { ExperienceLevel, PathValidationResponse, SetupGate, SetupState } from "@lambdata/shared";
import { api, ApiError, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { queryKeys, useSetupState, useTailscaleStatus } from "../../lib/queries";
import { useDocumentTitle } from "../../components/layout/PageShell";
import { DataDirPicker, isSetupTokenRefusal } from "../../components/settings/DataDirPicker";
import { Alert } from "../../components/ui/Alert";
import { BrandMark } from "../../components/ui/Brand";
import { Button } from "../../components/ui/Button";
import { DescriptionItem, DescriptionList } from "../../components/ui/DescriptionList";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { Progress } from "../../components/ui/Progress";
import { RadioCard, RadioGroup } from "../../components/ui/RadioGroup";
import { Skeleton } from "../../components/ui/Skeleton";

type Step = "welcome" | "storage" | "admin" | "experience" | "tailscale" | "done";

const ORDER: Step[] = ["welcome", "storage", "admin", "experience", "tailscale", "done"];

const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  storage: "Storage",
  admin: "Admin account",
  experience: "Experience",
  tailscale: "Tailscale",
  done: "Done",
};

const EMAIL = /^[^\s@]+@[^\s@]+$/;

const isTokenError = isSetupTokenRefusal;

function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded bg-bg-inset px-1 font-mono text-code text-text">{children}</code>;
}

function TokenHelp() {
  return (
    <Alert variant="neutral" title="Where to find the setup token">
      <ul className="mt-1.5 space-y-1.5 text-text-muted">
        <li>
          LambData prints it to its log every time it starts, on the line <InlineCode>LambData first-run setup token</InlineCode>.
        </li>
        <li>
          Docker: run <InlineCode>docker logs lambdata</InlineCode>, using your container&apos;s name.
        </li>
        <li>Unraid: on the Docker tab, click the LambData icon and choose Logs.</li>
        <li>Restarting LambData prints a new token. Use the most recent one.</li>
      </ul>
    </Alert>
  );
}

function defaultStoragePresets(home: string) {
  if (/^[A-Za-z]:[\\/]/.test(home)) {
    return [
      { label: "App data", path: `${home}\\AppData\\Local\\LambData` },
      { label: "Home folder", path: `${home}\\LambData` },
    ];
  }
  if (home.startsWith("/Users/")) {
    return [
      { label: "Application Support", path: `${home}/Library/Application Support/LambData` },
      { label: "Home folder", path: `${home}/LambData` },
      { label: "/usr/local/var", path: "/usr/local/var/lambdata" },
    ];
  }
  return [
    { label: "XDG data", path: `${home}/.local/share/lambdata` },
    { label: "Home folder", path: `${home}/LambData` },
    { label: "/var/lib", path: "/var/lib/lambdata" },
  ];
}

function StepHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h1 className="text-title font-semibold text-text">{title}</h1>
      {description && <p className="text-body text-text-muted">{description}</p>}
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">{children}</div>;
}

export function SetupWizard() {
  useDocumentTitle("Set up");
  const [step, setStep] = useState<Step>("welcome");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [experienceLevel, setExperienceLevel] = useState<ExperienceLevel>("advanced");
  const [tailscaleAuthKey, setTailscaleAuthKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adminTouched, setAdminTouched] = useState(false);
  const [storagePath, setStoragePath] = useState("");
  const [storageValidation, setStorageValidation] = useState<PathValidationResponse | null>(null);
  const [validationUnavailable, setValidationUnavailable] = useState(false);
  const [storageConfigured, setStorageConfigured] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState("");
  const nav = useNavigate();
  const { refetch } = useAuth();
  const qc = useQueryClient();
  const setup = useSetupState();
  const tailscale = useTailscaleStatus({ enabled: step === "tailscale" });
  const gate = setup.data as (SetupState & Partial<SetupGate>) | undefined;
  const tokenRequired = gate?.tokenRequired === true;
  const presets = gate?.homeDir ? defaultStoragePresets(gate.homeDir) : [];

  useEffect(() => {
    const s = setup.data;
    if (!s || storagePath) return;
    if (s.dataDirConfigured) setStorageConfigured(s.dataDir);
    setStoragePath(s.dataDirConfigured || !s.homeDir ? s.dataDir : defaultStoragePresets(s.homeDir)[0]!.path);
  }, [setup.data, storagePath]);

  const goto = (next: Step) => {
    setErr(null);
    setStep(next);
  };

  const tokenBody = () => (tokenRequired ? { setupToken: setupToken.trim() } : {});

  const backToToken = (e: unknown) => {
    setStep("welcome");
    setErr(errorMessage(e, "The setup token was not accepted."));
  };

  const checkToken = async () => {
    setErr(null);
    if (!tokenRequired) {
      goto("storage");
      return;
    }
    if (!setupToken.trim()) {
      setErr("Enter the setup token from the LambData log.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/setup/token", tokenBody());
      goto("storage");
    } catch (e) {
      setErr(errorMessage(e, "The setup token was not accepted."));
    } finally {
      setBusy(false);
    }
  };

  const emailProblem = !email.trim() ? "Enter an email address." : !EMAIL.test(email.trim()) ? "Enter a valid email address." : null;
  const passwordProblem = password.length < 8 ? "Use at least 8 characters." : null;
  const confirmProblem = confirmPassword !== password ? "The passwords do not match." : null;
  const adminValid = !emailProblem && !passwordProblem && !confirmProblem;

  const applyStorage = async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await api.post<{ newPath: string }>("/setup/data-dir", { path: storagePath.trim(), ...tokenBody() });
      setStorageConfigured(res.newPath ?? storagePath.trim());
      goto("admin");
    } catch (e) {
      if (isTokenError(e)) backToToken(e);
      else setErr(errorMessage(e, "Could not use this data directory"));
    } finally {
      setBusy(false);
    }
  };

  const completeAdmin = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/setup/complete", {
        email: email.trim(),
        password,
        displayName: displayName.trim() || null,
        experienceLevel,
        ...tokenBody(),
      });
      setSetupToken("");
      await refetch();
      goto("tailscale");
    } catch (e) {
      if (isTokenError(e)) backToToken(e);
      else setErr(e instanceof ApiError && e.status === 409 ? "Setup was already completed on this server. Sign in instead." : errorMessage(e, "Setup failed"));
    } finally {
      setBusy(false);
    }
  };

  const tailscaleUp = async () => {
    setBusy(true);
    setErr(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      await api.post("/tailscale/up", tailscaleAuthKey.trim() ? { authKey: tailscaleAuthKey.trim() } : {}, { signal: controller.signal });
      setTailscaleAuthKey("");
      await qc.invalidateQueries({ queryKey: queryKeys.tailscale });
    } catch (e) {
      setErr(
        controller.signal.aborted
          ? "Tailscale is still waiting for authentication. Use an auth key, or finish the login from the server log, then check the Network page."
          : errorMessage(e, "Could not bring Tailscale up"),
      );
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  };

  const finish = async () => {
    await qc.invalidateQueries({ queryKey: queryKeys.setup });
    nav("/", { replace: true });
  };

  const index = ORDER.indexOf(step);
  const ts = tailscale.data;

  return (
    <div className="flex min-h-dvh items-start justify-center bg-bg px-4 py-10 sm:items-center">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center justify-between gap-3">
          <BrandMark size="md" />
          <span className="text-label text-text-muted">First-run setup</span>
        </div>
        <div className="rounded-xl border border-border bg-bg-panel p-6 sm:p-8">
          <Progress
            value={((index + 1) / ORDER.length) * 100}
            size="xs"
            label={`Step ${index + 1} of ${ORDER.length} · ${STEP_LABELS[step]}`}
            className="mb-7"
          />

          <div className="space-y-6">
            {step === "welcome" && (
              <>
                <StepHeader
                  title="Welcome to LambData"
                  description="A self-hosted MariaDB control plane. This takes about a minute."
                />
                <ul className="space-y-3 text-body text-text-muted">
                  {[
                    [Database, "Runs and supervises a local MariaDB server"],
                    [KeyRound, "Creates users, passwords and connection strings for each database"],
                    [GitCommitHorizontal, "Keeps commit-style checkpoints you can roll back to"],
                    [Network, "Mirrors external databases and works over Tailscale"],
                  ].map(([Icon, text]) => {
                    const I = Icon as typeof Database;
                    return (
                      <li key={text as string} className="flex items-center gap-3">
                        <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-bg-raised">
                          <I aria-hidden className="size-3.5 text-text" />
                        </span>
                        {text as string}
                      </li>
                    );
                  })}
                </ul>
                {tokenRequired && (
                  <form
                    id="setup-token"
                    noValidate
                    className="space-y-4 border-t border-border pt-5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void checkToken();
                    }}
                  >
                    <Field
                      label="Setup token"
                      required
                      hint="A one-time code that proves you run this server. Nobody can create the first admin account without it."
                    >
                      <Input
                        mono
                        autoFocus
                        autoComplete="one-time-code"
                        autoCapitalize="characters"
                        spellCheck={false}
                        value={setupToken}
                        onChange={(e) => setSetupToken(e.target.value)}
                        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                      />
                    </Field>
                    <TokenHelp />
                  </form>
                )}
                {err && <Alert variant="danger">{err}</Alert>}
                <Actions>
                  <span />
                  {tokenRequired ? (
                    <Button type="submit" form="setup-token" loading={busy} disabled={setup.isPending}>
                      Get started <ArrowRight />
                    </Button>
                  ) : (
                    <Button onClick={() => void checkToken()} disabled={setup.isPending}>
                      Get started <ArrowRight />
                    </Button>
                  )}
                </Actions>
              </>
            )}

            {step === "storage" && (
              <>
                <StepHeader
                  title="Where should LambData keep its data?"
                  description="This folder holds the MariaDB data, checkpoints, the metadata file and your encryption key. Pick somewhere persistent that you back up."
                />
                {setup.isPending ? (
                  <Skeleton className="h-24 w-full" />
                ) : storageConfigured ? (
                  <Alert variant="success" title="Storage is configured">
                    <span className="break-all font-mono text-code text-text">{storageConfigured}</span>
                    <span className="mt-1 block">You can move it later from Settings.</span>
                  </Alert>
                ) : (
                  <>
                    {setup.data && (
                      <p className="text-label text-text-subtle">
                        Currently using a temporary path: <span className="break-all font-mono">{setup.data.dataDir}</span>
                      </p>
                    )}
                    <DataDirPicker
                      value={storagePath}
                      onChange={setStoragePath}
                      onValidation={setStorageValidation}
                      onValidationUnavailable={setValidationUnavailable}
                      onSetupTokenRejected={backToToken}
                      setupToken={tokenRequired ? setupToken : undefined}
                      disabled={busy}
                      pickerPrompt="Select LambData data directory"
                      presets={presets}
                    />
                    {busy && <Progress value={null} label="Preparing the data directory. Existing data is copied, which can take a while." />}
                  </>
                )}
                {err && <Alert variant="danger">{err}</Alert>}
                <Actions>
                  <Button variant="ghost" onClick={() => goto("welcome")} disabled={busy}>
                    <ArrowLeft /> Back
                  </Button>
                  {storageConfigured ? (
                    <Button onClick={() => goto("admin")}>
                      Continue <ArrowRight />
                    </Button>
                  ) : (
                    <Button
                      loading={busy}
                      disabled={!(storageValidation?.ok || (validationUnavailable && storagePath.trim()))}
                      onClick={applyStorage}
                    >
                      Use this location <ArrowRight />
                    </Button>
                  )}
                </Actions>
              </>
            )}

            {step === "admin" && (
              <form
                noValidate
                className="space-y-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  setAdminTouched(true);
                  if (adminValid) goto("experience");
                }}
              >
                <StepHeader title="Create the admin account" description="You sign in to the console with this account." />
                <div className="space-y-4">
                  <Field label="Email" required error={adminTouched ? emailProblem : null}>
                    <Input
                      type="email"
                      autoFocus
                      autoComplete="username"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                    />
                  </Field>
                  <Field label="Display name" hint="Optional. Shown in the activity log.">
                    <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" autoComplete="name" />
                  </Field>
                  <Field label="Password" required hint="At least 8 characters." error={adminTouched ? passwordProblem : null}>
                    <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </Field>
                  <Field label="Confirm password" required error={adminTouched ? confirmProblem : null}>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                    />
                  </Field>
                </div>
                <Actions>
                  <Button variant="ghost" onClick={() => goto("storage")}>
                    <ArrowLeft /> Back
                  </Button>
                  <Button type="submit">
                    Continue <ArrowRight />
                  </Button>
                </Actions>
              </form>
            )}

            {step === "experience" && (
              <>
                <StepHeader
                  title="How comfortable are you with SQL?"
                  description="This changes labels and which options are shown first. You can switch it any time in Settings."
                />
                <RadioGroup
                  value={experienceLevel}
                  onValueChange={(v) => setExperienceLevel(v as ExperienceLevel)}
                  aria-label="Experience level"
                  className="grid-cols-1 sm:grid-cols-2"
                >
                  <RadioCard value="novice" title="I'm new to this" description="Plain-English labels and a guided interface." />
                  <RadioCard value="advanced" title="I know my way around" description="Standard MySQL terms and every option visible." />
                </RadioGroup>
                {err && <Alert variant="danger">{err}</Alert>}
                <Actions>
                  <Button variant="ghost" onClick={() => goto("admin")} disabled={busy}>
                    <ArrowLeft /> Back
                  </Button>
                  <Button loading={busy} onClick={completeAdmin}>
                    Create account <ArrowRight />
                  </Button>
                </Actions>
              </>
            )}

            {step === "tailscale" && (
              <>
                <StepHeader
                  title="Tailscale"
                  description="Optional. Reach your databases over your tailnet instead of the LAN. You can set this up later on the Network page."
                />
                {tailscale.isPending ? (
                  <Skeleton className="h-16 w-full" />
                ) : !ts ? (
                  <Alert variant="neutral">Could not read the Tailscale status. You can configure it later on the Network page.</Alert>
                ) : ts.managedBy === "unraid" ? (
                  <Alert variant="info" title="Managed by Unraid">
                    Authenticate from the container log or change the networking settings in the Unraid template.
                  </Alert>
                ) : ts.running ? (
                  <Alert variant="success" title="Tailscale is up">
                    <DescriptionList className="mt-2">
                      <DescriptionItem term="Hostname" mono>
                        {ts.hostname ?? "—"}
                      </DescriptionItem>
                      <DescriptionItem term="Tailnet IP" mono>
                        {ts.tailnetIp ?? "—"}
                      </DescriptionItem>
                    </DescriptionList>
                  </Alert>
                ) : !ts.installed ? (
                  <Alert variant="neutral">Tailscale is not installed on this server. Continue without it; you can add it later.</Alert>
                ) : (
                  <Field label="Auth key" hint="Recommended. Without a key, Tailscale waits for a browser login printed in the server log.">
                    <Input
                      type="password"
                      mono
                      autoComplete="off"
                      value={tailscaleAuthKey}
                      onChange={(e) => setTailscaleAuthKey(e.target.value)}
                      placeholder="tskey-auth-…"
                    />
                  </Field>
                )}
                {busy && <Progress value={null} label="Bringing Tailscale up" />}
                {err && <Alert variant="danger">{err}</Alert>}
                <Actions>
                  {ts && ts.managedBy !== "unraid" && ts.installed && !ts.running ? (
                    <>
                      <Button variant="ghost" onClick={() => goto("done")} disabled={busy}>
                        Skip
                      </Button>
                      <Button loading={busy} onClick={tailscaleUp}>
                        Bring tailnet up
                      </Button>
                    </>
                  ) : (
                    <>
                      <span />
                      <Button onClick={() => goto("done")}>
                        Continue <ArrowRight />
                      </Button>
                    </>
                  )}
                </Actions>
              </>
            )}

            {step === "done" && (
              <>
                <div className="grid size-10 place-items-center rounded-lg border border-success/30 bg-success/10">
                  <CircleCheck aria-hidden className="size-5 text-success" />
                </div>
                <StepHeader title="You're all set" description="LambData is ready. Create your first database from the dashboard." />
                <Actions>
                  <span />
                  <Button onClick={() => void finish()}>
                    <Check /> Go to the dashboard
                  </Button>
                </Actions>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
