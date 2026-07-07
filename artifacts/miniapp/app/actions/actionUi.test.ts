import test from "node:test";
import assert from "node:assert";
import { getPreflightBadge, getRevokeExecutionNotice, getRiskVariant, getStatusState, shouldShowConfirmButton } from "./actionUi";

test("miniapp action UI maps risk and status states", () => {
  assert.strictEqual(getRiskVariant("critical"), "risk");
  assert.strictEqual(getRiskVariant("high"), "risk");
  assert.strictEqual(getRiskVariant("medium"), "warn");
  assert.strictEqual(getRiskVariant("low"), "ok");
  assert.strictEqual(getStatusState("executed"), "live");
  assert.strictEqual(getStatusState("failed"), "failed");
  assert.strictEqual(getStatusState("pending"), "stale");
});

test("miniapp confirm CTA only appears for pending whitelisted actions with calls", () => {
  assert.strictEqual(shouldShowConfirmButton({
    status: "pending",
    executionPayload: { actionType: "revoke_approval", calls: [{ to: "0x1" }] },
  }), true);

  assert.strictEqual(shouldShowConfirmButton({
    status: "executed",
    executionPayload: { actionType: "revoke_approval", calls: [{ to: "0x1" }] },
  }), false);

  assert.strictEqual(shouldShowConfirmButton({
    status: "pending",
    executionPayload: { actionType: "swap", calls: [{ to: "0x1" }] },
  }), false);

  assert.strictEqual(shouldShowConfirmButton({
    status: "pending",
    executionPayload: { actionType: "revoke_approval", calls: [] },
  }), false);
});

test("miniapp preflight badge does not claim real simulation", () => {
  const badge = getPreflightBadge();
  assert.ok(badge.label.includes("Preflight validation"));
  assert.ok(badge.title.includes("No fork simulation"));
});

test("miniapp executed revoke action shows proof notice and no confirm CTA", () => {
  const action = {
    status: "executed",
    txHash: "0xabc1230000000000000000000000000000000000000000000000000000000000",
    batchId: "0xbatch1234567890abcdef",
    executionPayload: { actionType: "revoke_approval", calls: [{ to: "0x1" }] },
    metadata: {
      actionType: "revoke_approval",
      allowanceAfter: "0",
      executionProof: {
        type: "wallet_confirmation_receipt",
        txHash: "0xabc1230000000000000000000000000000000000000000000000000000000000",
        batchId: "0xbatch1234567890abcdef",
        statusCode: 200,
        allowanceAfter: "0",
        source: "metadata.confirmation",
      },
    },
  };

  const notice = getRevokeExecutionNotice(action);
  assert.strictEqual(notice?.title, "Revocation effective — allowance is now 0");
  assert.ok(notice?.txHashUrl?.includes("basescan.org/tx/0xabc123"));
  assert.strictEqual(notice?.stateOnlyLabel, undefined);
  assert.strictEqual(shouldShowConfirmButton(action), false);
});
