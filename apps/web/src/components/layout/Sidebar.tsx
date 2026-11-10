import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useAppSettings, useHealth, useNetworkStatus, useTailscaleStatus } from "../../lib/queries";
import { BrandMark } from "../ui/Brand";
import { StatusDot, type StatusTone } from "../ui/Badge";
import { SimpleTooltip } from "../ui/Tooltip";
import { cn } from "../ui/cn";
import { TUNNEL_PHASES, tunnelPhase } from "../../lib/network";
import { NAV_GROUPS, isNavActive, visibleNavItems } from "./nav";

export function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const { pathname } = useLocation();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center border-b border-border px-4">
        <Link
          to="/"
          onClick={onNavigate}
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          aria-label="LambData dashboard"
        >
          <BrandMark size="md" />
        </Link>
      </div>

      <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {NAV_GROUPS.map((group, gi) => {
          const items = visibleNavItems(group.items, user?.role);
          if (items.length === 0) return null;
          return (
            <div key={gi} className={cn(gi > 0 && "mt-5")}>
              {group.title && <div className="px-3 pb-1.5 text-micro font-medium text-text-subtle">{group.title}</div>}
              <ul className="space-y-px">
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = isNavActive(item, pathname);
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.to === "/"}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "relative flex h-9 items-center gap-2.5 rounded-md px-3 text-body outline-none transition-colors",
                          "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                          active
                            ? "bg-bg-hover font-medium text-text before:absolute before:left-0 before:top-2 before:h-5 before:w-0.5 before:rounded-full before:bg-accent"
                            : "text-text-muted hover:bg-bg-hover/60 hover:text-text",
                        )}
                      >
                        <Icon aria-hidden className={cn("size-4 shrink-0", active ? "text-text" : "text-text-subtle")} />
                        <span className="truncate">{item.label}</span>
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <SystemStatus />
    </div>
  );
}

interface StatusLineProps {
  label: string;
  tone: StatusTone;
  state: string;
  value?: string | null;
  detail?: string | null;
}

function StatusLine({ label, tone, state, value, detail }: StatusLineProps) {
  const line = (
    <li className="flex min-w-0 items-center gap-2 font-mono text-micro">
      <StatusDot tone={tone} />
      <span className="w-14 shrink-0 text-text-subtle">{label}</span>
      <span className={cn("shrink-0", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-text-muted")}>
        {state}
      </span>
      {value && <span className="min-w-0 flex-1 truncate text-right text-text-subtle">{value}</span>}
      {detail && <span className="sr-only">. {detail}</span>}
    </li>
  );
  if (!detail) return line;
  return (
    <SimpleTooltip content={detail} side="right">
      {line}
    </SimpleTooltip>
  );
}

export function unconvertedDetail(count: number, lastError: string | null): string {
  const lead =
    count === 1
      ? "1 old snapshot could not be converted into a checkpoint."
      : `${count} old snapshots could not be converted into checkpoints.`;
  const tail = "LambData retries at each start and leaves the original files untouched. The dashboard lists the databases concerned.";
  return [lead, tail, lastError ? `Last error: ${lastError}` : null].filter(Boolean).join(" ");
}

function SystemStatus() {
  const health = useHealth();
  const settings = useAppSettings();
  const tailscale = useTailscaleStatus();
  const network = useNetworkStatus();

  const mariadb = health.data?.mariadb;
  const port = settings.data?.mariadbPort;
  const mariadbState = !mariadb
    ? { tone: "muted" as const, state: health.isError ? "unknown" : "…" }
    : mariadb.ok
      ? { tone: "success" as const, state: "up" }
      : mariadb.state === "restarting" || mariadb.state === "starting"
        ? { tone: "warn" as const, state: mariadb.state }
        : { tone: "danger" as const, state: "down" };
  const mariadbDetail = [
    mariadb?.error ? `Error: ${mariadb.error}` : null,
    mariadb?.restarts ? `Restarted ${mariadb.restarts} ${mariadb.restarts === 1 ? "time" : "times"} since start` : null,
  ]
    .filter(Boolean)
    .join(". ");

  const ts = tailscale.data;
  const tailnet = !ts
    ? { tone: "muted" as const, state: tailscale.isError ? "unknown" : "…", value: null }
    : ts.running
      ? { tone: "success" as const, state: "up", value: ts.tailnetIp }
      : ts.installed
        ? { tone: "warn" as const, state: "stopped", value: null }
        : { tone: "muted" as const, state: "off", value: null };

  const tunnelStatus = network.data?.cloudflare?.tunnel;
  const phase = tunnelStatus ? tunnelPhase(tunnelStatus) : "off";
  const phaseMeta = TUNNEL_PHASES[phase];
  const tunnel = {
    tone: phaseMeta.tone,
    state: phaseMeta.short,
    value: phase === "connected" && tunnelStatus?.connections != null ? `${tunnelStatus.connections} conn` : null,
    detail:
      phase === "external"
        ? "cloudflared runs outside LambData, so its state is not shown here"
        : phase === "off"
          ? null
          : [phaseMeta.state, tunnelStatus?.lastError].filter(Boolean).join(". "),
  };

  const unconverted = health.data?.checkpoints?.unconvertedSnapshots ?? 0;

  return (
    <div className="shrink-0 border-t border-border px-4 py-3">
      <h2 className="sr-only">System status</h2>
      <ul className="space-y-1.5">
        <StatusLine label="mariadb" tone={mariadbState.tone} state={mariadbState.state} value={port ? `:${port}` : null} detail={mariadbDetail || null} />
        <StatusLine label="tailnet" tone={tailnet.tone} state={tailnet.state} value={tailnet.value} detail={ts?.hostname ? `Hostname ${ts.hostname}` : null} />
        <StatusLine label="tunnel" tone={tunnel.tone} state={tunnel.state} value={tunnel.value} detail={tunnel.detail || null} />
        {unconverted > 0 && (
          <StatusLine
            label="history"
            tone="warn"
            state={`${unconverted} unconverted`}
            detail={unconvertedDetail(unconverted, health.data?.checkpoints?.lastConversionError ?? null)}
          />
        )}
      </ul>
    </div>
  );
}
