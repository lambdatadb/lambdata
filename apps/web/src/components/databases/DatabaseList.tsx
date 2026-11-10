import { Link } from "react-router-dom";
import { ArrowLeftRight, ChevronRight, Database as DatabaseIcon } from "lucide-react";
import type { Database } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "../ui/Table";
import { RepoBadge } from "../checkpoints/RepoBadge";
import { databasePath } from "../../lib/commands";
import { formatRelativeTime } from "../../lib/format";

export function DatabaseList({ databases }: { databases: Database[] }) {
  return (
    <Table caption="Databases">
      <THead>
        <TR>
          <TH>Name</TH>
          <TH>Type</TH>
          <TH className="hidden md:table-cell">Allowed hosts</TH>
          <TH className="hidden lg:table-cell">Owner</TH>
          <TH className="hidden sm:table-cell">Created</TH>
          <TH className="w-10">
            <span className="sr-only">Open</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {databases.map((db) => {
          const Icon = db.kind === "mirror" ? ArrowLeftRight : DatabaseIcon;
          return (
            <TR key={db.id} interactive>
              <TD>
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-bg-raised text-text-muted">
                    <Icon aria-hidden className="size-3.5" />
                  </div>
                  <div className="min-w-0">
                    <Link
                      to={databasePath(db.id)}
                      className="stretched-link block truncate font-medium text-text outline-none focus-visible:underline focus-visible:decoration-accent focus-visible:underline-offset-4"
                    >
                      {db.displayName}
                    </Link>
                    <div className="truncate font-mono text-micro text-text-subtle">{db.name}</div>
                  </div>
                </div>
              </TD>
              <TD>
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant={db.kind === "mirror" ? "info" : "muted"} size="sm">
                    {db.kind}
                  </Badge>
                  <RepoBadge db={db} />
                  {db.tailscaleExposed && (
                    <Badge variant="muted" size="sm">
                      tailnet
                    </Badge>
                  )}
                  {db.status !== "active" && (
                    <Badge variant="warn" size="sm" dot>
                      {db.status}
                    </Badge>
                  )}
                </div>
              </TD>
              <TD mono className="hidden text-text-muted md:table-cell">
                {db.connectionsFrom}
              </TD>
              <TD className="hidden text-text-muted lg:table-cell">{db.ownerDisplayName ?? "—"}</TD>
              <TD className="hidden whitespace-nowrap text-text-muted sm:table-cell">{formatRelativeTime(db.createdAt)}</TD>
              <TD className="text-right">
                <ChevronRight aria-hidden className="ml-auto size-4 text-text-subtle" />
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
