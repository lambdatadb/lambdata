# Visual Refresh Walkthrough

KilnDB uses a database-first dark console layout: warm-charcoal page chrome, neutral panels, subtle borders, kiln-red actions, and dense operational pages.

## Brand

- Added `apps/web/public/kilndb-mark.png`, a transparent no-text mark for KilnDB.
- Wired the mark into the favicon, sidebar, login screen, and first-run setup flow.

## Theme

- Updated the app theme to:
  - Background: `#131110`
  - Panel: `#1B1817`
  - Subtle surface: `#26211F`
  - Accent: `#D85D3F`
  - Accent hover: `#EB714E`
  - Success: `#4AB37E`
- Removed the earlier blue/purple glow treatment from active UI code.
- Flattened card shadows to `none` and kept panel depth through borders and surface contrast.

## Layout

- Sidebar and topbar now use solid charcoal surfaces and compact controls.
- Page content uses a wider `max-w-7xl` container with restrained spacing.
- Page headings use plain uppercase eyebrows without decorative glyphs.
- Buttons, badges, form fields, cards, and data tables now use tighter radii and less ornamentation.
- Supabase-parity pages for Auth, Data API, Storage, Realtime, and Functions share the same dense operational layout.
- The Data API page now behaves like generated API docs: reflected tables, column constraints, examples, and OpenAPI export live together.
- Data API policies are managed from the same page so method gates and owner-column rules are visible beside the generated docs.

## Removed

- Dotted grid page backgrounds.
- Corner tick decorations.
- Rotating glow border card utility.
- Cyan/blue/purple dashboard accents.
- Neon drop-shadows on status dots and charts.

## Verification

- `bun run typecheck`
- `bun run build`
- `bun run scripts/visual-test.ts`
