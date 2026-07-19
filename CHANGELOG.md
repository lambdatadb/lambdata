# Changelog

All notable changes to KilnDB.

## Unreleased

### Changed
- Renamed the project and all public/runtime namespaces to KilnDB, including package scopes, environment variables, persistent paths, cookies, generated API metadata, Docker assets, and database-user prefixes.
- Replaced the previous box mark with a transparent database-stack bottle-kiln mark and adopted a warm charcoal and kiln-red visual system throughout the console.
- Reworked the public README around the Docker-first installation path, current feature set, operational model, backups, and security boundaries.
- Added copy-paste Docker Compose and Docker Run quick-start paths with persistence, logs, restart, and upgrade commands.
- Added GitHub Actions checks for type safety, the production web build, and the Docker image.
- Added contribution and private security-reporting guidance.

## Supabase-Inspired Visual Refresh — May 24, 2026

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

## Storage Parity Slice — May 24, 2026

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

## Redesign & Developer Experience (DX) Overhaul — May 20, 2026

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

### Fixed & Polish
- **Active Clusters Card Glow**: Limited the spinning blue neon glow border exclusively to the "Active Clusters" card.
- **Sparkline Visual Clip**: Wrapped the sparkline card header elements in a clean container and adjusted the SVG viewport (`viewBox="0 -2 100 34"`) to allow smooth edge-to-edge rendering without line stroke cutoff at the bottom.
- **Sidebar Simplification**: Removed redundant "Instances" and "Schemas" entries, consolidation navigation around "Databases".
- **Dashboard Layout Alignment**: Scaled the Cluster Status card padding, dots, and uptime label sizes to perfectly balance the stacked vitals chart layout.
- **Admin Authentication**: Created a helper script to guarantee an `admin` credential block exists in the DB store.

### Verification
- Fully typechecked and compiled the Vite client and Hono backend without warnings.
