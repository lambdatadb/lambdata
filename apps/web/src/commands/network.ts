import { ShieldCheck } from "lucide-react";
import { defineCommands } from "../lib/commands";

export const commands = defineCommands([
  {
    id: "network:open",
    title: "Open network access",
    group: "Navigation",
    icon: ShieldCheck,
    keywords: ["network", "access", "policy", "cloudflare", "tunnel", "tailscale", "serve", "lock", "lan", "firewall"],
    run: (ctx) => ctx.navigate("/network"),
  },
]);
