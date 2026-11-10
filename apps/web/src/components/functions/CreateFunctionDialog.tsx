import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { EdgeFunction } from "@lambdata/shared";
import { Button, Dialog, Field, Input, Switch, useToast } from "../ui";
import { api, errorMessage } from "../../lib/api";
import { FUNCTION_NAME, functionsListKey } from "./keys";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (fn: EdgeFunction) => void;
}

export function CreateFunctionDialog({ open, onClose, onCreated }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [verifyJwt, setVerifyJwt] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setVerifyJwt(true);
    setSubmitted(false);
    setServerError(null);
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.post<{ function: EdgeFunction }>("/functions", { name, verifyJwt }),
    onSuccess: () => qc.invalidateQueries({ queryKey: functionsListKey }),
  });

  const nameError = !name
    ? "Enter a name."
    : !FUNCTION_NAME.test(name)
      ? "Use up to 63 lowercase letters, numbers, underscores or hyphens, starting and ending with a letter or number."
      : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New function"
      description="Starts from a small TypeScript template you can edit right away."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-function" loading={create.isPending}>
            Create function
          </Button>
        </>
      }
    >
      <form
        id="create-function"
        noValidate
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          setServerError(null);
          if (nameError || create.isPending) return;
          create.mutate(undefined, {
            onSuccess: (res) => {
              toast.success(`Function ${res.function.name} created`);
              onCreated(res.function);
              onClose();
            },
            onError: (err) => setServerError(errorMessage(err, "Could not create the function")),
          });
        }}
      >
        <Field
          label="Name"
          required
          hint={name && !nameError ? `Served at /functions/v1/${name}` : "Lowercase letters, numbers, underscores and hyphens."}
          error={(submitted && nameError) || serverError || undefined}
        >
          <Input
            mono
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            placeholder="stripe-webhook"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Switch
          checked={verifyJwt}
          onCheckedChange={setVerifyJwt}
          label="Require an App Auth token"
          description="Turn off only for public endpoints such as webhooks, and check the caller yourself."
        />
      </form>
    </Dialog>
  );
}
