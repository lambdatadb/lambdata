import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { Button, Card, ConfirmDialog, useToast } from "../ui";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";

export function SignOutEverywhereCard() {
  const { logout } = useAuth();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);

  const signOutAll = useMutation({
    mutationFn: () => api.post<{ ok: true }>("/auth/logout-all"),
  });

  return (
    <Card className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-64 space-y-0.5">
        <h3 className="text-body font-medium text-text">Sign out everywhere</h3>
        <p className="text-label text-text-muted">
          Ends every console session for your account, on every device, including this one.
        </p>
      </div>
      <Button variant="danger-soft" size="sm" onClick={() => setConfirming(true)}>
        <LogOut aria-hidden /> Sign out everywhere
      </Button>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() =>
          signOutAll.mutate(undefined, {
            onSuccess: async () => {
              setConfirming(false);
              toast.success("Signed out everywhere", { description: "Sign in again to keep working." });
              await logout().catch(() => undefined);
            },
            onError: (e) => toast.error(errorMessage(e, "Could not sign out the other sessions")),
          })
        }
        loading={signOutAll.isPending}
        tone="danger"
        title="Sign out everywhere?"
        confirmLabel="Sign out everywhere"
        body="Every browser signed in to your account, including this one, has to sign in again. Use this if you signed in on a device you no longer trust."
      />
    </Card>
  );
}
