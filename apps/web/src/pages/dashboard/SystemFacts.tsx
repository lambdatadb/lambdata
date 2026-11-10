import type { DashboardSummary } from "@lambdata/shared";
import { StatusDot } from "../../components/ui/Badge";
import { formatBytes } from "../../lib/format";

export function SystemFacts({ summary }: { summary: DashboardSummary | undefined }) {
  if (!summary) return null;
  const { system, functions, sync } = summary;
  const facts: { label: string; value: string }[] = [
    { label: "disk free", value: formatBytes(system.dataDirFreeBytes) },
    { label: "functions", value: `${functions.total} · ${functions.invocations24h} runs 24h` },
  ];
  if (sync.mirrors > 0) facts.push({ label: "mirrors", value: `${sync.ok} ok · ${sync.failing} failing` });
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-micro text-text-subtle">
      <li className="inline-flex items-center gap-1.5">
        <StatusDot tone={system.mariadbOk ? "success" : "danger"} />
        <span>mariadb</span>
        <span className={system.mariadbOk ? "text-text-muted" : "text-danger"}>{system.mariadbOk ? "up" : "down"}</span>
      </li>
      {facts.map((fact) => (
        <li key={fact.label} className="inline-flex items-center gap-1.5">
          <span>{fact.label}</span>
          <span className="text-text-muted">{fact.value}</span>
        </li>
      ))}
    </ul>
  );
}
