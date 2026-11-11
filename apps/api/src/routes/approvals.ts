import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ApprovalListResponse, ApprovalResponse, ApprovalStatus } from "@lambdata/shared";
import { approvals, audit, publicApproval, type StoredApproval } from "../db/queries";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { currentAccessToken } from "../accessTokens/index";
import { parseJson, parseQuery } from "../util/validate";

export const approvalsRoute = new Hono<{ Variables: AuthVariables }>();

approvalsRoute.use("*", requireAuth);

const STATUSES = ["pending", "approved", "denied", "expired", "used", "cancelled"] as const;

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const decisionSchema = z.object({ decision: z.enum(["approve", "deny"], { error: "decision must be approve or deny" }) }).strict();

const STATE_WORDS: Record<ApprovalStatus, string> = {
  pending: "is still waiting for a decision",
  approved: "was already approved",
  denied: "was already denied",
  expired: "has expired",
  used: "was already approved and used",
  cancelled: "was cancelled by the access token that asked for it",
};

function visible(c: Context<{ Variables: AuthVariables }>, id: string): StoredApproval {
  const approval = approvals.byId(id);
  const req = currentAccessToken(c);
  const user = c.get("user");
  const mayRead = req ? approval?.tokenId === req.token.id : user.role === "admin";
  if (!approval || !mayRead) {
    if (!req && user.role !== "admin") throw new HTTPException(403, { message: "Only admins can see approvals." });
    throw new HTTPException(404, { message: "approval not found" });
  }
  return approval;
}

approvalsRoute.get("/", (c) => {
  const req = currentAccessToken(c);
  const user = c.get("user");
  if (!req && user.role !== "admin") throw new HTTPException(403, { message: "Only admins can see approvals." });
  const q = parseQuery(c, listQuery);
  const tokenId = req?.token.id;
  const list = approvals.list({ tokenId, status: q.status, limit: q.limit });
  const res: ApprovalListResponse = {
    approvals: list.map(publicApproval),
    pending: q.status === "pending" && list.length < q.limit ? list.length : approvals.pendingCount(tokenId),
  };
  return c.json(res);
});

approvalsRoute.get("/:id", (c) => {
  const res: ApprovalResponse = { approval: publicApproval(visible(c, c.req.param("id"))) };
  return c.json(res);
});

approvalsRoute.delete("/:id", (c) => {
  const req = currentAccessToken(c);
  if (!req) {
    throw new HTTPException(403, { message: "Only the access token that asked can cancel an approval. Deny it instead." });
  }
  const approval = visible(c, c.req.param("id"));
  if (!approvals.cancel(approval.id, req.token.id)) {
    const now = approvals.byId(approval.id) ?? approval;
    throw new HTTPException(409, { message: `This approval ${STATE_WORDS[now.status]}, so it cannot be cancelled.` });
  }
  const res: ApprovalResponse = { approval: publicApproval(approvals.byId(approval.id)!) };
  return c.json(res);
});

approvalsRoute.post("/:id/decision", async (c) => {
  if (currentAccessToken(c)) throw new HTTPException(403, { message: "Access tokens can never decide approvals." });
  const user = c.get("user");
  if (user.role !== "admin") throw new HTTPException(403, { message: "Only admins can decide approvals." });
  const body = await parseJson(c, decisionSchema);
  const approval = approvals.byId(c.req.param("id"));
  if (!approval) throw new HTTPException(404, { message: "approval not found" });
  const status = body.decision === "approve" ? "approved" : "denied";
  if (!approvals.decide(approval.id, status, { userId: user.id, displayName: user.displayName ?? user.email })) {
    const now = approvals.byId(approval.id) ?? approval;
    throw new HTTPException(409, { message: `This approval ${STATE_WORDS[now.status]}, so it can no longer be decided.` });
  }
  const decided = approvals.byId(approval.id)!;
  audit.log(user.id, "approval.decide", decided.id, {
    tokenId: decided.tokenId,
    tokenName: decided.tokenName,
    action: decided.action,
    status: decided.status,
  });
  const res: ApprovalResponse = { approval: publicApproval(decided) };
  return c.json(res);
});
