import type { DatabaseCredentials } from "@lambdata/shared";

export function buildConnectionStrings(p: {
  host: string;
  port: number;
  schema: string;
  user: string;
  password: string;
}): DatabaseCredentials {
  const u = encodeURIComponent(p.user);
  const pw = encodeURIComponent(p.password);
  return {
    host: p.host,
    port: p.port,
    schema: p.schema,
    user: p.user,
    password: p.password,
    mysqlCli: `mysql -h ${p.host} -P ${p.port} -u ${p.user} -p ${p.schema}`,
    jdbc: `jdbc:mysql://${p.host}:${p.port}/${p.schema}?user=${u}&password=${pw}`,
    uri: `mysql://${u}:${pw}@${p.host}:${p.port}/${p.schema}`,
  };
}
