import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AuditLogEntry } from "@lambdata/shared";
import { ChevronRight, History, KeyRound, RotateCcw, Search, ShieldCheck } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { APPROVALS_PATH, tokenPath } from "../lib/accessTokens";
import { useAuth } from "../lib/auth";
import { formatDate, formatRelativeTime } from "../lib/format";
import { PageHeader } from "../components/layout/PageShell";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  Input,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableSkeleton,
} from "../components/ui";
import { isForbidden, pollEvery, useAuditTargets } from "../lib/queries";

const PAGE = 100;
const MAX = 500;

export function auditOutcome(details: string | null): { withErrors: boolean; forced: boolean } {
  if (!details) return { withErrors: false, forced: false };
  try {
    const parsed = JSON.parse(details) as { outcome?: unknown; forced?: unknown } | null;
    if (!parsed || typeof parsed !== "object") return { withErrors: false, forced: false };
    return { withErrors: parsed.outcome === "done-with-errors", forced: parsed.forced === true };
  } catch {
    return { withErrors: false, forced: false };
  }
}

function prettyDetails(details: string | null): string | null {
  if (!details) return null;
  try {
    const parsed: unknown = JSON.parse(details);
    if (parsed === null || (typeof parsed === "object" && Object.keys(parsed as object).length === 0)) return null;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return details;
  }
}

export function tokenTarget(target: string | null): { label: string; href: string } | null {
  if (!target) return null;
  if (target.startsWith("apr_")) return { label: "An approval request", href: APPROVALS_PATH };
  if (target.startsWith("tok_")) return { label: "An access token", href: tokenPath(target) };
  return null;
}

export function isTokenActor(log: Pick<AuditLogEntry, "actor_kind">): boolean {
  return log.actor_kind === "token";
}

export function ActorCell({ log }: { log: AuditLogEntry }) {
  if (isTokenActor(log)) {
    const name = log.user_display_name || "Access token";
    return (
      <div className="flex min-w-0 items-center gap-2.5" data-actor="token">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full border border-border bg-bg-raised text-text-muted">
          <KeyRound className="size-3" />
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          {log.token_id ? (
            <Link
              to={tokenPath(log.token_id)}
              className="truncate text-body text-text underline decoration-border-control underline-offset-4 hover:decoration-text"
            >
              {name}
            </Link>
          ) : (
            <span className="truncate text-body text-text">{name}</span>
          )}
          <Badge variant="muted" size="sm">
            token
          </Badge>
        </div>
      </div>
    );
  }
  const who = log.user_display_name || log.user_email || "System";
  return (
    <div className="flex min-w-0 items-center gap-2.5" data-actor="user">
      <Avatar size="sm" name={log.user_id ? who : "System"} />
      <div className="min-w-0">
        <div className="truncate text-body text-text">{who}</div>
        {log.user_display_name && log.user_email && <div className="truncate text-micro text-text-subtle">{log.user_email}</div>}
      </div>
    </div>
  );
}

