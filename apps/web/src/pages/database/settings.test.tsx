import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StaticRouter } from "react-router-dom/server";
import type { Job } from "@lambdata/shared";
import { fixtureDatabase } from "../dev/jobFixtures";
import { fixtureMirror, fixturePolicy, fixtureSchedule, fixtureSync, fixtureSyncedStatus, fixtureSyncResults } from "../dev/settingsFixtures";
import { DatabaseSettings, draftOf, policyChanges, retentionProblem, syncChanged } from "./SettingsTab";
import { syncSummary } from "./SyncTab";
import { DATABASE_TABS } from "./tabs";
import {
  compactSummary,
  interactionNotes,
  lastCheckFoundNothing,
  promptChoice,
  settingsSummary,
  syncCheckpointLine,
  syncStartFor,
} from "../../components/checkpoints/policy";
import { SyncPromptBody, runSync } from "../../components/sync/SyncNow";
import { WorkingCopyRow, workingTone } from "../../components/checkpoints/WorkingCopyRow";
import { layoutGraph } from "../../components/checkpoints/graph";

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toBeNull(): void;
  not: { toContain(expected: unknown): void; toBeNull(): void; toBe(expected: unknown): void };
};

function render(node: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <StaticRouter location="/">{node}</StaticRouter>
    </QueryClientProvider>,
  );
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

const NOW = Date.now();
const standardPolicy = { ...fixturePolicy, versioned: false, checkpointOnSync: true };

test("the summary sentence restates the settings in plain words", () => {
  expect(settingsSummary({ kind: "mirror", policy: fixturePolicy, sync: fixtureSync }).join(" ")).toBe(
    "This mirror syncs every hour. One automatic checkpoint is kept per day, for 7 days, taken right after a sync. A manual sync asks whether to add another.",
  );
  expect(settingsSummary({ kind: "standard", policy: standardPolicy, sync: null }).join(" ")).toBe("One automatic checkpoint is kept per day, for 7 days.");
  expect(settingsSummary({ kind: "standard", policy: { ...standardPolicy, autoIntervalHours: 6, autoRetention: 8 }, sync: null }).join(" ")).toBe(
    "One automatic checkpoint is kept every 6 hours, for 2 days.",
  );
  expect(settingsSummary({ kind: "mirror", policy: { ...fixturePolicy, autoIntervalHours: 0 }, sync: { ...fixtureSync, enabled: false } }).join(" ")).toBe(
    "This mirror syncs only when you run it. Automatic checkpoints are off, so syncs record none. A manual sync asks whether to add another.",
  );
  expect(settingsSummary({ kind: "mirror", policy: { ...fixturePolicy, manualSyncCheckpoint: "always" }, sync: fixtureSync }).join(" ")).toContain(
    "A manual sync always adds another, kept until you delete it.",
  );
  expect(settingsSummary({ kind: "mirror", policy: { ...fixturePolicy, versioned: false }, sync: fixtureSync }).join(" ")).toContain(
    "It is not versioned, so syncs are never recorded as checkpoints.",
  );
  expect(settingsSummary({ kind: "standard", policy: { ...fixturePolicy, versioned: false }, sync: null }).join(" ")).toBe(
    "One automatic checkpoint is kept per day, for 7 days.",
  );
  expect(settingsSummary({ kind: "mirror", policy: { ...fixturePolicy, versioned: false }, sync: fixtureSync }).join(" ")).toBe(
    "This mirror syncs every hour. One automatic checkpoint is kept per day, for 7 days. It is not versioned, so syncs are never recorded as checkpoints.",
  );
  expect(lastCheckFoundNothing(NOW, [{ trigger: "scheduled", createdAt: NOW - 30_000 }])).toBe(false);
  expect(lastCheckFoundNothing(NOW, [{ trigger: "manual", createdAt: NOW }])).toBe(true);
  expect(lastCheckFoundNothing(null, [])).toBe(false);
  expect(compactSummary({ ...fixturePolicy, versioned: false }, false)).toBe("One a day · keep 7");
  expect(compactSummary(fixturePolicy, true)).toBe("One a day · keep 7 · after a sync");
  expect(compactSummary({ ...fixturePolicy, autoIntervalHours: 0 }, true)).toBe("Automatic checkpoints off");
});

