export const functionsListKey = ["functions", "list"] as const;

export function functionSourceKey(name: string) {
  return ["functions", "detail", name, "source"] as const;
}

export function functionLogsKey(name: string) {
  return ["functions", "detail", name, "logs"] as const;
}

export const functionSecretsKey = ["function-secrets"] as const;

export const FUNCTION_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
