import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import type { Database } from "@kilndb/shared";
import { Badge } from "../ui/Badge";
import { Icon } from "../ui/Icon";
import { formatRelativeTime } from "../../lib/format";

export function DatabaseCard({ db }: { db: Database }) {
  return (
    <motion.div layout transition={{ type: "spring", stiffness: 320, damping: 32 }}>
      <Link
        to={`/databases/${db.id}`}
        className="relative block card-surface p-5 transition-all hover:border-accent/40 group"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="size-8 rounded-md bg-bg-subtle border border-border flex items-center justify-center text-text-muted shrink-0 group-hover:border-accent/40 group-hover:text-accent transition-colors">
              <Icon name={db.kind === "mirror" ? "sync_alt" : "database"} size={16} />
            </div>
            <div className="min-w-0">
              <div className="font-medium tracking-tight truncate">{db.displayName}</div>
              <div className="text-micro text-text-muted font-mono truncate">{db.name}</div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {db.kind === "mirror" && <Badge tone="accent">Mirror</Badge>}
            {db.tailscaleExposed && <Badge tone="success">Tailnet</Badge>}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between text-micro text-text-muted">
          <span className="truncate flex items-center gap-1.5">
            <Icon name="person" size={12} className="text-text-subtle" />
            {db.ownerDisplayName ?? "—"}
          </span>
          <span>{formatRelativeTime(db.createdAt)}</span>
        </div>
      </Link>
    </motion.div>
  );
}