export function Activity() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [limit, setLimit] = useState(PAGE);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const logsQuery = useQuery({
    queryKey: ["audit-logs", { limit }],
    queryFn: () => api.get<{ logs: AuditLogEntry[] }>(`/system/audit-logs?limit=${limit}`),
    enabled: isAdmin,
    refetchInterval: pollEvery(10_000),
    placeholderData: keepPreviousData,
  });

  const logs = logsQuery.data?.logs ?? [];
  const baseTarget = useAuditTargets(isAdmin);
  const targetOf = (target: string | null) => tokenTarget(target) ?? baseTarget(target);
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle
        ? logs.filter((log) =>
            [log.action, log.target, targetOf(log.target)?.label, log.user_email, log.user_display_name, log.details, isTokenActor(log) ? "token" : null]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(needle)),
          )
        : logs,
    [logs, needle, targetOf],
  );

  const header = <PageHeader title="Activity" subtitle="Every change made on this instance, newest first." />;

  if (!isAdmin || isForbidden(logsQuery.error)) {
    return (
      <>
        {header}
        <EmptyState
          icon={ShieldCheck}
          title="Admins only"
          description="The activity log can include connection details and user emails, so only admins can read it. Ask an admin if you need to check a change."
        />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Input
            aria-label="Filter activity"
            placeholder="Filter by action, user or target"
            leading={<Search />}
            wrapperClassName="sm:max-w-xs"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {logsQuery.data && (
            <span className="text-label text-text-muted">
              {needle ? `${visible.length} of ${logs.length} events` : `Latest ${logs.length} events`}
            </span>
          )}
        </div>

        {logsQuery.isError && !logsQuery.data ? (
          <Alert
            variant="danger"
            title="Could not load the activity log"
            action={
              <Button size="xs" variant="secondary" onClick={() => logsQuery.refetch()}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            }
          >
            {errorMessage(logsQuery.error, "The server did not answer.")}
          </Alert>
        ) : !logsQuery.isPending && logs.length === 0 ? (
          <EmptyState icon={History} title="No activity yet" description="Changes to databases, users and settings are recorded here." />
        ) : (
          <Card flush>
            <Table flush caption="Activity log">
              <THead>
                <TR>
                  <TH className="w-28">When</TH>
                  <TH>Who</TH>
                  <TH>Action</TH>
                  <TH className="hidden md:table-cell">Target</TH>
                  <TH className="w-px">
                    <span className="sr-only">Details</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {logsQuery.isPending ? (
                  <TableSkeleton rows={8} cols={4} />
                ) : visible.length === 0 ? (
                  <TR>
                    <TD colSpan={5} className="py-10 text-center text-text-muted">
                      Nothing matches “{filter.trim()}”.
                    </TD>
                  </TR>
                ) : (
                  visible.map((log) => {
                    const details = prettyDetails(log.details);
                    const open = expanded === log.id;
                    const target = targetOf(log.target);
                    const outcome = auditOutcome(log.details);
                    return (
                      <Fragment key={log.id}>
                        <TR className={open ? "border-b-0" : undefined}>
                          <TD className="whitespace-nowrap text-label text-text-muted" title={formatDate(log.at)}>
                            {formatRelativeTime(log.at)}
                          </TD>
                          <TD>
                            <ActorCell log={log} />
                          </TD>
                          <TD>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant="muted" mono>
                                {log.action}
                              </Badge>
                              {outcome.forced && <Badge variant="warn">forced</Badge>}
                              {outcome.withErrors && <Badge variant="warn">finished with errors</Badge>}
                            </div>
                            {target && (
                              <div className="mt-1 max-w-[12rem] truncate text-micro text-text-subtle md:hidden">{target.label}</div>
                            )}
                          </TD>
                          <TD className="hidden max-w-[16rem] truncate text-text-muted md:table-cell" title={log.target ?? undefined}>
                            {!target ? (
                              "—"
                            ) : target.href ? (
                              <Link to={target.href} className="text-text underline decoration-border-control underline-offset-4 hover:decoration-text">
                                {target.label}
                              </Link>
                            ) : (
                              <span className="font-mono text-code">{target.label}</span>
                            )}
                          </TD>
                          <TD className="text-right">
                            {details && (
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-expanded={open}
                                aria-controls={`activity-${log.id}`}
                                aria-label={`Details of ${log.action}`}
                                onClick={() => setExpanded(open ? null : log.id)}
                              >
                                <ChevronRight className={open ? "rotate-90 transition-transform" : "transition-transform"} aria-hidden />
                              </Button>
                            )}
                          </TD>
                        </TR>
                        {open && details && (
                          <TR id={`activity-${log.id}`} className="hover:bg-transparent">
                            <TD colSpan={5} className="pb-4 pt-0">
                              <CodeBlock code={details} language="json" wrap wrapToggle={false} maxHeight={260} />
                            </TD>
                          </TR>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </TBody>
            </Table>
            {logs.length >= limit && limit < MAX && (
              <div className="flex justify-center border-t border-border px-5 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={logsQuery.isFetching && logsQuery.isPlaceholderData}
                  onClick={() => setLimit((l) => Math.min(MAX, l + PAGE))}
                >
                  Show older events
                </Button>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