test("settings that interact say so in place", () => {
  expect(interactionNotes({ kind: "mirror", policy: { ...fixturePolicy, autoIntervalHours: 1 }, sync: { ...fixtureSync, intervalSeconds: 21600 } })).toEqual([
    "The mirror syncs less often than that, so there is at most one checkpoint per sync.",
  ]);
  expect(interactionNotes({ kind: "mirror", policy: { ...fixturePolicy, autoIntervalHours: 0 }, sync: fixtureSync })[0]).toContain(
    "With automatic checkpoints off, syncs record none",
  );
  expect(interactionNotes({ kind: "mirror", policy: fixturePolicy, sync: { ...fixtureSync, enabled: false } })[0]).toContain("schedule takes the automatic checkpoint");
  expect(interactionNotes({ kind: "standard", policy: standardPolicy, sync: null })).toEqual([]);
});

test("a mirror's settings page has every setting in one place for a writer", () => {
  const html = render(
    <DatabaseSettings db={fixtureMirror} policy={fixturePolicy} schedule={fixtureSchedule(NOW)} sync={fixtureSync} canWrite limits={null} checkpoints={[]} />,
  );
  const t = text(html);
  expect(t).toContain("At a glance");
  expect(t).toContain("This mirror syncs every hour. One automatic checkpoint is kept per day, for 7 days, taken right after a sync.");
  expect(t).toContain("Last automatic check 3h ago (nothing had changed)");
  expect(t).toContain("Next one due after");
  for (const label of ["Versioned", "Sync on a schedule", "How often", "Automatic checkpoints", "How many to keep", "Take the automatic checkpoint right after a sync", "After a manual sync", "Ask each time", "Always add a checkpoint", "Never"]) {
    expect(t).toContain(label);
  }
  expect(t).toContain("kept until you delete it");
  expect(t).toContain("About 7 days of automatic history.");
  expect(t).toContain("Save settings");
  expect(t).toContain("Everything is saved.");
  expect(html).not.toContain("<fieldset disabled");
});

test("a standard database has no sync settings, and a viewer sees the page read-only", () => {
  const standard = text(render(<DatabaseSettings db={fixtureDatabase} policy={standardPolicy} schedule={null} sync={null} canWrite limits={null} />));
  expect(standard).toContain("Versioned");
  expect(standard).not.toContain("Sync on a schedule");
  expect(standard).not.toContain("After a manual sync");
  expect(standard).toContain("One automatic checkpoint is kept per day, for 7 days.");
  const viewer = render(<DatabaseSettings db={fixtureMirror} policy={fixturePolicy} schedule={fixtureSchedule(NOW)} sync={fixtureSync} canWrite={false} limits={null} />);
  expect(viewer).toContain("<fieldset disabled");
  expect(text(viewer)).toContain("The database's owner or an admin can change them.");
  expect(text(viewer)).not.toContain("Save settings");
  const limitedViewer = text(
    render(<DatabaseSettings db={fixtureMirror} policy={fixturePolicy} schedule={null} sync={fixtureSync} canWrite={false} limits={null} />),
  );
  expect(limitedViewer).not.toContain("on this server");
});

test("owner limits are shown and checked; drafts produce only the changes", () => {
  const owner = text(
    render(<DatabaseSettings db={fixtureMirror} policy={fixturePolicy} schedule={null} sync={fixtureSync} canWrite limits={{ minHours: 6, maxKeep: 30 }} />),
  );
  expect(owner).toContain("This server allows at most one every 6 hours.");
  expect(owner).toContain("At most 30 on this server.");
  expect(retentionProblem("31", { minHours: 1, maxKeep: 30 })).toBe("Enter a whole number from 1 to 30.");
  expect(retentionProblem("400", null)).toBeNull();
  const draft = draftOf(fixturePolicy, fixtureSync);
  expect(policyChanges(draft, fixturePolicy)).toEqual({});
  expect(policyChanges({ ...draft, autoRetention: "14", manualSyncCheckpoint: "never" }, fixturePolicy)).toEqual({ autoRetention: 14, manualSyncCheckpoint: "never" });
  expect(syncChanged({ ...draft, syncIntervalSeconds: 900 }, fixtureSync)).toBe(true);
  expect(syncChanged(draft, fixtureSync)).toBe(false);
  const edited = text(
    render(
      <DatabaseSettings
        db={fixtureMirror}
        policy={fixturePolicy}
        schedule={null}
        sync={fixtureSync}
        canWrite
        limits={null}
        initialDraft={{ ...draft, autoIntervalHours: 1, autoRetention: "24", syncIntervalSeconds: 21600 }}
      />,
    ),
  );
  expect(edited).toContain("unsaved changes");
  expect(edited).toContain("This mirror syncs every 6 hours. One automatic checkpoint is kept per hour, for 24 hours");
  expect(edited).toContain("at most one checkpoint per sync");
});

