import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { StorageBucket } from "@lambdata/shared";
import { Button, Dialog, Field, Input, Switch, useToast } from "../ui";
import { api, errorMessage } from "../../lib/api";

const BUCKET_NAME = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;

function nameError(name: string): string | null {
  if (!name) return "Enter a name.";
  if (name.length < 3 || name.length > 63) return "Use 3 to 63 characters.";
  if (!BUCKET_NAME.test(name)) return "Use lowercase letters, numbers, underscores or hyphens, starting and ending with a letter or number.";
  return null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (bucket: StorageBucket) => void;
}

export function CreateBucketDialog({ open, onClose, onCreated }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [isPublic, setPublic] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setPublic(false);
    setSubmitted(false);
    setServerError(null);
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.post<{ bucket: StorageBucket }>("/storage/buckets", { name, public: isPublic }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["storage", "buckets"] }),
  });

  const error = nameError(name);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New bucket"
      description="A folder in the LambData data directory for files, exports and app assets."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-bucket" loading={create.isPending}>
            Create bucket
          </Button>
        </>
      }
    >
      <form
        id="create-bucket"
        noValidate
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          setServerError(null);
          if (error || create.isPending) return;
          create.mutate(undefined, {
            onSuccess: (res) => {
              toast.success(`Bucket ${res.bucket.name} created`);
              onCreated(res.bucket);
              onClose();
            },
            onError: (err) => setServerError(errorMessage(err, "Could not create the bucket")),
          });
        }}
      >
        <Field
          label="Name"
          required
          hint="3 to 63 lowercase letters, numbers, underscores or hyphens."
          error={(submitted && error) || serverError || undefined}
        >
          <Input
            mono
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            placeholder="avatars"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Switch
          checked={isPublic}
          onCheckedChange={setPublic}
          label="Public read URLs"
          description="Anyone with an object's URL can download it without signing in. Leave off for anything private."
        />
      </form>
    </Dialog>
  );
}
