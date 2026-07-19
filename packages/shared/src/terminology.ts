import type { ExperienceLevel } from "./types";

export const terminology = {
  novice: {
    connectionsFrom: "Who can connect",
    connectionsFromHelp: "Leave as `%` to allow connections from anywhere",
    jdbc: "Java connection link",
    jdbcHelp: "Paste this into a Java app's database settings",
    mysqlCli: "Command-line connection",
    uri: "Connection link",
    schemaName: "Internal name",
    schemaNameHelp: "We pick this for you based on the display name",
    rotatePassword: "Reset password",
    mirrorSource: "Where to copy from",
    intervalSeconds: "How often to sync (seconds)",
    queryConsole: "Run a query",
    snapshots: "Backups",
    snapshotsHelp: "On-demand and scheduled point-in-time backups",
    danger: "Delete this database",
    tailnetOnly: "Only allow connections from my Tailscale network",
    experienceLabel: "How comfortable are you with SQL?",
    experienceNovice: "I'm new — keep it simple",
    experienceAdvanced: "I know my way around — show me everything",
  },
  advanced: {
    connectionsFrom: "Allowed hosts (MySQL pattern)",
    connectionsFromHelp: "Use `%` for any host, `100.%` for tailnet, or a specific IP/CIDR",
    jdbc: "JDBC connection string",
    jdbcHelp: "Standard JDBC URL with embedded credentials",
    mysqlCli: "mysql CLI invocation",
    uri: "MySQL URI",
    schemaName: "Schema name",
    schemaNameHelp: "Derived from display name, must match [a-z0-9_]",
    rotatePassword: "Rotate password",
    mirrorSource: "Mirror source",
    intervalSeconds: "Sync interval (s)",
    queryConsole: "Query console",
    snapshots: "Snapshots",
    snapshotsHelp: "On-demand and scheduled mysqldump snapshots",
    danger: "Drop database",
    tailnetOnly: "Tailnet only (sets connections_from = 100.%)",
    experienceLabel: "Experience level",
    experienceNovice: "Novice",
    experienceAdvanced: "Advanced",
  },
} as const satisfies Record<ExperienceLevel, Record<string, string>>;

export type TerminologyKey = keyof typeof terminology.advanced;

export function t(level: ExperienceLevel, key: TerminologyKey): string {
  return terminology[level][key];
}
