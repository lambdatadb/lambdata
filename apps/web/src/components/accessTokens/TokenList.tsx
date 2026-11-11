import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import type { AccessToken, AccessTokenPresetInfo } from "@lambdata/shared";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { TBody, TD, TH, THead, TR, Table } from "../ui/Table";
import { cn } from "../ui/cn";
import { formatDate, formatRelativeTime } from "../../lib/format";
import { APPROVALS_PATH, maskedPrefix, orderedPresets, presetLabel, tokenPath, tokenStatus } from "../../lib/accessTokens";
import { PresetLists, TokenStatusBadge, ViaBadge } from "./parts";

export function lastUsedText(token: Pick<AccessToken, "lastUsedAt" | "lastUsedFrom">): string {
  if (!token.lastUsedAt) return "Never used";
  return token.lastUsedFrom ? `${formatRelativeTime(token.lastUsedAt)} from ${token.lastUsedFrom}` : formatRelativeTime(token.lastUsedAt);
}

export function visibleTokens(tokens: AccessToken[], showRevoked: boolean): AccessToken[] {
  return showRevoked ? tokens : tokens.filter((t) => t.status !== "revoked");
}

export function TokenTable({ tokens, presets, allPaused }: { tokens: AccessToken[]; presets: AccessTokenPresetInfo[]; allPaused: boolean }) {
  return (
    <Card flush>
      <Table flush caption="Access tokens">
        <THead>
          <TR>
            <TH>Name</TH>
            <TH className="hidden sm:table-cell">Preset</TH>
            <TH>Status</TH>
            <TH className="hidden lg:table-cell">Last used</TH>
            <TH className="hidden md:table-cell text-right">Databases</TH>
            <TH className="hidden md:table-cell text-right">Waiting</TH>
          </TR>
        </THead>
        <TBody>
          {tokens.map((token) => {
            const quiet = tokenStatus(token, allPaused).quiet;
            return (
              <TR key={token.id} interactive className={cn("relative", quiet && "text-text-subtle")} data-token-row={token.id}>
                <TD className={cn(quiet && "opacity-60")}>
                  <Link to={tokenPath(token.id)} className="stretched-link font-medium text-text outline-none focus-visible:underline">
                    {token.name}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-text-subtle">
                    <span className="font-mono">{maskedPrefix(token.prefix)}</span>
                    <span className="sm:hidden">{presetLabel(token.preset, presets)}</span>
                    <span className="lg:hidden">{lastUsedText(token)}</span>
                  </div>
                </TD>
                <TD className={cn("hidden sm:table-cell", quiet && "opacity-60")}>
                  <Badge variant="outline" size="sm">
                    {presetLabel(token.preset, presets)}
                  </Badge>
                </TD>
                <TD>
                  <TokenStatusBadge token={token} allPaused={allPaused} />
                </TD>
                <TD className={cn("hidden whitespace-nowrap text-label text-text-muted lg:table-cell", quiet && "opacity-60")}>
                  <span className="inline-flex items-center gap-1.5" title={token.lastUsedAt ? formatDate(token.lastUsedAt) : undefined}>
                    {lastUsedText(token)}
                    <ViaBadge via={token.lastUsedVia} />
                  </span>
                </TD>
                <TD className={cn("hidden text-right font-mono text-code md:table-cell", quiet && "opacity-60")}>{token.databasesCreated}</TD>
                <TD className="hidden text-right md:table-cell">
                  {token.pendingApprovals > 0 ? (
                    <Link to={APPROVALS_PATH} className="relative z-10">
                      <Badge variant="info" size="sm">
                        {token.pendingApprovals} waiting
                      </Badge>
                    </Link>
                  ) : (
                    <span className="text-text-subtle">—</span>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </Card>
  );
}

export function TokensEmpty({ presets, onCreate }: { presets: AccessTokenPresetInfo[]; onCreate?: () => void }) {
  return (
    <div className="space-y-4" data-tokens-empty>
      <EmptyState
        title="No access tokens yet"
        description="Create one for each agent or script, choose how much it may do, and revoke it whenever you like. Every request it makes is logged."
        action={
          onCreate ? (
            <Button onClick={onCreate}>
              <Plus aria-hidden /> Create token
            </Button>
          ) : undefined
        }
      />
      {presets.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-3">
          {orderedPresets(presets).map((info) => (
            <Card key={info.preset} className="space-y-3">
              <div className="space-y-1">
                <h3 className="text-body font-semibold text-text">{info.label}</h3>
                <p className="text-label text-text-muted">{info.summary}</p>
              </div>
              <PresetLists info={info} compact className="sm:grid-cols-1" />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
