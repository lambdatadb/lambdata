const TEMP_ACCOUNT_PHRASE = / (?:to|for) user '?ld_(?:scp|imp)_[A-Za-z0-9]{12}'?@'?[^'\s]*'?/g;
const TEMP_ACCOUNT = /'?ld_(?:scp|imp)_[A-Za-z0-9]{12}'?(?:@'?[^'\s,)]*'?)?/g;
const MANAGED = String.raw`_ld_(stage|trash)_[A-Za-z0-9]{8}_[A-Za-z0-9_]*`;
const MANAGED_QUALIFIED_BACKTICK = new RegExp(String.raw`\`${MANAGED}\`\.`, "g");
const MANAGED_QUALIFIED_QUOTED = new RegExp(String.raw`'${MANAGED}\.`, "g");
const MANAGED_QUALIFIED_BARE = new RegExp(String.raw`\b${MANAGED}\.`, "g");
const MANAGED_ALONE = new RegExp(String.raw`\`?\b${MANAGED}\b\`?`, "g");
const PARKED_VIEW = /`?\b_ld_oldview_[a-z0-9]{8}_\d+\b`?/g;
const PRIVILEGE = /\b(SELECT|INSERT|UPDATE|DELETE|EXECUTE|ALTER ROUTINE|CREATE VIEW|SHOW VIEW|TRIGGER|REFERENCES|ANY)\b[^.]*?\bcommand denied\b/i;
const PRIVILEGE_ERRNO = /\bERROR (?:1044|1142|1143|1370)\b|\bcommand denied\b|\bAccess denied\b/i;
const FOR_TABLE = /\bfor table ((?:`(?:[^`]|``)+`\.)?`(?:[^`]|``)+`)/;
const FOR_COLUMN = /\bfor column '([^']+)' in table '([^']+)'/;
const FOR_ROUTINE = /\bfor routine '([^']+)'/;
const NO_SUCH_TABLE = /Table '([^']+)' doesn't exist/;
const INVALID_VIEW = /\breferences invalid table\(s\) or column\(s\) or function\(s\)/i;
const LOCK_WAIT = /\bLock wait timeout exceeded\b/i;

export function sanitizeMariaDbMessage(text: string): string {
  return text
    .replace(TEMP_ACCOUNT_PHRASE, "")
    .replace(TEMP_ACCOUNT, "a temporary LambData account")
    .replace(MANAGED_QUALIFIED_BACKTICK, "")
    .replace(MANAGED_QUALIFIED_QUOTED, "'")
    .replace(MANAGED_QUALIFIED_BARE, "")
    .replace(MANAGED_ALONE, (_m, kind: string) => (kind === "stage" ? "the staging copy" : "the set-aside copy of the old tables"))
    .replace(PARKED_VIEW, "the old view");
}

function quotedPair(text: string): string {
  const parts = text.split(".");
  return parts.map((p) => "`" + p.replace(/^`|`$/g, "") + "`").join(".");
}

export function explainMariaDbFailure(rawText: string, kind?: string): string | null {
  const text = sanitizeMariaDbMessage(rawText);
  if (PRIVILEGE_ERRNO.test(text)) {
    const verb = PRIVILEGE.exec(text)?.[1]?.toUpperCase() ?? "";
    const action =
      verb === "SELECT" || (kind === "VIEW" && !["EXECUTE"].includes(verb))
        ? "reads"
        : verb === "EXECUTE"
          ? "calls"
          : ["INSERT", "UPDATE", "DELETE"].includes(verb)
            ? "writes to"
            : "uses";
    const table = FOR_TABLE.exec(text)?.[1];
    if (table) return `${action} ${table}, which is outside this database`;
    const column = FOR_COLUMN.exec(text);
    if (column) return `${action} ${quotedPair(column[2]!)}, which is outside this database`;
    const routine = FOR_ROUTINE.exec(text)?.[1];
    if (routine) return `calls ${quotedPair(routine)}, which is outside this database`;
    return "uses something outside this database, which its account may not read";
  }
  const missing = NO_SUCH_TABLE.exec(text)?.[1];
  if (missing) return `reads ${quotedPair(missing)}, which does not exist`;
  if (INVALID_VIEW.test(text)) return "refers to a table, column or function that does not exist";
  if (LOCK_WAIT.test(text)) return "another session kept the table it belongs to in use until the wait ran out";
  return null;
}

export function sanitizeError<T>(err: T): T {
  if (err instanceof Error) {
    try {
      err.message = sanitizeMariaDbMessage(err.message);
    } catch {
      return err;
    }
  }
  return err;
}
