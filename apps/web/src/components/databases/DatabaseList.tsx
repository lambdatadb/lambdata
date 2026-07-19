import { Link } from "react-router-dom";
import type { Database } from "@kilndb/shared";
import { Badge } from "../ui/Badge";
import { Icon } from "../ui/Icon";
import { Table, TBody, TD, TH, THead, TR } from "../ui/Table";
import { formatRelativeTime } from "../../lib/format";

export function DatabaseList({ databases }: { databases: Database[] }) {
  return (
    <Table>
      <THead>
        <tr>
          <TH>Name</TH>
          <TH>Schema</TH>
          <TH>Type</TH>
          <TH>Owner</TH>
          <TH>Created</TH>
          <TH />
        </tr>
      </THead>
      <TBody>
        {databases.map((d) => (
          <TR key={d.id} className="cursor-pointer">
            <TD>
              <Link to={`/databases/${d.id}`} className="flex items-center gap-2.5 font-medium">
                <div className="size-7 rounded-md bg-bg-subtle border border-border flex items-center justify-center text-text-muted">
                  <Icon name={d.kind === "mirror" ? "sync_alt" : "database"} size={14} />
                </div>
                {d.displayName}
              </Link>
            </TD>
            <TD className="font-mono text-label text-text-muted">{d.name}</TD>
            <TD>
              <div className="flex items-center gap-1">
                {d.kind === "mirror" ? (
                  <Badge tone="accent">Mirror</Badge>
                ) : (
                  <Badge tone="muted">Standard</Badge>
                )}
                {d.tailscaleExposed && <Badge tone="success">Tailnet</Badge>}
              </div>
            </TD>
            <TD className="text-text-muted">{d.ownerDisplayName ?? "—"}</TD>
            <TD className="text-text-muted">{formatRelativeTime(d.createdAt)}</TD>
            <TD className="text-right">
              <Icon name="chevron_right" size={16} className="text-text-subtle" />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
