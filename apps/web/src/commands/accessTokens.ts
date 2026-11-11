import { ClipboardCheck, KeyRound } from "lucide-react";
import { defineCommands } from "../lib/commands";
import { APPROVALS_PATH, TOKENS_PATH } from "../lib/accessTokens";

export const commands = defineCommands([
  {
    id: "access-tokens:create",
    title: "Create access token",
    group: "Actions",
    icon: KeyRound,
    keywords: ["token", "api key", "agent", "mcp", "claude", "script", "automation", "access"],
    when: (ctx) => ctx.user.role === "admin",
    run: (ctx) => ctx.navigate(`${TOKENS_PATH}?create=`),
  },
  {
    id: "access-tokens:approvals",
    title: "Review agent approvals",
    group: "Navigation",
    icon: ClipboardCheck,
    keywords: ["approve", "deny", "ask first", "agent", "token", "waiting", "pending"],
    when: (ctx) => ctx.user.role === "admin",
    run: (ctx) => ctx.navigate(APPROVALS_PATH),
  },
]);
