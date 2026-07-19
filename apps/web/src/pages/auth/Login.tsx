import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Input";
import { Icon } from "../../components/ui/Icon";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { refetch } = useAuth();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.post("/auth/login", { email, password });
      await refetch();
      nav("/");
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative h-screen flex items-center justify-center p-4 bg-bg">
      <motion.form
        onSubmit={submit}
        className="relative card-surface w-full max-w-sm p-7 space-y-5"
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
      >
        <div className="text-center space-y-2">
          <div className="mx-auto size-10 rounded-md bg-bg-subtle border border-border flex items-center justify-center relative">
            <img src="/kilndb-mark.png" alt="" className="size-6" />
          </div>
          <div className="brand-wordmark text-label text-text-muted">KilnDB</div>
          <h1 className="text-title font-semibold">Sign in</h1>
        </div>
        <Field label="Email" required>
          <Input
            type="text"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </Field>
        <Field label="Password" required>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
        </Field>
        {err && <p className="text-sm text-danger">{err}</p>}
        <Button type="submit" loading={busy} className="w-full">
          Sign in
          <Icon name="arrow_forward" size={14} />
        </Button>
      </motion.form>
    </div>
  );
}
