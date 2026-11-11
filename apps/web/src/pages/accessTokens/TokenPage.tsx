import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { KeyRound, Pause, Play, SearchX, Trash2 } from "lucide-react";
import type { AccessToken, AccessTokenPresetInfo, Database } from "@lambdata/shared";
import { PageHeader } from "../../components/layout/PageShell";
import { QueryError } from "../../components/layout/QueryError";
import { ActivityList } from "../../components/accessTokens/ActivityList";
import { ConnectAgent } from "../../components/accessTokens/ConnectAgent";
import { PresetLists, TokenStatusBadge } from "../../components/accessTokens/parts";
import { TokenOptions } from "../../components/accessTokens/TokenOptions";
import { lastUsedText } from "../../components/accessTokens/TokenList";
import {
  Alert,
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DescriptionList,
  EmptyState,
  Skeleton,
  SkeletonRows,
  toast,
} from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { useIsAdmin } from "../../lib/auth";
import { formatDate, formatRelativeTime } from "../../lib/format";
import { isNotFound, useDatabases } from "../../lib/queries";
import {
  APPROVALS_PATH,
  TOKENS_PATH,
  draftFromToken,
  hasErrors,
  maskedPrefix,
  mergeActivityPages,
  presetInfo,
  presetLabel,
  updateRequest,
  useAccessToken,
  useAccessTokenMutations,
  useAccessTokens,
  useTokenActivity,
  validateDraft,
  windowOrigin,
  type TokenDraft,
} from "../../lib/accessTokens";
import { AdminsOnly } from "../AccessTokens";

function Crumbs({ name }: { name?: string }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to={TOKENS_PATH}>Access tokens</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>{name ? <BreadcrumbPage>{name}</BreadcrumbPage> : <Skeleton className="h-3 w-24" />}</BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

export function TokenStateAlert({ token, allPaused }: { token: AccessToken; allPaused: boolean }) {
  if (token.status === "revoked")
    return (
      <Alert variant="neutral" title="This token is revoked" data-token-alert="revoked">
        Revoked {formatRelativeTime(token.revokedAt)}. It can never be used again; its settings and activity stay here for the record.
      </Alert>
    );
  if (token.status === "expired")
    return (
      <Alert variant="warning" title="This token has expired" data-token-alert="expired">
        It stopped working on {formatDate(token.expiresAt)}. Pick a new expiry below and save to let it work again.
      </Alert>
    );
  if (token.status === "paused")
    return (
      <Alert variant="warning" title="This token is paused" data-token-alert="paused">
        Every request with it is refused until you resume it.
      </Alert>
    );
  if (allPaused)
    return (
      <Alert
        variant="warning"
        title="All tokens are paused"
        data-token-alert="all-paused"
        action={
          <Button asChild size="xs" variant="secondary">
            <Link to={TOKENS_PATH}>Open access tokens</Link>
          </Button>
        }
      >
        This token is refused like every other until you turn off “Pause all tokens”.
      </Alert>
    );
  return null;
}

export function TokenSettings({
  token,
  info,
  databases,
}: {
  token: AccessToken;
  info: AccessTokenPresetInfo | undefined;
  databases: Pick<Database, "id" | "displayName" | "name">[] | undefined;
}) {
  const { update } = useAccessTokenMutations();
  const [draft, setDraft] = useState<TokenDraft>(() => draftFromToken(token));
  const [showErrors, setShowErrors] = useState(false);
  const revoked = token.status === "revoked";
  const original = draftFromToken(token);
  const errors = showErrors ? validateDraft(draft, Date.now(), original) : {};
  const body = updateRequest(token, draft, info);
  const dirty = Object.keys(body).length > 0;

  const save = () => {
    setShowErrors(true);
    if (hasErrors(validateDraft(draft, Date.now(), original))) return;
    update.mutate(
      { id: token.id, body },
      {
        onSuccess: (res) => {
          setDraft(draftFromToken(res.token));
          setShowErrors(false);
          toast.success("Changes saved");
        },
        onError: (error) => toast.error("Could not save the changes", { description: errorMessage(error) }),
      },
    );
  };

  return (
    <Card className="space-y-5">
      <CardHeader title="Settings" description="Everything except the preset can be changed. Changes apply to the next request." />
      <TokenOptions
        draft={draft}
        patch={(next) => setDraft((d) => ({ ...d, ...next }))}
        errors={errors}
        info={info}
        databases={databases}
        disabled={revoked || update.isPending}
      />
      {!revoked && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            variant="ghost"
            disabled={!dirty || update.isPending}
            onClick={() => {
              setDraft(draftFromToken(token));
              setShowErrors(false);
            }}
          >
            Discard changes
          </Button>
          <Button onClick={save} disabled={!dirty} loading={update.isPending}>
            Save changes
          </Button>
        </div>
      )}
    </Card>
  );
}

function TokenActivity({ id }: { id: string }) {
  const activity = useTokenActivity(id);
  const entries = mergeActivityPages(activity.data?.pages);
  return (
    <Card flush>
      <CardHeader divided title="Activity" description="Every request this token made, newest first." />
      {activity.isPending ? (
        <SkeletonRows rows={5} label="Loading activity" className="p-5" />
      ) : activity.isError && entries.length === 0 ? (
        <div className="p-5">
          <QueryError error={activity.error} title="Could not load the activity" onRetry={activity.refetch} retrying={activity.isFetching} />
        </div>
      ) : (
        <ActivityList
          entries={entries}
          hasMore={!!activity.hasNextPage}
          loadingMore={activity.isFetchingNextPage}
          onMore={() => void activity.fetchNextPage()}
        />
      )}
    </Card>
  );
}

