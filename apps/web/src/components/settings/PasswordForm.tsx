import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { User } from "@lambdata/shared";
import { Alert, Button, Card, Field, FieldGroup, Input, useToast } from "../ui";
import { api, ApiError, errorMessage } from "../../lib/api";

function blamesCurrentPassword(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 403 || (error.status === 400 && /current password/i.test(error.message));
}

export function PasswordForm({ user }: { user: User }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [currentServerError, setCurrentServerError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/users/${encodeURIComponent(user.id)}`, { currentPassword: current, password: next }),
  });

  const currentError = !current ? "Enter your current password." : null;
  const nextError =
    next.length < 8
      ? "Use at least 8 characters."
      : next === current
        ? "Choose a password that differs from the current one."
        : null;
  const repeatError = repeat !== next ? "The passwords don't match." : null;

  return (
    <Card>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          setCurrentServerError(null);
          setFormError(null);
          if (currentError || nextError || repeatError || save.isPending) return;
          save.mutate(undefined, {
            onSuccess: () => {
              setCurrent("");
              setNext("");
              setRepeat("");
              setSubmitted(false);
              toast.success("Password changed", { description: "Your other sessions were signed out; this one stays signed in." });
            },
            onError: (err) => {
              if (blamesCurrentPassword(err)) setCurrentServerError(errorMessage(err, "The current password is incorrect."));
              else setFormError(errorMessage(err, "Could not change the password"));
            },
          });
        }}
      >
        <input type="email" name="username" autoComplete="username" value={user.email} readOnly hidden />
        <Field
          label="Current password"
          required
          className="sm:max-w-[calc(50%-0.5rem)]"
          error={(submitted && currentError) || currentServerError || undefined}
        >
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              setCurrentServerError(null);
            }}
          />
        </Field>
        <FieldGroup>
          <Field label="New password" required hint="At least 8 characters." error={submitted && nextError ? nextError : undefined}>
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Repeat new password" required error={submitted && repeatError ? repeatError : undefined}>
            <Input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </Field>
        </FieldGroup>
        {formError && <Alert variant="danger">{formError}</Alert>}
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" loading={save.isPending} disabled={!current && !next && !repeat}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}
