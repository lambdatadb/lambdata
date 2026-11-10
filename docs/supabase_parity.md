# Supabase parity plan

LambData is intentionally not a Supabase clone: it keeps the current self-hosted MariaDB provisioning, checkpoints, mirror sync, network access controls, RBAC, audit log, and Bun-native single-repo deployment model. The parity goal is to bring over the high-value product surfaces users expect from Supabase while staying simple to self-host.

## Sources

- Supabase feature catalog: <https://supabase.com/docs/guides/getting-started/features>
- Supabase Data REST API: <https://supabase.com/docs/guides/api>
- Supabase auto-generated REST API: <https://supabase.com/features/auto-generated-rest-api>
- Supabase Row Level Security: <https://supabase.com/docs/guides/database/postgres/row-level-security>
- Supabase file storage: <https://supabase.com/features/file-storage>
- Supabase Realtime: <https://supabase.com/docs/guides/realtime>
- Supabase Edge Functions: <https://supabase.com/docs/guides/functions>
- Supabase self-hosting: <https://supabase.com/docs/guides/self-hosting>
- Supabase self-hosted functions: <https://supabase.com/docs/guides/self-hosting/self-hosted-functions>

## Current coverage

| Supabase-like area | LambData state |
|---|---|
| Database console | MariaDB provisioning, users, generated credentials, query console, metrics, table breakdowns |
| Generated REST API | App Auth-protected CRUD endpoints over managed MariaDB tables with select/order/pagination/filter query params, method gates, and owner-column policies |
| Backups | Commit-style checkpoints (manual and scheduled) with diff, download and rollback; databases created from SQLite files or SQL dumps |
| Storage | Local filesystem buckets, object upload/open/delete, private/public read URLs, RBAC, audit logging |
| Auth | App users, email/password signup/token endpoints, bearer JWTs, signup toggle, admin user management; console operator auth remains separate |
| Realtime | App Auth-protected WebSocket channels, REST broadcast, presence sync, and Data API mutation events |
| Edge Functions | File-backed TypeScript functions under `<data-dir>/functions`, direct `/functions/v1/*` routing, per-function JWT verification, encrypted secrets, isolated subprocess invocation, and invocation logs |
| Generated API docs | Console-authenticated schema reflection and generated OpenAPI 3.1 output for Data API tables |
| Row-level policies | MariaDB-oriented Data API policy layer: per-table method gates plus optional App Auth owner-column filtering/checks |
| Logs/analytics | Audit log and database metrics only |
| Self-hosting | Single Bun stack with local data directory and no Docker requirement |

## Next build order

1. **Storage hardening**: object metadata search, folder UI, signed URLs, upload limits, S3-compatible API, resumable uploads, and optional external S3-compatible backend.
2. **Auth hardening**: refresh tokens, password recovery, magic links, OAuth hooks, CAPTCHA, email/SMS delivery, MFA, and policy primitives.
3. **Data API hardening**: richer policy expressions, relationship embedding, RPC/functions, richer PostgREST operator coverage, and generated client SDKs.
4. **Realtime hardening**: MariaDB binlog tailing, row-level subscription policies, persisted/replayable messages, storage object events, and backpressure/rate limits.
5. **Functions hardening**: CLI deploy/import flow, dependency bundling, streaming log tails, background jobs, resource limits, and stronger sandboxing.
6. **Postgres compatibility track**: optional managed Postgres engine for RLS, pgvector, Vault-like secrets, and closer Supabase feature parity.
7. **Operations parity**: logs explorer, alerting, backup policies, PITR-equivalent design where supported, branch/preview workflows, and multi-host management.

## Self-hosting stance

Supabase's own self-hosting docs call out that self-hosted Supabase behaves like a single project and does not include some managed-platform features such as branching, managed backups/PITR, advanced metrics beyond logs, analytics and vector buckets, ETL, or the platform management API. LambData should be explicit when it chooses a self-host-first version of a feature rather than matching the managed Supabase platform one-for-one.
