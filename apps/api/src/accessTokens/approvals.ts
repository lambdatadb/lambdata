import type { Context } from "hono";
import { APPROVAL_HEADER, APPROVAL_REQUIRED_CODE } from "@lambdata/shared";
import type { ApprovalAction, ApprovalRequiredBody } from "@lambdata/shared";
import { approvals, audit, checkpoints, imports, publicApproval, undoPoints, type StoredAccessToken, type StoredApproval } from "../db/queries";
import { newId } from "../util/id";
import type { CapabilityMatch } from "./capabilities";
import { hashSecret, scrubSecrets } from "./index";
import { destructiveKeyword } from "./sql";

export const MAX_GATE_BODY_BYTES = 10 * 1024 * 1024;
const DETAIL_MAX = 1000;

export type AskFirstOutcome =
  | { kind: "pass" }
  | { kind: "claimed"; approvalId: string }
  | { kind: "parked"; response: Response; approval: StoredApproval }
  | { kind: "refused"; status: 403 | 413; message: string };

export interface AskFirstInput {
  token: StoredAccessToken;
  match: CapabilityMatch;
  method: string;
  path: string;
  databaseId: string | null;
  databaseName: string | null;
  note: string | null;
}

async function readCapped(req: Request, limit: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function clip(text: string, max: number): string {
  const chars = [...scrubSecrets(text)];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

function sqlOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { sql?: unknown } | null;
    return parsed && typeof parsed.sql === "string" ? parsed.sql : null;
  } catch {
    return null;
  }
}

function shortHashOf(checkpointId: string | null | undefined): string {
  if (!checkpointId) return "a checkpoint";
  const cp = checkpoints.byId(checkpointId);
  return cp ? cp.shortHash : "a checkpoint";
}

function describe(
  input: AskFirstInput,
  action: ApprovalAction,
  body: string,
): { summary: string; detail: string | null } {
  const db = input.databaseName ?? "a database";
  const capability = input.match.capability;
  switch (action) {
    case "database.delete":
      return { summary: `Delete the database ${db}.`, detail: null };
    case "checkpoint.delete":
      return { summary: `Delete checkpoint ${shortHashOf(input.match.params.cid)} of ${db}.`, detail: null };
    case "checkpoint.rollback": {
      if (capability.action === "undo.rollback") {
        const point = input.databaseId ? undoPoints.get(input.token.id, input.databaseId) : null;
        return {
          summary: `Undo the changes ${input.token.name} made to ${db} by rolling back to checkpoint ${shortHashOf(point?.checkpointId)}.`,
          detail: null,
        };
      }
      return { summary: `Roll ${db} back to checkpoint ${shortHashOf(input.match.params.cid)}.`, detail: null };
    }
    case "import.replace": {
      let file: string | null = null;
      try {
        const parsed = JSON.parse(body) as { uploadId?: unknown } | null;
        const upload = parsed && typeof parsed.uploadId === "string" ? imports.uploadById(parsed.uploadId) : null;
        file = upload?.fileName ?? null;
      } catch {
        file = null;
      }
      return {
        summary: `Replace the contents of ${db} with an uploaded file.`,
        detail: file ? clip(`File: ${file}`, DETAIL_MAX) : null,
      };
    }
    case "sql.destructive": {
      const sql = sqlOf(body) ?? "";
      const word = destructiveKeyword(sql) ?? "DROP";
      return { summary: `Run a ${word} statement on ${db}.`, detail: clip(sql.trim(), DETAIL_MAX) };
    }
  }
}

