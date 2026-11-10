const MAX_MESSAGE_LENGTH = 2000;

const REDACTIONS: [RegExp, string][] = [
  [/(:\/\/[^:/\s@]+:)[^@\s]+@/g, "$1***@"],
  [/(IDENTIFIED\s+(?:BY|VIA\s+\w+\s+USING)\s+)('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi, "$1'***'"],
  [
    /\b((?:password|passwd|pwd|secret|token|auth[_-]?key|api[_-]?key|MYSQL_PWD|PGPASSWORD)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1***",
  ],
];

const PASSWORD_USE_NOTE = /\s*\(using password: (?:YES|NO|\*\*\*)\)?/gi;

export function redactSecrets(text: string): string {
  let out = text.replace(PASSWORD_USE_NOTE, "");
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export function sanitizeErrorMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) raw = err.message;
  else if (typeof err === "string") raw = err;
  else {
    try {
      raw = JSON.stringify(err) ?? String(err);
    } catch {
      raw = String(err);
    }
  }
  const lines = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s.+(\(.*\)|:\d+:\d+)\s*$/.test(line));
  const message = redactSecrets(lines.join("\n").trim());
  if (!message) return "job failed";
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
}
