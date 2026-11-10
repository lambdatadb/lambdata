import { BellPlus } from "lucide-react";
import { defineCommands } from "../lib/commands";

export const commands = defineCommands([
  {
    id: "notifications:add",
    title: "Add notification destination",
    group: "Actions",
    icon: BellPlus,
    keywords: ["notifications", "notify", "alert", "webhook", "discord", "slack", "mattermost", "ntfy", "push", "phone", "message"],
    when: (ctx) => ctx.user.role === "admin",
    run: (ctx) => ctx.navigate("/notifications?add="),
  },
]);
