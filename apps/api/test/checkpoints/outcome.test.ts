import { describe, expect, test } from "bun:test";
import { invalidViewNames } from "../../src/checkpoints/capture";
import { RestoreVerificationError, splitSwapOutcome } from "../../src/checkpoints/restore";
import { PhaseTracker, staleFailure } from "../../src/checkpoints/fencedSwap";
import { SwapBlockedError } from "../../src/mariadb/schemaSwap";

describe("rollback outcome", () => {
  test("a view already broken at checkpoint time is a stated limitation, anything else is an error", () => {
    const tolerated = invalidViewNames([
      "view v_gone could not be queried when this checkpoint was taken (it refers to a table, column or function that does not exist); rolling back keeps or re-creates it only where MariaDB accepts its definition",
    ]);
    expect([...tolerated]).toEqual(["v_gone"]);
    const out = splitSwapOutcome(
      {
        outcome: "done-with-errors",
        failures: [
          { kind: "VIEW", name: "v_gone", error: "Table 'x.gone' doesn't exist" },
          { kind: "TRIGGER", name: "t_audit", error: "Lock wait timeout exceeded" },
        ],
        warnings: [
          "could not re-create view v_gone: Table 'x.gone' doesn't exist",
          "could not re-create trigger t_audit: Lock wait timeout exceeded",
          "view v_gone is kept as recorded but cannot be queried: it refers to a table, column or function that does not exist",
        ],
        codeApplied: 3,
      },
      tolerated,
    );
    expect(out.failures).toEqual([{ kind: "TRIGGER", name: "t_audit", error: "Lock wait timeout exceeded" }]);
    expect(out.warnings).toEqual([
      "view v_gone was already broken when the checkpoint was taken and could not be re-created: Table 'x.gone' doesn't exist",
      "could not re-create trigger t_audit: Lock wait timeout exceeded",
    ]);
  });

  test("a verification failure names what differs and says nothing changed", () => {
    const err = new RestoreVerificationError(
      "Rolling back to abc1234",
      Array.from({ length: 10 }, (_, i) => `table t${i} has ${i} row(s) after loading, the checkpoint recorded ${i + 1}`),
    );
    expect(err.message.startsWith("Rolling back to abc1234 was stopped before anything changed:")).toBe(true);
    expect(err.message).toContain("the live database was left exactly as it was");
    expect(err.message).toContain("table t0 has 0 row(s) after loading, the checkpoint recorded 1");
    expect(err.message).toContain("and 2 more");
    expect(err.problems.length).toBe(10);
  });

  test("a job cut short during the swap says whether anything changed", () => {
    const t = new PhaseTracker();
    expect(t.explain(new Error("Connection lost: The server closed the connection.")).message).toBe(
      "Connection lost: The server closed the connection. Nothing was changed.",
    );
    t.onPhase("prepared");
    expect(t.explain(new Error("Connection lost: The server closed the connection.")).message).toBe(
      "Connection lost: The server closed the connection. Nothing was changed.",
    );
    t.onPhase("moved-out");
    expect(t.explain(new Error("Connection lost")).message).toBe(
      "Connection lost. It stopped part-way through the swap; LambData puts the database back as it was automatically when MariaDB is available again or at the next start.",
    );
    t.onPhase("triggers");
    expect(t.explain(new Error("Connection lost")).message).toBe(
      "Connection lost. The new tables were already in place; LambData finishes re-creating views, triggers and routines automatically when MariaDB is available again or at the next start.",
    );
    const blocked = new SwapBlockedError("Could not swap the new tables into x: other sessions kept its tables in use for more than 15s, so nothing was changed.", [], null);
    expect(t.explain(blocked)).toBe(blocked);
    expect(new PhaseTracker().explain(new Error("could not reach `_ld_stage_ab12cd34_shop`.`t`")).message).not.toContain("_ld_stage_");
  });

  test("a table that keeps changing is named, with the likely cause", () => {
    expect(staleFailure("Rolling back to abc1234", ["orders", "items (added)"]).message).toBe(
      "Rolling back to abc1234 was not done: orders, items (added) kept changing while their safety checkpoint was taken, although this database's own account was closed to writes. Something other than its own account is writing to them (another MariaDB account, or a scheduled event). Nothing was changed. Stop that writer, or let it finish, and try again.",
    );
  });
});
