# Contributing to KilnDB

Thanks for helping improve KilnDB.

## Development setup

You need Bun and a local MariaDB installation. The following executables must be available on `PATH`:

- `mariadbd`
- `mariadb-install-db`
- `mariadb-admin`
- `mariadb`
- `mariadb-dump`

Install dependencies and start the development services:

```bash
bun install
bun run dev
```

The web console runs at <http://localhost:5173> and proxies API requests to <http://localhost:4317>.

## Before opening a pull request

Run the checks used by CI:

```bash
bun run typecheck
bun run build
```

For user-interface changes, exercise the affected routes at desktop and narrow viewport widths. Include updated screenshots when a visible workflow changes substantially.

## Pull requests

- Keep each pull request focused on one change.
- Explain the user-facing behavior and any operational or security impact.
- Document new environment variables and migration requirements.
- Never commit `.kilndb/`, credentials, database dumps, uploaded objects, or local `.env` files.
- Update `CHANGELOG.md` for notable user-facing changes.

## Reporting bugs

Include your operating system, Bun version, MariaDB version, reproduction steps, and relevant sanitized logs. Remove passwords, tokens, connection strings, and private hostnames before sharing output.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