export function TokenPage() {
  const { id = "" } = useParams();
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <AdminsOnly title="Access token" />;
  return <TokenDetail key={id} id={id} />;
}

function TokenDetail({ id }: { id: string }) {
  const query = useAccessToken(id);
  const list = useAccessTokens();
  const databases = useDatabases();
  const { update, revoke } = useAccessTokenMutations();
  const [confirm, setConfirm] = useState<"revoke" | "pause" | null>(null);
  const token = query.data;
  const presets = list.data?.presets ?? [];
  const allPaused = list.data?.allPaused ?? false;

  if (query.isPending) {
    return (
      <div role="status" aria-label="Loading access token" className="space-y-6">
        <Crumbs />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (query.isError || !token) {
    return (
      <>
        <div className="mb-6">
          <Crumbs name={isNotFound(query.error) || !token ? "Not found" : "Access token"} />
        </div>
        {isNotFound(query.error) || !token ? (
          <EmptyState
            icon={SearchX}
            title="Access token not found"
            description="It may never have existed here. Revoked tokens stay in the list, so check the link."
            action={
              <Button asChild variant="secondary">
                <Link to={TOKENS_PATH}>Back to access tokens</Link>
              </Button>
            }
          />
        ) : (
          <QueryError error={query.error} title="Could not load this token" onRetry={query.refetch} retrying={query.isFetching} />
        )}
      </>
    );
  }

  const info = presetInfo(presets, token.preset);
  const revoked = token.status === "revoked";

  const setPaused = (paused: boolean) =>
    update.mutate(
      { id: token.id, body: { paused } },
      {
        onSuccess: () => {
          setConfirm(null);
          toast.success(paused ? `${token.name} is paused` : `${token.name} works again`);
        },
        onError: (error) => toast.error(paused ? "Could not pause the token" : "Could not resume the token", { description: errorMessage(error) }),
      },
    );

  const doRevoke = () =>
    revoke.mutate(token.id, {
      onSuccess: () => {
        setConfirm(null);
        toast.success(`${token.name} is revoked`, { description: "Requests with it are refused from now on." });
      },
      onError: (error) => toast.error("Could not revoke the token", { description: errorMessage(error) }),
    });

  return (
    <>
      <PageHeader
        title={token.name}
        documentTitle={`${token.name} · Access tokens`}
        breadcrumb={<Crumbs name={token.name} />}
        icon={<KeyRound />}
        badges={
          <>
            <TokenStatusBadge token={token} allPaused={allPaused} />
            <Badge variant="outline" size="sm">
              {presetLabel(token.preset, presets)}
            </Badge>
          </>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-mono text-code text-text">{maskedPrefix(token.prefix)}</span>
            <span aria-hidden className="text-text-subtle">·</span>
            <span>created {formatRelativeTime(token.createdAt)}</span>
            {token.createdByDisplayName && (
              <>
                <span aria-hidden className="text-text-subtle">·</span>
                <span>by {token.createdByDisplayName}</span>
              </>
            )}
          </span>
        }
        actions={
          revoked ? undefined : (
            <>
              {token.paused ? (
                <Button variant="secondary" onClick={() => setPaused(false)} loading={update.isPending && confirm === null}>
                  <Play aria-hidden /> Resume
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => setConfirm("pause")}>
                  <Pause aria-hidden /> Pause
                </Button>
              )}
              <Button variant="danger-soft" onClick={() => setConfirm("revoke")}>
                <Trash2 aria-hidden /> Revoke
              </Button>
            </>
          )
        }
      />

      <div className="space-y-4">
        <TokenStateAlert token={token} allPaused={allPaused} />

        <div className="grid items-start gap-4 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            <TokenActivity id={token.id} />
          </div>
          <div className="space-y-4">
            <Card>
              <DescriptionList
                items={[
                  { term: "Last used", value: <span title={token.lastUsedAt ? formatDate(token.lastUsedAt) : undefined}>{lastUsedText(token)}</span> },
                  { term: "Databases created", value: String(token.databasesCreated) },
                  {
                    term: "Waiting for approval",
                    value: token.pendingApprovals > 0 ? <Link to={APPROVALS_PATH}>{token.pendingApprovals}</Link> : "None",
                  },
                  { term: "Expires", value: token.expiresAt ? formatDate(token.expiresAt) : "Never" },
                ]}
              />
            </Card>
            <Card className="space-y-3">
              <CardHeader title="What it may do" description={info?.summary} />
              {info ? (
                <PresetLists info={info} compact className="sm:grid-cols-1" />
              ) : (
                <p className="text-label text-text-muted">The preset description could not be loaded.</p>
              )}
            </Card>
          </div>
        </div>

        <TokenSettings key={`${token.id}:${token.status}`} token={token} info={info} databases={databases.data} />

        {!revoked && (
          <Card>
            <ConnectAgent origin={windowOrigin()} secret={null} />
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={confirm === "pause"}
        onClose={() => !update.isPending && setConfirm(null)}
        onConfirm={() => setPaused(true)}
        loading={update.isPending}
        title={`Pause ${token.name}?`}
        description="Every request with this token is refused until you resume it. Nothing else changes."
        confirmLabel="Pause token"
      />
      <ConfirmDialog
        open={confirm === "revoke"}
        onClose={() => !revoke.isPending && setConfirm(null)}
        onConfirm={doRevoke}
        tone="danger"
        loading={revoke.isPending}
        title={`Revoke ${token.name}?`}
        description="The token stops working at once and cannot be turned back on. Databases it created stay. To give the agent access again, create a new token."
        confirmLabel="Revoke token"
      />
    </>
  );
}