test("Sync now asks only when it should, and each answer sends the right body", () => {
  expect(syncStartFor(true, "ask")).toEqual({ prompt: true });
  expect(syncStartFor(true, "always")).toEqual({ prompt: false, body: { checkpoint: true } });
  expect(syncStartFor(true, "never")).toEqual({ prompt: false, body: { checkpoint: false } });
  expect(syncStartFor(false, "ask")).toEqual({ prompt: false, body: {} });
  expect(promptChoice(true, false)).toEqual({ body: { checkpoint: true }, remember: null });
  expect(promptChoice(false, false)).toEqual({ body: { checkpoint: false }, remember: null });
  expect(promptChoice(true, true)).toEqual({ body: { checkpoint: true }, remember: "always" });
  expect(promptChoice(false, true)).toEqual({ body: { checkpoint: false }, remember: "never" });
  const t = text(render(<SyncPromptBody dontAsk={false} onDontAsk={() => undefined} />));
  expect(t).toContain("Today's automatic checkpoint is not affected. Additional checkpoints are kept until you delete them.");
  expect(t).toContain("Don't ask again for this database");
  expect(t).toContain("You can change it in Settings.");
});

test("sync results say what happened with the checkpoint", () => {
  const r = fixtureSyncResults(NOW);
  expect(syncCheckpointLine(r.additional!, "a41f9c2")?.text).toBe("Additional checkpoint a41f9c2 saved");
  expect(syncCheckpointLine(r.automatic!, "c90b5d4")?.text).toBe("Automatic checkpoint c90b5d4 recorded");
  expect(syncCheckpointLine(r.notDue!, null, 24, NOW)?.text).toContain("No checkpoint: today's automatic one already exists. Next due after");
  expect(syncCheckpointLine(r.unchanged!, null)?.text).toBe("No changes since the last checkpoint");
  expect(syncCheckpointLine(r.declined!, null)?.text).toBe("No additional checkpoint, as chosen");
  expect(syncCheckpointLine({ ...r.notDue!, checkpointSkipped: "automatic-off", nextAutomaticDueAt: null }, null)?.text).toBe(
    "No checkpoint: automatic checkpoints are off for this database",
  );
  expect(syncCheckpointLine({ ...r.notDue!, nextAutomaticDueAt: null }, null, 24)?.text).toBe("No checkpoint: today's automatic one already exists.");
  const job = (result: object) => ({ id: "j", kind: "sync.run", status: "succeeded", result, warnings: [] }) as unknown as Job;
  const html = render(<>{syncSummary(job(r.additional!), new Map([["cp_additional", { shortHash: "a41f9c2" }]]), 24)}</>);
  expect(text(html)).toContain("3 tables copied.");
  expect(text(html)).toContain("Additional checkpoint a41f9c2 saved.");
  expect(html).toContain('data-sync-checkpoint="additional"');
});

test("a mirror whose live data is just the last sync reads as neutral, not as uncommitted changes", () => {
  const status = fixtureSyncedStatus();
  expect(workingTone(status)).toBe("muted");
  expect(workingTone({ ...status, matchesLastSync: false })).toBe("dirty");
  const row = layoutGraph([{ id: "w", parentId: null }], { workingId: "w" }).rows[0]!;
  const html = render(
    <ol>
      <WorkingCopyRow row={row} laneWidth={16} graphWidth={40} status={status} statusLoading={false} statusError={null} base={null} activeJob={null} activeLabel={null} checking={false} onCheck={() => undefined} onCreate={null} createDisabled={null} />
    </ol>,
  );
  const t = text(html);
  expect(t).toContain("synced, not in a checkpoint");
  expect(t).toContain("Synced data, not yet in a checkpoint: 1 table changed, +24 rows since HEAD");
  expect(t).not.toContain("uncommitted changes");
});

test("Settings is a tab before Danger, for everyone, and Sync now posts JSON", async () => {
  const ids = DATABASE_TABS.map((t) => t.id);
  expect(ids.indexOf("settings")).toBe(ids.indexOf("danger") - 1);
  expect(DATABASE_TABS.find((t) => t.id === "settings")?.visible).toBe(undefined);
  const original = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({ job: {} }), { status: 202, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await runSync("db1", { checkpoint: true });
  } finally {
    globalThis.fetch = original;
  }
  const s = seen as unknown as { url: string; init: RequestInit };
  expect(s.url).toBe("/api/databases/db1/sync/run");
  expect(new Headers(s.init.headers).get("Content-Type")).toBe("application/json");
  expect(s.init.body).toBe('{"checkpoint":true}');
});