function targetExists(input: AskFirstInput, action: ApprovalAction, body: string): boolean {
  if (input.databaseId === null || input.databaseName === null) return false;
  const cid = input.match.params.cid;
  if (cid !== undefined) {
    const cp = checkpoints.byId(cid);
    if (!cp || cp.databaseId !== input.databaseId) return false;
  }
  if (input.match.capability.action === "undo.rollback") {
    const point = undoPoints.get(input.token.id, input.databaseId);
    if (!point || !checkpoints.byId(point.checkpointId)) return false;
  }
  if (action === "import.replace") {
    try {
      const parsed = JSON.parse(body) as { uploadId?: unknown } | null;
      const upload = parsed && typeof parsed.uploadId === "string" ? imports.uploadById(parsed.uploadId) : null;
      if (!upload || upload.userId !== input.token.actorUserId) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function parked(c: Context, approval: StoredApproval, message: string): Response {
  const body: ApprovalRequiredBody = {
    error: message,
    code: APPROVAL_REQUIRED_CODE,
    approval: publicApproval(approval),
  };
  return c.json(body, 403);
}

const WAITING =
  "A person must approve this first. It is waiting on the Access tokens, Approvals page of the LambData console. Once it is approved, send exactly the same request again with the header X-LambData-Approval set to the approval id.";

function stateMessage(a: StoredApproval): string {
  switch (a.status) {
    case "denied":
      return "A person denied this request. Do not send it again without asking them.";
    case "expired":
      return "This approval expired before it was used. Send the request without the approval header to ask again.";
    case "used":
      return "This approval was already used. Each approval lets one request through; send the request without the approval header to ask again.";
    case "cancelled":
      return "This approval was cancelled. Send the request without the approval header to ask again.";
    default:
      return WAITING;
  }
}

export async function askFirst(c: Context, input: AskFirstInput): Promise<AskFirstOutcome> {
  const kind = input.match.capability.approval;
  if (!kind || !input.token.askFirst || input.token.preset === "read_only") return { kind: "pass" };
  const body = await readCapped(c.req.raw, MAX_GATE_BODY_BYTES);
  if (body === null) {
    return { kind: "refused", status: 413, message: `request body too large (limit ${MAX_GATE_BODY_BYTES / (1024 * 1024)} MB)` };
  }
  if (c.req.raw.body) c.req.raw = new Request(c.req.raw, { body });
  let action: ApprovalAction;
  if (kind === "sql") {
    const sql = sqlOf(body);
    if (sql === null || destructiveKeyword(sql) === null) return { kind: "pass" };
    action = "sql.destructive";
  } else {
    action = kind;
  }
  if (!targetExists(input, action, body)) return { kind: "pass" };
  const bodyHash = hashSecret(body);
  const header = c.req.header(APPROVAL_HEADER)?.trim();
  if (header) {
    const found = approvals.byId(header);
    if (!found || found.tokenId !== input.token.id) {
      return { kind: "refused", status: 403, message: "No approval with that id belongs to this access token." };
    }
    if (found.method !== input.method || found.path !== input.path || found.bodyHash !== bodyHash) {
      return {
        kind: "refused",
        status: 403,
        message:
          "This approval was given for a different request. Send exactly the approved request again, or send this one without the approval header to ask for a new approval.",
      };
    }
    if (found.status === "pending") return { kind: "parked", response: parked(c, found, WAITING), approval: found };
    if (found.status !== "approved") return { kind: "refused", status: 403, message: stateMessage(found) };
    if (!approvals.claim(found.id, input.token.id)) {
      const again = approvals.byId(found.id);
      return { kind: "refused", status: 403, message: again ? stateMessage(again) : stateMessage(found) };
    }
    return { kind: "claimed", approvalId: found.id };
  }
  const existing = approvals.pendingFor(input.token.id, input.method, input.path, bodyHash);
  if (existing) return { kind: "parked", response: parked(c, existing, WAITING), approval: existing };
  const { summary, detail } = describe(input, action, body);
  const id = newId("apr");
  approvals.insert({
    id,
    tokenId: input.token.id,
    action,
    method: input.method,
    path: input.path,
    bodyHash,
    summary,
    detail,
    databaseId: input.databaseId,
    databaseName: input.databaseName,
    note: input.note,
    requestedAt: Date.now(),
  });
  audit.log(input.token.actorUserId, "approval.request", id, {
    tokenId: input.token.id,
    tokenName: input.token.name,
    action,
    summary,
    databaseId: input.databaseId,
  });
  const created = approvals.byId(id)!;
  return { kind: "parked", response: parked(c, created, WAITING), approval: created };
}

export function releaseClaim(approvalId: string, status: number): void {
  if (status >= 400) approvals.unclaim(approvalId);
}
