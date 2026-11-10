import { useQuery } from "@tanstack/react-query";
import type { EdgeFunctionInvocation } from "@lambdata/shared";
import { ChevronRight, RotateCcw, Zap } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  CodeBlock,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EmptyState,
  SkeletonRows,
} from "../ui";
import { api, errorMessage } from "../../lib/api";
import { formatDate, formatRelativeTime } from "../../lib/format";
import { functionLogsKey } from "./keys";
import { pollEvery } from "../../lib/queries";

export function useFunctionLogs(name: string) {
  return useQuery({
    queryKey: functionLogsKey(name),
    queryFn: () =>
      api.get<{ invocations: EdgeFunctionInvocation[] }>(`/functions/${encodeURIComponent(name)}/logs?limit=50`),
    refetchInterval: pollEvery(10_000),
  });
}

export function InvocationLog({ name }: { name: string }) {
  const logsQuery = useFunctionLogs(name);
  const invocations = logsQuery.data?.invocations ?? [];

  if (logsQuery.isPending) {
    return (
      <div className="p-5">
        <SkeletonRows rows={4} label="Loading invocations" />
      </div>
    );
  }

  if (logsQuery.isError) {
    return (
      <div className="p-5">
        <Alert
          variant="danger"
          title="Could not load invocations"
          action={
            <Button size="xs" variant="secondary" onClick={() => logsQuery.refetch()}>
              <RotateCcw aria-hidden /> Retry
            </Button>
          }
        >
          {errorMessage(logsQuery.error, "The server did not answer.")}
        </Alert>
      </div>
    );
  }

  if (invocations.length === 0) {
    return (
      <EmptyState
        variant="bare"
        size="sm"
        icon={Zap}
        title="No invocations yet"
        description="Calls to this function show up here within a few seconds."
      />
    );
  }

  return (
    <ul className="divide-y divide-border" aria-label={`Recent invocations of ${name}`}>
      {invocations.map((log) => (
        <InvocationRow key={log.id} log={log} />
      ))}
    </ul>
  );
}

function InvocationRow({ log }: { log: EdgeFunctionInvocation }) {
  const failed = log.error !== null || (log.statusCode !== null && log.statusCode >= 400);
  const body = [log.error, log.logs].filter(Boolean).join("\n\n");
  const summary = (
    <>
      <Badge variant={failed ? "danger" : "success"} mono size="sm" className="w-10 justify-center">
        {log.statusCode ?? "err"}
      </Badge>
      <span className="min-w-0 flex-1 truncate font-mono text-code text-text">
        <span className="text-text-muted">{log.method}</span> {log.path}
      </span>
      <span className="hidden shrink-0 font-mono text-micro tabular-nums text-text-subtle sm:inline">
        {Math.round(Number(log.durationMs))} ms
      </span>
      <span className="w-16 shrink-0 text-right text-micro text-text-subtle" title={formatDate(log.createdAt)}>
        {formatRelativeTime(log.createdAt)}
      </span>
    </>
  );

  if (!body) {
    return <li className="flex items-center gap-3 py-2.5 pl-5 pr-12">{summary}</li>;
  }

  return (
    <li>
      <Collapsible>
        <div className="flex items-center gap-3 py-2.5 pl-5 pr-3">
          {summary}
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="group" aria-label={`Output of ${log.method} ${log.path}`}>
              <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" aria-hidden />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="px-5 pb-3">
          <CodeBlock code={body} language={log.error ? "error" : "logs"} wrap maxHeight={220} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
