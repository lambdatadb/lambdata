import { useState } from "react";
import { Navigate, useLocation, useNavigate, type Location } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import type { AuthResponse } from "@lambdata/shared";
import { api, ApiError, errorMessage } from "../../lib/api";
import { acceptSignedInUser, useAuth } from "../../lib/auth";
import { useDocumentTitle } from "../../components/layout/PageShell";
import { Alert } from "../../components/ui/Alert";
import { BrandMark } from "../../components/ui/Brand";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";

function destination(state: unknown): string {
  const from = (state as { from?: Location } | null)?.from;
  if (!from || from.pathname === "/login" || from.pathname === "/setup") return "/";
  return `${from.pathname}${from.search ?? ""}${from.hash ?? ""}`;
}

export function Login() {
  useDocumentTitle("Sign in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { user, isLoading } = useAuth();
  const target = destination(location.state);

  if (!isLoading && user) return <Navigate to={target} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await api.post<AuthResponse>("/auth/login", { email: email.trim(), password });
      acceptSignedInUser(qc, res.user);
      nav(target, { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setErr("That email and password do not match an account.");
      else if (error instanceof ApiError && error.status === 429) setErr("Too many attempts. Wait a minute and try again.");
      else setErr(errorMessage(error, "Sign-in failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <BrandMark size="lg" />
        </div>
        <form onSubmit={submit} noValidate className="space-y-5 rounded-xl border border-border bg-bg-panel p-6 sm:p-7">
          <div className="space-y-1">
            <h1 className="text-title font-semibold text-text">Sign in</h1>
            <p className="text-body text-text-muted">Use your LambData console account.</p>
          </div>
          <Field label="Email">
            <Input
              type="email"
              autoFocus
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          {err && (
            <Alert variant="danger" role="alert">
              {err}
            </Alert>
          )}
          <Button type="submit" size="lg" loading={busy} disabled={!email.trim() || !password} className="w-full">
            Sign in <ArrowRight />
          </Button>
        </form>
        <p className="mt-6 text-center text-micro text-text-subtle">Self-hosted MariaDB control plane</p>
      </div>
    </div>
  );
}
