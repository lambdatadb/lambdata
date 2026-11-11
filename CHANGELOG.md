# Changelog

All notable changes to LambData (formerly KilnDB).

## Unreleased: database connections, access tokens, row changes

### Upgrading

- The four new metadata migrations (0017 to 0020) only add tables and columns; no data is rewritten or removed. There are no access tokens, no outside database connections that were not there before, and no new notifications until an admin sets them up.
- `LAMBDATA_MARIADB_BIND` keeps working and always wins over the new switch on the Network page. An install that sets it to `0.0.0.0` keeps accepting outside database connections. An install without it keeps MariaDB on `127.0.0.1`, as before, until an admin turns the switch on.
- Two things start on their own. Sync results and **Sync finished** messages now include row changes; all comparing work is limited to 30 seconds per sync by default, and tables not reached by then are reported as not compared. And LambData starts recording refused MariaDB sign-ins: on the Docker image it reads MariaDB's error log; where MariaDB has the `server_audit` plugin, MariaDB is started with it for connection events only (set `LAMBDATA_CONNECTION_AUDIT=0` to prevent that).

### Database connections

- The console no longer shows a database address that cannot work. Wherever it shows an address or connection string, it says when database clients on other machines cannot connect yet (MariaDB listening inside the container only) and links to the switch. On an install outside a container it shows `127.0.0.1` and says the database is reachable from that machine only.
- **Allow database clients on other machines**, a switch in the new **Database connections** card on the Network page, does what setting `LAMBDATA_MARIADB_BIND=0.0.0.0` did: it restarts MariaDB listening on every address. It is refused while a job is running or a database is closed for an operation, and if MariaDB does not start on the new address LambData goes back to the old one. The port still has to be published in Docker. When `LAMBDATA_MARIADB_BIND` is set, the switch shows its value and cannot be changed.
- **Rejected connections**: sign-ins MariaDB refused are listed on the database's Overview tab, with the address MariaDB saw, how often, and why (address not allowed, wrong password, closed for an operation). **Allow this address** replaces the database's "connections from" with that address after a confirmation. Behind Docker or a VPN that address can differ from the client's own. The Network page lists refused sign-ins for accounts no database uses. Kept 30 days, at most 2,000 groups; passwords are never recorded.
- Refusals are read from MariaDB's `server_audit` plugin when it is available, otherwise from MariaDB's error log (the case on the Docker image, where "closed for an operation" cannot be told apart). `LAMBDATA_CONNECTION_AUDIT=0` never loads the plugin. `LAMBDATA_IN_CONTAINER` overrides container detection.
- See [Network access](docs/network.md#database-connections).

### Access tokens and agents

- **Access tokens** for AI agents and scripts, created by admins on the new **Access tokens** page, with three presets: Read only, Builder (creates its own databases and manages only those) and Admin. The secret is shown once and only its hash is stored. See [Agents](docs/agents.md) and [SECURITY.md](SECURITY.md#access-tokens).
- A built-in **MCP endpoint** at `/mcp` for Claude Code and other MCP clients, and an API description at `/api/openapi.json` for the part of the management API tokens can reach.
- Default deny: a token reaches only what is on its preset's list, never users, settings, network, notifications, storage, functions, App Auth, Realtime, checkpoint downloads or other tokens. Databases outside its reach answer as if they did not exist.
- Tokens work from this machine, the local network and the tailnet by default; Cloudflare is opt-in per token. Limits per token: requests per minute (120), databases a Builder may create (10), expiry, chosen databases only, whether it may see database passwords. **Pause all tokens** stops every token at once.
- **Ask first** (on by default for Admin): deleting a database, rolling back, deleting a checkpoint, an import that replaces data, and SQL starting with `DROP` or `TRUNCATE` wait for an admin's approval on the **Approvals** page. An approval lets one identical request through within 60 minutes.
- **Undo points**: before a token first changes data with SQL on a versioned database, LambData saves a checkpoint "Before changes by <token>", reused while the token keeps working there (until 30 minutes without changes). It counts as a safety checkpoint. See [Checkpoints](docs/checkpoints.md#undo-points-for-access-tokens).
- Each token's page lists its activity: what it did, on which database, the outcome, the agent's note, the address, and whether it came through MCP. The Activity page, notifications and database pages name tokens as such.
- `POST /api/databases` accepts `ensure: true` for safe retries: it returns a database the caller itself created earlier with that name instead of creating a second one. If a database with that name was created by someone else, the answer is HTTP 409 naming who created it and its id; a Builder token that cannot see that database gets a new one of its own.
- SQL results for tokens are capped at 500 rows by default (at most 5,000) and say when rows were cut.

### Row changes

- Mirror syncs measure what they changed: rows added, removed and changed per table, compared row by row for InnoDB tables with a usable key, and rows before and after for the rest. The Sync tab, the job result and the **Sync finished** message show it ("3 tables changed: 1,204 rows added, 12 removed, 40 changed", then up to five tables), or "Nothing changed." The comparison runs before the new copy is swapped in, closes nothing, and never fails a sync. `LAMBDATA_SYNC_DIFF_MAX_ROWS` (2,000,000 rows per table for row by row) and `LAMBDATA_SYNC_DIFF_MAX_SECONDS` (30 seconds for all comparing per sync) bound it; tables the time limit did not reach are reported as not compared (`tablesNotCompared`).
- **Checkpoint made** and **Automatic checkpoint** messages say what changed since the previous checkpoint.
- **Skip sync messages when nothing changed**, per destination: no message for a sync that changed nothing or an automatic checkpoint that saved nothing new. Failures and recoveries still arrive.
- New notification group **Access tokens** with **Access token created**, **Access token revoked** (both off by default) and **Approval needed** (on by default).
- Webhook payloads of `sync.finished` carry a new top-level `changes` field with up to 20 changed tables, and the totals in `data`. The payload version stays 1. See [Notifications](docs/notifications.md#row-changes-in-the-payload).

## Unreleased: LambData

KilnDB is now LambData. The image is `ghcr.io/lambdatadb/lambdata` and the repository is `github.com/lambdatadb/lambdata`.

### Upgrading from KilnDB

Read [Upgrading from KilnDB](docs/upgrading.md) before you switch. In short:

- Back up the data folder first (stop the container, copy the folder or volume). Going back to KilnDB afterwards signs everyone out and invalidates App Auth tokens, because signing secrets are now stored encrypted.
- The KilnDB image is no longer published. An existing KilnDB container keeps running the last KilnDB version until you change its image to `ghcr.io/lambdatadb/lambdata:latest` yourself. The data path and the `KILNDB_*` variables can stay as they are.
- Every database starts with its Data API closed: tables without a policy refuse app requests. The Data API page shows what was refused and lets you add policies or open a database again. App Auth sign-up is off unless an admin had switched it on; turn it on from the Auth page.
- Old snapshots become checkpoints at the first start. The original files are kept for 30 days in `snapshots/converted/`. A snapshot that cannot be converted is listed in that database's History with the reason and retried at each start.
- Browser tabs left open across the upgrade need a reload.
- Behind a proxy or tunnel that rewrites the `Host` header, list the public address under Network, Public URLs, so the console's requests are accepted.
- Docker Compose: the new `docker-compose.yml` keeps the old volume name `kilndb_kilndb-data`, so your data is found. Stop the old `kilndb` container first.
- Give the container at least 30 seconds to stop (`stop_grace_period` in Compose, `--stop-timeout` on Docker and Unraid).

### Added

- **Checkpoints**, replacing snapshots. A checkpoint saves a database's tables, views, triggers, routines, events and default character set without stopping it; tables that did not change are shared between checkpoints. History shows a commit graph with branches, the working copy's changes since HEAD, a diff against the previous checkpoint or the live database, messages, pinning, downloads as `.sql.gz`, and an option to verify a checkpoint by loading it once. See [Checkpoints](docs/checkpoints.md).
- **Automatic checkpoints** for every database (daily, keep 7 by default), skipped when nothing changed. Scheduled, sync and safety checkpoints each keep their own count.
- **Versioned databases**: any database can be marked versioned to show clean or changed on its card, and versioned mirrors can take their automatic checkpoint right after a sync.
- **Rollback** that loads the checkpoint into a scratch copy, checks every table's row count and checksum against what was recorded, tries each view, trigger and routine, then saves a safety checkpoint, checks under table locks that nothing else changed the database since (retaking the safety checkpoint up to 3 times, then refusing with nothing changed), and swaps the tables in. The database's own account (every host entry of it) is closed and its scheduled events are paused only for those last steps, at most `LAMBDATA_FENCE_MAX_MINUTES` (120 by default). A table an application creates under the same name during the swap is moved to a kept `_ld_quarantine_*` schema instead of being lost. A rollback that would lose views, triggers or routines (for example ones that read another database) is refused, with **Roll back anyway** to force it; the result is then marked "finished with errors".
- **Create a database from a file**: a SQLite database (any `.db`, `.sqlite` or `.sqlite3`, such as a Garry's Mod `sv.db`) or a MySQL/MariaDB dump (`.sql`, `.sql.gz`). A plan shows every table and the type chosen for each column before anything is created. 64-bit integers such as SteamID64 values are kept exact. Files can also replace an existing database's contents, after a safety checkpoint. See [Create a database from a file](docs/importing.md).
- **Network page** with three ways in (local network, Tailscale, Cloudflare Tunnel), an access policy for each, Cloudflare Access verification, a managed `cloudflared` (included in the image), trusted proxies, public URLs, lockout protection and `LAMBDATA_ACCESS_POLICY=open` for recovery. See [Network access](docs/network.md).
- **First-run setup token**, printed in the container log, required before the first admin can be created from anywhere but the server itself.
- **Limits** on free disk space (`LAMBDATA_DISK_FLOOR`), import uploads per user, and admin ceilings for automatic checkpoint retention and interval. See [SECURITY.md](SECURITY.md#limits).
- **Background jobs** for checkpoints, rollbacks, syncs and imports, with progress in a jobs indicator in the top bar and a third result state, "finished with errors", that lists the affected objects.
- **Notifications** (optional, off until an admin adds a destination): messages to Discord, Slack or Mattermost, ntfy, or a generic webhook signed with HMAC-SHA256 when a database is created or deleted, a checkpoint is made, a rollback finishes or is refused, a mirror fails or recovers, an import finishes, the Data API or network policy changes, MariaDB goes down, the disk runs low, and more. Each destination picks its events and databases, uses the LambData icon unless given another, and shows its health and recent deliveries. At most 20 messages a minute per destination, then one summary; failed messages are retried for over an hour. See [Notifications](docs/notifications.md).
- **One automatic checkpoint per period** per database ("One a day" by default), however many syncs run; the schedule and scheduled syncs share that one slot. On a versioned mirror with "Take the automatic checkpoint right after a sync" on, the sync takes it so it matches a finished sync, and the schedule takes over when the sync is off or failing. **Sync now** never uses it and can add an additional checkpoint, which is kept until deleted (asks each time by default, with "Don't ask again for this database"). "How many to keep" counts scheduled and sync checkpoints together; safety checkpoints keep their own count. A mirror's local changes are found by comparing with a fingerprint of what the last sync delivered, so no checkpoint per sync is needed. Between checkpoints a mirror reads "Synced data, not yet in a checkpoint". Anyone already on LambData: mirrors that recorded a checkpoint after every sync now record one per period; existing checkpoints are kept and trimmed to "how many to keep" as new automatic ones arrive.
- **Settings tab** on each database with versioning, the sync schedule, the checkpoint interval, how many to keep, the after-sync switch and the manual-sync choice, summed up in an "At a glance" sentence. History and Sync show a summary and link there.
- **Show in dashboard vitals** switch per database.
- Command palette (`/` or Cmd/Ctrl+K) with navigation and actions such as creating a checkpoint or importing a file.
- Sign out everywhere, from Settings.
- MariaDB's own upgrade step (`mariadb-upgrade`) runs automatically when the server is newer than the data folder.

### Changed

- Renamed the product from KilnDB to LambData: `LAMBDATA_*` environment variables (every `KILNDB_*` name still works), the `~/.lambdata` pointer (falling back to `~/.kilndb`), the `lambdata_session` cookie (the old cookie is still read), `x-lambdata-*` headers (the old function log header is still sent), the `lambdata` container user (same uid and gid 999), Compose and Unraid files, and the `ld_` prefix for new database users. Existing `kdb_` users are unchanged. The internal MariaDB admin account moves from `kilndb_root` to `lambdata_root` automatically. An install that already used App Auth keeps issuing tokens with its old issuer.
- New console design: dark ink and lime by default, with the ember, tide, grove and orchid themes still selectable. The pages were rebuilt on a new set of components.
- The Data API is closed by default: a table without a policy refuses app requests unless its database is opened.
- App Auth sign-up is off by default.
- Function source and invocation logs are visible to admins only.
- Viewers are read-only everywhere and their SQL editor runs through a read-only MariaDB account.
- Changing your own password requires the current one and signs out your other sessions.
- A database's one-time password can only be closed with "I've saved it", and rotating a password asks for confirmation first.
- Mirror syncs load through a scratch copy with access to that copy only. A sync of a versioned mirror that nobody changed locally no longer closes any connection; its readers wait for one checksum pass instead (in our tests about 50 ms for a 34 MB mirror, about 1.5 s for 560 MB), and a write that lands during the check is saved in a pre-sync checkpoint.
- Views, routines, triggers and events of a mirror are moved onto the mirror's own account at start, so mirrors made by KilnDB, including mirrors of another local database, work before their first sync.
- The Docker image is pinned to an exact Bun release on Debian 13 with MariaDB 11.8, the same MariaDB version the last KilnDB image ran. The application files are owned by root and read-only to the runtime user, and MariaDB runs with file import and export closed off.
- The container health check fails while MariaDB is down, and answers within 2 seconds (`"mariadb":"not-responding"`) when MariaDB is frozen.
- Data API inserts and updates are refused below the free-space floor.
- A checkpoint that loses its connection or makes no progress for 120 seconds fails instead of hanging. A table dropped while a checkpoint is taken is recorded as a limitation instead of failing it. ENUM, SET and ascii columns with unusual values come back exactly. A change to only a table's AUTO_INCREMENT counter shows as a change.
- An import that creates a database and is interrupted by a restart is emptied at the next start. A rollback, sync or import that had finished its swap just before LambData stopped reads as finished after the restart. Rollbacks and replacing imports say how many of the database's own connections they closed, and a refused rollback leaves no safety checkpoint behind.
- At start, when the data folder belongs to another user, the container now changes only the files that do not already belong to the runtime user and logs how many it changed. `LAMBDATA_FIX_DATA_OWNERSHIP=never` makes it stop with instructions instead.
- `docker-compose.yml` keeps the volume name of the KilnDB file and sets `stop_grace_period: 45s`. The Unraid template sets `--stop-timeout=45`.
- Session cookies become `Secure` on their own whenever the console is used over HTTPS; `LAMBDATA_COOKIE_SECURE=1` is no longer needed for that.

### Security

- Console requests that change something must be JSON and come from an address of this server (protection against cross-site requests). The session cookie is `SameSite=Strict`.
- Forwarded headers, including `X-Forwarded-Host`, are believed only from loopback and trusted proxies, so they can never make a request more trusted.
- A request from the server itself that names another host (`Host`, `Origin` or `Referer`) counts as the local network and needs the setup token. `LAMBDATA_TRUST_LOOPBACK=0` treats no connection from the server itself as local, for installs behind a forwarder on the same machine; the Network page warns when it sees such forwarding.
- The Network page warns when Cloudflare Access is required for the console but the app-facing APIs are not restricted.
- Sign-in takes the same time whether or not the email exists, for the console and App Auth.
- Setup refuses to overwrite a folder that already holds an install; it adopts it instead.
- Storage objects are served with `nosniff` and a sandboxing Content Security Policy; only images and plain text open inline.
- Function subprocesses no longer inherit the API's environment.

### Removed

- Snapshots and the snapshot API (`/api/databases/:id/snapshots`). Checkpoints replace them; existing snapshots are converted.
- The KilnDB image name: it is frozen at the last KilnDB version.

## KilnDB, July 2026

- Added an installable Unraid Docker template backed by the published image, including persistent native Tailscale state under `/data/.tailscale_state`.
- Made Tailscale controls read-only when Unraid's container hook manages Tailscale.
- Documented Unraid installation, per-container Tailscale authentication, Serve, updates and backups.
- Renamed the project and all public and runtime names to KilnDB, including package scopes, environment variables, persistent paths, cookies, generated API metadata, Docker files and database-user prefixes.
- Replaced the previous box mark with a database-stack bottle-kiln mark and a warm charcoal and kiln-red look.
- Reworked the README around Docker installation, features, operations, backups and security boundaries.
- Added Docker Compose and Docker run quick starts with persistence, logs, restart and upgrade commands.
- Added contribution and private security-reporting guidance.

## Supabase-inspired visual refresh, May 24, 2026

### Added
- Added generated Data API documentation with live schema reflection and OpenAPI 3.1 export for managed MariaDB tables.
- Added Data API policy controls with per-table method gates and optional App Auth owner-column filtering/checks.
- Added a self-hosted Functions slice with file-backed TypeScript functions, direct `/functions/v1/*` routing, per-function JWT verification, encrypted secrets, isolated invocation, logs, and a console page.
- Added a self-hosted Realtime slice with App Auth-protected WebSocket channels, REST broadcast, presence sync, and Data API table-change events.
- Added a Realtime console page with connection/channel status and copyable WebSocket/REST examples.
- Added a transparent KilnDB mark and wired it into the app favicon, sidebar brand, setup flow, and login screen.

### Changed
- Shifted the console shell to a Supabase-like dark charcoal and kiln red visual system.
- Reworked the sidebar, topbar, cards, buttons, badges, forms, and chart accents for flatter surfaces, tighter borders, and less decorative chrome.
- Removed the old neon cyan/blue/purple styling, dotted background panels, corner ticks, glow borders, and drop-shadow accents from active UI surfaces.

### Verification
- `bun run typecheck`
- `bun run build`
- `bun run scripts/visual-test.ts`

## Storage parity slice, May 24, 2026

### Added
- Added generated REST Data API routes under `/api/data/:databaseName/:tableName`.
- Added App Auth bearer-token protection for generated Data API calls.
- Added `GET`, `POST`, `PATCH`, and `DELETE` table operations with select, order, pagination, and PostgREST-style filters.
- Added a Data API console page listing reflected tables and copyable request examples.
- Added app-facing Auth with application users separate from KilnDB console operators.
- Added public App Auth endpoints for signup, token issuance, and bearer-token current-user lookup.
- Added App Auth admin endpoints for settings, app user CRUD, disable/delete, and audit events.
- Added a Supabase-style Auth console page with app user stats, settings, endpoint cards, and sidebar navigation.
- Added local filesystem-backed Storage buckets under the selected KilnDB data directory.
- Added Storage metadata tables, shared Storage types, and API routes for bucket CRUD, object upload/open/delete, and unauthenticated reads for public buckets.
- Added a Supabase-style Storage console page with bucket stats, object tables, upload flow, and private/public bucket state.
- Added Storage navigation and routing in the web app.
- Added Supabase parity planning documentation and updated the README feature/API/security/data-directory sections.

### Verification
- `bun run typecheck`

## Redesign and developer experience overhaul, May 20, 2026

### Added
- **Global Cluster Health Map**: Linked the "View health map" button to an interactive modal showing real-time health percentage, dynamic active/degraded cluster grids, exposure network classification (Tailscale vs. LAN vs. Local), database kinds, storage sizes, and live connection counts.
- **Spotlight-Style Search**:
  - Pressing `/` focuses the topbar search bar.
  - Searches live databases using cached API values.
  - Includes a dropdown with status badges and instant navigation to the database details.
- **Console Hotkeys**: Added `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows/Linux) query execution shortcut directly in the SQL Query editor.
- **Audit Logging API**: Integrated backend routes at `/system/audit-logs` that compile logged database operations and actions, linking user profile records.
- **Activity Page**: Dedicated `Activity.tsx` routing for a comprehensive audit logs history browser.
- **Notifications Bell**: Topbar dropdown showing recent audit events with dynamic relative times, complete with clear-badge mechanics.

### Fixed and polish
- **Active Clusters Card Glow**: Limited the spinning blue neon glow border exclusively to the "Active Clusters" card.
- **Sparkline Visual Clip**: Wrapped the sparkline card header elements in a clean container and adjusted the SVG viewport (`viewBox="0 -2 100 34"`) to allow smooth edge-to-edge rendering without line stroke cutoff at the bottom.
- **Sidebar Simplification**: Removed redundant "Instances" and "Schemas" entries, consolidation navigation around "Databases".
- **Dashboard Layout Alignment**: Scaled the Cluster Status card padding, dots, and uptime label sizes to perfectly balance the stacked vitals chart layout.
- **Admin Authentication**: Created a helper script to guarantee an `admin` credential block exists in the DB store.

### Verification
- Fully typechecked and compiled the Vite client and Hono backend without warnings.
