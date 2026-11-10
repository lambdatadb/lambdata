import { useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import type { QueryResult } from "@lambdata/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Card, CardContent, CardFooter, CardHeader } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Kbd, KbdGroup } from "../../components/ui/Kbd";
import { Table, TBody, TD, TH, THead, TR } from "../../components/ui/Table";
import { Textarea } from "../../components/ui/Textarea";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDuration, formatNumber } from "../../lib/format";
import { useTerminology } from "../../lib/terminology";
import type { DatabaseTabProps } from "./types";

const RENDER_LIMIT = 1000;

interface ConsoleState {
  sql: string;
  result: QueryResult | null;
  error: string | null;
  ranAt: number | null;
}

const consoles = new Map<string, ConsoleState>();

function initialState(id: string): ConsoleState {
  return consoles.get(id) ?? { sql: "SELECT 1;", result: null, error: null, ranAt: null };
}

function isBufferLike(value: unknown): value is { type: "Buffer"; data: number[] } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  );
}

function renderCell(value: unknown): { text: string; muted: boolean } {
  if (value === null || value === undefined) return { text: "NULL", muted: true };
  if (isBufferLike(value)) {
    const hex = value.data.slice(0, 64).map((b) => b.toString(16).padStart(2, "0")).join("");
    return { text: `0x${hex}${value.data.length > 64 ? "…" : ""}`, muted: false };
  }
  if (typeof value === "object") {
    try {
      return { text: JSON.stringify(value), muted: false };
    } catch {
      return { text: String(value), muted: false };
    }
  }
  return { text: String(value), muted: false };
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function QueryTab({ db }: DatabaseTabProps) {
  const t = useTerminology();
  const { user } = useAuth();
  const [state, setState] = useState<ConsoleState>(() => initialState(db.id));
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    consoles.set(db.id, state);
  }, [db.id, state]);

  useEffect(() => () => controller.current?.abort(), []);

  const run = async () => {
    const sql = state.sql.trim();
    if (!sql || running) return;
    const ctrl = new AbortController();
    controller.current = ctrl;
    setRunning(true);
    try {
      const result = await api.post<QueryResult>(`/databases/${db.id}/query`, { sql: state.sql }, { signal: ctrl.signal });
      setState((s) => ({ ...s, result, error: null, ranAt: Date.now() }));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setState((s) => ({ ...s, error: "Stopped waiting for the result. The statement may still finish on the server.", result: null }));
      } else {
        setState((s) => ({ ...s, error: errorMessage(error, "Query failed"), result: null, ranAt: Date.now() }));
      }
    } finally {
      if (controller.current === ctrl) controller.current = null;
      setRunning(false);
    }
  };

  const result = state.result;
  const shown = result ? result.rows.slice(0, RENDER_LIMIT) : [];

  return (
    <div className="space-y-4">
      <Card flush>
        <CardHeader
          divided
          title={t("queryConsole")}
          description={
            user?.role === "viewer"
              ? "Read-only: SELECT, SHOW, DESCRIBE, EXPLAIN and WITH."
              : (
                  <>
                    Runs as <span className="font-mono text-code text-text">{db.mysqlUser}</span> in{" "}
                    <span className="font-mono text-code text-text">{db.name}</span>. Statements time out after 30 seconds.
                  </>
                )
          }
        />
        <CardContent>
          <Textarea
            aria-label="SQL"
            value={state.sql}
            onChange={(e) => {
              const sql = e.target.value;
              setState((s) => ({ ...s, sql }));
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
            rows={8}
            spellCheck={false}
            className="min-h-40 resize-y"
          />
        </CardContent>
        <CardFooter className="justify-between">
          <span className="hidden items-center gap-1.5 text-micro text-text-subtle sm:inline-flex">
            <KbdGroup>
              <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
              <Kbd>↵</Kbd>
            </KbdGroup>
            to run
          </span>
          <div className="flex items-center gap-2">
            {running && (
              <Button variant="ghost" size="sm" onClick={() => controller.current?.abort()}>
                <Square /> Stop waiting
              </Button>
            )}
            <Button size="sm" loading={running} disabled={!state.sql.trim()} onClick={() => void run()}>
              <Play /> Run
            </Button>
          </div>
        </CardFooter>
      </Card>

      {state.error && (
        <Alert variant="danger" title="The query failed">
          <pre className="whitespace-pre-wrap break-words font-mono text-code">{state.error}</pre>
        </Alert>
      )}

      {result && (
        <Card flush>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3 text-label text-text-muted">
            <span>
              <span className="font-mono text-text">{formatNumber(result.rowCount)}</span> {result.rowCount === 1 ? "row" : "rows"}
              {result.rows.length > RENDER_LIMIT && <> · showing the first {formatNumber(RENDER_LIMIT)}</>}
            </span>
            <span className="font-mono">{formatDuration(result.durationMs)}</span>
          </div>
          {result.columns.length === 0 ? (
            <EmptyState variant="bare" size="sm" title="Statement executed" description="It returned no result set." />
          ) : (
            <Table flush caption="Query result" wrapperClassName="max-h-[60dvh] overflow-auto">
              <THead className="sticky top-0 z-10 bg-bg-raised">
                <TR>
                  {result.columns.map((c, i) => (
                    <TH key={`${c}:${i}`} className="font-mono">
                      {c}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={result.columns.length} className="px-4 py-8 text-center text-body text-text-muted">
                      No rows.
                    </td>
                  </tr>
                ) : (
                  shown.map((row, i) => (
                    <TR key={i}>
                      {row.map((v, j) => {
                        const cell = renderCell(v);
                        return (
                          <TD key={j} mono className={cell.muted ? "text-text-subtle" : "max-w-[32rem] truncate"} title={cell.muted ? undefined : cell.text}>
                            {cell.text}
                          </TD>
                        );
                      })}
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}
