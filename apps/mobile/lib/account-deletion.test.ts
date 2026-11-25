import { describe, expect, it } from "vitest";
import { blockerLine, deleteErrorMessage, type DeletionStatus } from "./account-deletion";

describe("blockerLine", () => {
  it("labels an open booking with the shared state vocabulary", () => {
    expect(blockerLine({ kind: "OPEN_BOOKING", bookingId: "b1", state: "ESCROW_FUNDED" })).toBe(
      "Funds held — open booking",
    );
  });
  it("falls back to the raw state for an unknown one", () => {
    expect(blockerLine({ kind: "OPEN_BOOKING", bookingId: "b1", state: "NEW_STATE" })).toBe(
      "NEW_STATE — open booking",
    );
  });
  it("explains an operator account", () => {
    expect(blockerLine({ kind: "ADMIN_ACCOUNT" })).toBe("Operator accounts can't be deleted here.");
  });
});

describe("deleteErrorMessage", () => {
  it("maps a wrong password", () => {
    expect(deleteErrorMessage({ code: "INVALID_PASSWORD", message: "Invalid password" })).toBe(
      "That password didn't match.",
    );
  });
  it("passes the server's sentence through", () => {
    expect(
      deleteErrorMessage({
        message: "Finish or cancel your open bookings before deleting your account.",
      }),
    ).toBe("Finish or cancel your open bookings before deleting your account.");
  });
  it("falls back when there is nothing usable", () => {
    expect(deleteErrorMessage(null)).toBe("Couldn't delete your account — try again.");
  });
});

// type-only: the wire shape of GET /api/account/deletion
const shape: DeletionStatus = { canDelete: true, blockers: [] };
void shape;
