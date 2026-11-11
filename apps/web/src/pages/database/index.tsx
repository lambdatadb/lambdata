import { Suspense } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeftRight, Database as DatabaseIcon, SearchX } from "lucide-react";
import type { Database } from "@lambdata/shared";
import { PageHeader } from "../../components/layout/PageShell";
import { QueryError } from "../../components/layout/QueryError";
import { ErrorBoundary } from "../../components/layout/ErrorBoundary";
import { Badge, StatusDot } from "../../components/ui/Badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/Breadcrumb";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/Tabs";
import { RepoBadge } from "../../components/checkpoints/RepoBadge";
import { useAuth } from "../../lib/auth";
import { tokenPath } from "../../lib/accessTokens";
import { databasePath } from "../../lib/commands";
import { formatRelativeTime } from "../../lib/format";
import { isNotFound, useDatabase } from "../../lib/queries";
import { visibleDatabaseTabs } from "./tabs";

export function DatabaseOwner({ db, linkTokens }: { db: Pick<Database, "ownerDisplayName" | "createdByTokenId" | "createdByTokenName">; linkTokens: boolean }) {
  if (db.createdByTokenName) {
    return (
      <>
        <span aria-hidden className="text-text-subtle">·</span>
        <span data-created-by-token>
          created by token{" "}
          {linkTokens && db.createdByTokenId ? (
            <Link to={tokenPath(db.createdByTokenId)} className="text-text underline decoration-border-control underline-offset-4 hover:decoration-text">
              {db.createdByTokenName}
            </Link>
          ) : (
            <span className="text-text">{db.createdByTokenName}</span>
          )}
        </span>
      </>
    );
  }
  if (!db.ownerDisplayName) return null;
  return (
    <>
      <span aria-hidden className="text-text-subtle">·</span>
      <span>owned by {db.ownerDisplayName}</span>
    </>
  );
}

export function DatabaseDetailPage() {
  const { id = "" } = useParams();
  return <DatabaseDetail key={id} id={id} />;
}

function Crumbs({ name }: { name?: string }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/databases">Databases</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          {name ? <BreadcrumbPage>{name}</BreadcrumbPage> : <Skeleton className="h-3 w-24" />}
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function TabFallback() {
  return (
    <div role="status" aria-label="Loading" className="grid gap-4 lg:grid-cols-3">
      <Skeleton className="h-56 lg:col-span-2" />
      <Skeleton className="h-56" />
    </div>
  );
}

function statusTone(status: Database["status"]) {
  return status === "active" ? "success" : status === "deleting" ? "danger" : "warn";
}

function DatabaseDetail({ id }: { id: string }) {
  const params = useParams();
  const { user } = useAuth();
  const query = useDatabase(id);
  const db = query.data;

  if (query.isPending) {
    return (
      <div role="status" aria-label="Loading database">
        <div className="mb-8 space-y-3">
          <Crumbs />
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-full max-w-xl" />
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-56 lg:col-span-2" />
          <Skeleton className="h-56" />
        </div>
      </div>
    );
  }

  if (query.isError || !db) {
    if (isNotFound(query.error) || !db) {
      return (
        <>
          <div className="mb-6">
            <Crumbs name="Not found" />
          </div>
          <EmptyState
            icon={SearchX}
            title="Database not found"
            description="It may have been deleted, or you may not have access to it."
            action={
              <Button asChild variant="secondary">
                <Link to="/databases">Back to databases</Link>
              </Button>
            }
          />
        </>
      );
    }
    return (
      <>
        <div className="mb-6">
          <Crumbs name="Database" />
        </div>
        <QueryError error={query.error} title="Could not load this database" onRetry={query.refetch} retrying={query.isFetching} />
      </>
    );
  }

  const tabs = visibleDatabaseTabs(db, user);
  const tabId = params.tab ?? "overview";
  const active = tabs.find((t) => t.id === tabId);
  if (!active) return <Navigate to={databasePath(db.id)} replace />;
  const Active = active.component;
  const subpath = params["*"] ?? "";

  return (
    <>
      <PageHeader
        title={db.displayName}
        documentTitle={`${active.id === "overview" ? "" : `${active.label} · `}${db.displayName}`}
        breadcrumb={<Crumbs name={db.displayName} />}
        icon={db.kind === "mirror" ? <ArrowLeftRight /> : <DatabaseIcon />}
        badges={
          <>
            <Badge variant="muted" size="sm" className="gap-1.5">
              <StatusDot tone={statusTone(db.status)} />
              {db.status}
            </Badge>
            {db.kind === "mirror" && (
              <Badge variant="info" size="sm">
                mirror
              </Badge>
            )}
            {db.tailscaleExposed && (
              <Badge variant="muted" size="sm">
                tailnet
              </Badge>
            )}
            <RepoBadge db={db} live />
          </>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-mono text-code text-text">{db.name}</span>
            <span aria-hidden className="text-text-subtle">·</span>
            <span>created {formatRelativeTime(db.createdAt)}</span>
            <DatabaseOwner db={db} linkTokens={user?.role === "admin"} />
          </span>
        }
      />
      <Tabs value={active.id} activationMode="manual" className="gap-6">
        <TabsList aria-label="Database sections">
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id} asChild>
              <Link to={databasePath(db.id, t.id)}>{t.label}</Link>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={active.id} tabIndex={-1} className="focus-visible:ring-0">
          <ErrorBoundary resetKey={active.id}>
            <Suspense fallback={<TabFallback />}>
              <Active db={db} subpath={subpath} />
            </Suspense>
          </ErrorBoundary>
        </TabsContent>
      </Tabs>
    </>
  );
}
