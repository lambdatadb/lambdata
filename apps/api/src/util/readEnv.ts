import { LEGACY } from "./legacy";

export const ENV_PREFIX = "LAMBDATA_";

export function readEnv(name: string): string | undefined {
  return process.env[`${ENV_PREFIX}${name}`] ?? process.env[`${LEGACY.envPrefix}${name}`];
}
