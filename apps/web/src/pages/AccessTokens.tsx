import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ClipboardCheck, Plus, ShieldCheck } from "lucide-react";
import { PageHeader } from "../components/layout/PageShell";
import { QueryError } from "../components/layout/QueryError";
import { CreateTokenDialog } from "../components/accessTokens/CreateTokenDialog";
import { TokenTable, TokensEmpty, visibleTokens } from "../components/accessTokens/TokenList";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, SkeletonRows, Switch, toast } from "../components/ui";
import { errorMessage } from "../lib/api";
import { useIsAdmin } from "../lib/auth";
import { useDatabases } from "../lib/queries";
import {
  APPROVALS_PATH,
  pendingCount,
  useAccessTokenMutations,
  useAccessTokens,
  usePendingApprovals,
  windowOrigin,
} from "../lib/accessTokens";

export const TOKENS_SUBTITLE = "Access tokens let AI agents and scripts manage databases here without signing in, with only the rights you give them.";

export function AdminsOnly({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} subtitle={TOKENS_SUBTITLE} />
      <EmptyState icon={ShieldCheck} title="Admins only" description="Access tokens are created and managed by admins. Ask one if an agent needs access." />
    </>
  );
}

export function PauseAllControl({
  allPaused,
  busy,
  onToggle,
}: {
  allPaused: boolean;
  busy?: boolean;
  onToggle: (paused: boolean) => void;
}) {
  return (
    <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" data-pause-all={allPaused ? "on" : "off"}>
      <Switch
        label="Pause all tokens"
        description={
          allPaused
            ? "Every token is refused right now. Turn this off to let them work again."
            : "An emergency stop: every agent and script is refused at once, and nothing is deleted."
        }
        checked={allPaused}
        disabled={busy}
        onCheckedChange={onToggle}
      />
      <Badge variant={allPaused ? "warn" : "success"} dot className="self-start sm:self-center">
        {allPaused ? "all paused" : "tokens work"}
      </Badge>
    </Card>
  );
}

export function pauseAllCopy(next: boolean) {
  return next
    ? {
        title: "Pause every access token?",
        description: "Every agent and script that uses a token is refused until you turn this off. Tokens and their settings are kept.",
        confirmLabel: "Pause all tokens",
      }
    : {
        title: "Let tokens work again?",
        description: "Tokens that are not paused on their own, expired or revoked start working again straight away.",
        confirmLabel: "Resume tokens",
      };
}

export function AccessTokens() {
  const isAdmin = useIsAdmin();
  const [params, setParams] = useSearchParams();
  const list = useAccessTokens({ enabled: isAdmin });
  const approvals = usePendingApprovals({ enabled: isAdmin });
  const creating = params.has("create");
  const databases = useDatabases({ enabled: isAdmin && creating });
  const { pauseAll } = useAccessTokenMutations();
  const [confirmPause, setConfirmPause] = useState<boolean | null>(null);
  const [pauseTarget, setPauseTarget] = useState(true);
  const [showRevoked, setShowRevoked] = useState(false);

  if (!isAdmin) return <AdminsOnly title="Access tokens" />;

  const data = list.data;
  const pending = pendingCount(approvals.data);
  const openCreate = () =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("create", "");
      return next;
    });
  const closeCreate = () =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("create");
        return next;
      },
      { replace: true },
    );

  const applyPause = () => {
    if (confirmPause === null) return;
    const next = confirmPause;
    pauseAll.mutate(next, {
      onSuccess: () => {
        setConfirmPause(null);
        toast.success(next ? "All tokens are paused" : "Tokens work again");
      },
      onError: (error) => toast.error(next ? "Could not pause the tokens" : "Could not resume the tokens", { description: errorMessage(error) }),
    });
  };

  const tokens = data?.tokens ?? [];
  const revokedCount = tokens.filter((t) => t.status === "revoked").length;
  const shown = visibleTokens(tokens, showRevoked);
  const copy = pauseAllCopy(pauseTarget);

  return (
    <>
      <PageHeader
        title="Access tokens"
        subtitle={TOKENS_SUBTITLE}
        actions={
          <>
            <Button asChild variant="secondary">
              <Link to={APPROVALS_PATH}>
                <ClipboardCheck aria-hidden /> Approvals
                {pending > 0 && (
                  <Badge variant="info" size="sm" aria-label={`${pending} waiting`}>
                    {pending}
                  </Badge>
                )}
              </Link>
            </Button>
            {tokens.length > 0 && (
              <Button onClick={openCreate}>
                <Plus aria-hidden /> Create token
              </Button>
            )}
          </>
        }
      />

      {list.isPending ? (
        <Card>
          <SkeletonRows rows={4} label="Loading access tokens" />
        </Card>
      ) : list.isError && !data ? (
        <QueryError error={list.error} title="Could not load the access tokens" onRetry={list.refetch} retrying={list.isFetching} />
      ) : (
        <div className="space-y-4">
          {list.isError && (
            <QueryError error={list.error} title="Could not refresh the tokens; showing what was last read" onRetry={list.refetch} retrying={list.isFetching} />
          )}
          {pending > 0 && (
            <Alert
              variant="info"
              title={pending === 1 ? "An agent is waiting for your approval" : `${pending} requests are waiting for your approval`}
              action={
                <Button asChild size="xs" variant="secondary">
                  <Link to={APPROVALS_PATH}>Review</Link>
                </Button>
              }
            />
          )}
          {tokens.length > 0 && (
            <PauseAllControl allPaused={data!.allPaused} busy={pauseAll.isPending} onToggle={(next) => {
                setPauseTarget(next);
                setConfirmPause(next);
              }} />
          )}
          {tokens.length === 0 ? (
            <TokensEmpty presets={data!.presets} onCreate={openCreate} />
          ) : (
            <section aria-labelledby="tokens-title" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="tokens-title" className="text-heading font-semibold text-text">
                  Tokens
                </h2>
                {revokedCount > 0 && (
                  <Switch size="sm" label={`Show revoked (${revokedCount})`} checked={showRevoked} onCheckedChange={setShowRevoked} />
                )}
              </div>
              {shown.length === 0 ? (
                <p className="text-body text-text-muted">Every token is revoked. Create a new one when an agent needs access.</p>
              ) : (
                <TokenTable tokens={shown} presets={data!.presets} allPaused={data!.allPaused} />
              )}
            </section>
          )}
        </div>
      )}

      {creating && data && (
        <CreateTokenDialog open onClose={closeCreate} presets={data.presets} databases={databases.data} origin={windowOrigin()} />
      )}

      <ConfirmDialog
        open={confirmPause !== null}
        onClose={() => !pauseAll.isPending && setConfirmPause(null)}
        onConfirm={applyPause}
        tone={pauseTarget ? "danger" : "default"}
        loading={pauseAll.isPending}
        title={copy.title}
        description={copy.description}
        confirmLabel={copy.confirmLabel}
      />
    </>
  );
}
