import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppAuthUser, AppAuthUserStatus } from "@lambdata/shared";
import { Button, Dialog, Field, Input, SegmentedControl, Switch, useToast } from "../ui";
import { api, errorMessage } from "../../lib/api";
import { appUsersKey } from "./AppUsersCard";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CreateAppUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<AppAuthUserStatus>("active");
  const [emailConfirmed, setEmailConfirmed] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setDisplayName("");
    setPassword("");
    setStatus("active");
    setEmailConfirmed(true);
    setSubmitted(false);
    setServerError(null);
  }, [open]);

  const emailError = !email.trim()
    ? "Enter an email address."
    : !EMAIL.test(email.trim())
      ? "That doesn't look like an email address."
      : null;
  const passwordError = password.length < 8 ? "Use at least 8 characters." : null;

  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: AppAuthUser }>("/app-auth/users", {
        email: email.trim(),
        password,
        displayName: displayName.trim() || null,
        status,
        emailConfirmed,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: appUsersKey }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New app user"
      description="They sign in to your apps with this email and password."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-app-user" loading={create.isPending}>
            Create user
          </Button>
        </>
      }
    >
      <form
        id="create-app-user"
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          setServerError(null);
          if (emailError || passwordError || create.isPending) return;
          create.mutate(undefined, {
            onSuccess: (res) => {
              toast.success(`${res.user.email} created`);
              onClose();
            },
            onError: (err) => setServerError(errorMessage(err, "Could not create the app user")),
          });
        }}
      >
        <Field label="Email" required error={(submitted && emailError) || serverError || undefined}>
          <Input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Display name" hint="Optional">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field
          label="Initial password"
          required
          hint="At least 8 characters. Share it with the user; they can change it from your app."
          error={submitted && passwordError ? passwordError : undefined}
        >
          <Input
            type="text"
            mono
            autoComplete="off"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Status" id="app-user-status">
          <SegmentedControl
            id="app-user-status"
            aria-label="Status"
            className="w-fit"
            value={status}
            onValueChange={(v) => setStatus(v as AppAuthUserStatus)}
            options={[
              { value: "active", label: "Can sign in" },
              { value: "disabled", label: "Disabled" },
            ]}
          />
        </Field>
        <Switch
          checked={emailConfirmed}
          onCheckedChange={setEmailConfirmed}
          label="Email confirmed"
          description="LambData does not send confirmation email, so new users are usually created confirmed."
        />
      </form>
    </Dialog>
  );
}
