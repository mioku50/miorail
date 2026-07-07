import test from "node:test";
import assert from "node:assert";
import { getPreflightBadge, getRiskVariant, getStatusState, shouldShowConfirmButton } from "./actionUi";

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
