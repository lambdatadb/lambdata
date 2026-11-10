# Contributing to LambData

Thanks for helping improve LambData.

## Development setup

You need [Bun](https://bun.sh) and a local MariaDB installation. These programs must be on `PATH` (the older MySQL names work too):

- `mariadbd`
- `mariadb-install-db`
- `mariadb-admin`
- `mariadb`
- `mariadb-dump`
- `mariadb-upgrade` (optional; used when MariaDB is newer than the data folder)

On macOS use `brew install mariadb`; on Debian or Ubuntu use `sudo apt install mariadb-server mariadb-client`.

Install dependencies and start the development servers:

```bash
bun install
bun run dev
```

The API listens on `127.0.0.1:4317` and starts its own MariaDB on `127.0.0.1:3307`. The console runs at <http://localhost:5173> and forwards API requests to the API. Development data goes to `.lambdata/` in the repository (an existing `.kilndb/` is used if `.lambdata/` does not exist).

## Checks

Run these before opening a pull request:

```bash
bun run typecheck
bun run build
(cd apps/api && bun test)
(cd apps/web && bun test)
```

- `bun run typecheck` checks the API, the console and the shared types.
- `bun run build` builds the console.
- The API tests start their own throwaway MariaDB on a free port, in a temporary folder that is removed afterwards. They need `mariadbd`, `mariadb-install-db`, `mariadb` and `mariadb-dump` (or the MySQL names). Without them the tests that need MariaDB are skipped; `LAMBDATA_SKIP_MARIADB_TESTS=1` skips them on purpose.
- On Linux, including inside the LambData image, the tests find processes through `/proc` and need neither `ps` nor `pgrep`; on macOS they use `ps` and `pgrep`. The image already has the MariaDB programs the tests need. One rollback test (`test/checkpoints/round3Fence.test.ts`, the case that kills `mariadbd`) still calls `pkill`, which the image does not include.
- The console tests need nothing extra.

### Screenshots and the visual check

`scripts/visual-test.ts` boots a scratch install with made-up data, signs in as several users and takes screenshots of every page at desktop and phone widths. It reports console errors, unexpected HTTP errors and pages wider than the screen. It needs Google Chrome.

```bash
SHOTS_DIR=/tmp/lambdata-shots bun run scripts/visual-test.ts
```

Useful variables: `VISUAL_ROOT` (scratch folder, default `/tmp/lambdata-visual`), `WIDTHS` (default `1440,390`), `VISUAL_TOURS` (`setup`, `base`, `closeout`), `VISUAL_API_PORT`, `VISUAL_DB_PORT` and `VISUAL_WEB_PORT` (defaults 4901, 4902 and 5186), `CHROME_PATH`. The scratch install never touches Tailscale or cloudflared on your machine.

The README images in `docs/screenshots/` come from this script. Screenshots and sample data use made-up people and names only.

## Pull requests

- Keep each pull request focused on one change.
- Explain the user-facing behaviour and any operational or security impact.
- Document new environment variables and anything an existing install must do on upgrade. Existing installs must keep working: no destructive migrations, no renamed settings keys.
- Never commit `.lambdata/` (or a legacy `.kilndb/`), credentials, database dumps, uploaded objects or local `.env` files.
- Update `CHANGELOG.md` for notable user-facing changes.

## Reporting bugs

Include your operating system or Unraid version, how you run LambData (image tag, or Bun and MariaDB versions), steps to reproduce, and the relevant log lines. Remove passwords, tokens, connection strings and private host names before sharing output.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
