import { beforeEach, describe, expect, it, vi } from "vitest";

/* Spec 2026-11-25 (SOW v2 A1). Seams: prisma, payments, storage-backed
   removeDocRecord, withElapsedWindow. The booking machine's TERMINAL_STATES and
   isAdminEmail run for real. A failing test here is a real rule gap. */

const seams = vi.hoisted(() => {
  const tx = {
    booking: { count: vi.fn() },
    accountDeletionRecord: { upsert: vi.fn() },
    crewProfileClaim: { delete: vi.fn() },
  };
  return {
    tx,
    prisma: {
      booking: { findMany: vi.fn() },
      crewProfileClaim: { findUnique: vi.fn() },
      credentialDoc: { findMany: vi.fn() },
      accountDeletionRecord: { findUnique: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
    withElapsedWindow: vi.fn(async (b: unknown) => b),
    removeDocRecord: vi.fn<(doc: unknown) => Promise<void>>(async () => undefined),
    closeRecipientAccount: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    order: [] as string[],
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@deckbook/db", () => ({ prisma: seams.prisma }));
vi.mock("@deckbook/payments", () => ({ closeRecipientAccount: seams.closeRecipientAccount }));
vi.mock("./bookings", () => ({ withElapsedWindow: seams.withElapsedWindow }));
vi.mock("./credential-service", () => ({ removeDocRecord: seams.removeDocRecord }));

import { deletionBlockers, prepareAccountDeletion } from "./account-deletion";

const BOAT = { id: "u-boat", email: "boat@example.test", accountType: "BOAT" };
const CREW = { id: "u-crew", email: "crew@example.test", accountType: "CREW" };
const OPEN = ["REQUESTED", "ACCEPTED", "ESCROW_FUNDED", "IN_PROGRESS", "COMPLETED", "DISPUTE_WINDOW"];
const TERMINAL = ["PAID_OUT", "CANCELLED_WEATHER", "CANCELLED_BOAT", "CANCELLED_CREW"];
const BLOCKED_MESSAGE = "Finish or cancel your open bookings before deleting your account.";

beforeEach(() => {
  vi.clearAllMocks();
  seams.order.length = 0;
  delete process.env.ADMIN_EMAILS;
  seams.prisma.booking.findMany.mockResolvedValue([]);
  seams.prisma.crewProfileClaim.findUnique.mockResolvedValue(null);
  seams.prisma.credentialDoc.findMany.mockResolvedValue([]);
  seams.prisma.accountDeletionRecord.findUnique.mockResolvedValue(null);
  seams.prisma.$transaction.mockImplementation(async (fn) => fn(seams.tx));
  seams.tx.booking.count.mockResolvedValue(0);
  seams.withElapsedWindow.mockImplementation(async (b: unknown) => b);
  seams.removeDocRecord.mockImplementation(async () => undefined);
  seams.closeRecipientAccount.mockImplementation(async () => undefined);
});

describe("deletionBlockers", () => {
  it("blocks an allowlisted admin and looks nothing else up", async () => {
    process.env.ADMIN_EMAILS = "ops@example.test, boat@example.test";
    expect(await deletionBlockers(BOAT)).toEqual([{ kind: "ADMIN_ACCOUNT" }]);
    expect(seams.prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it.each(OPEN)("a %s booking blocks", async (state) => {
    seams.prisma.booking.findMany.mockResolvedValue([{ id: "b1", state }]);
    expect(await deletionBlockers(BOAT)).toEqual([{ kind: "OPEN_BOOKING", bookingId: "b1", state }]);
  });

  it.each(TERMINAL)("a %s booking does not block", async (state) => {
    seams.prisma.booking.findMany.mockResolvedValue([{ id: "b1", state }]);
    expect(await deletionBlockers(BOAT)).toEqual([]);
    expect(seams.withElapsedWindow).not.toHaveBeenCalled();
  });

  it("queries a boat account by boatUserId only", async () => {
    await deletionBlockers(BOAT);
    expect(seams.prisma.booking.findMany).toHaveBeenCalledWith({
      where: { OR: [{ boatUserId: "u-boat" }] },
      orderBy: { requestedAt: "desc" },
    });
  });

  it("adds the claimed profile for a crew account", async () => {
    seams.prisma.crewProfileClaim.findUnique.mockResolvedValue({ profileId: "p1", userId: "u-crew" });
    await deletionBlockers(CREW);
    expect(seams.prisma.booking.findMany).toHaveBeenCalledWith({
      where: { OR: [{ boatUserId: "u-crew" }, { crewProfileId: "p1" }] },
      orderBy: { requestedAt: "desc" },
    });
  });

  it("settles an elapsed review window before deciding (P-2)", async () => {
    seams.prisma.booking.findMany.mockResolvedValue([{ id: "b1", state: "DISPUTE_WINDOW" }]);
    seams.withElapsedWindow.mockResolvedValue({ id: "b1", state: "PAID_OUT" });
    expect(await deletionBlockers(BOAT)).toEqual([]);
  });
});

describe("prepareAccountDeletion", () => {
  const CLAIM = { profileId: "p1", userId: "u-crew", stripeAccountId: "acct_1" };
  const DOC_A = { id: "d1", s3Key: "credentials/p1/d1.pdf", verifiedAt: null };
  const DOC_B = { id: "d2", s3Key: "credentials/p1/d2.pdf", verifiedAt: new Date() };

  function crewWithEverything() {
    seams.prisma.crewProfileClaim.findUnique.mockResolvedValue(CLAIM);
    seams.prisma.credentialDoc.findMany.mockResolvedValue([DOC_A, DOC_B]);
    seams.prisma.accountDeletionRecord.findUnique.mockResolvedValue({
      id: "u-crew",
      stripeAccountId: "acct_1",
      stripeCloseState: null,
    });
    seams.removeDocRecord.mockImplementation(async () => {
      seams.order.push("doc");
    });
    seams.prisma.$transaction.mockImplementation(async (fn) => {
      seams.order.push("tx");
      return fn(seams.tx);
    });
    seams.closeRecipientAccount.mockImplementation(async () => {
      seams.order.push("stripe");
    });
  }

  it("throws and touches nothing when blocked", async () => {
    seams.prisma.booking.findMany.mockResolvedValue([{ id: "b1", state: "ACCEPTED" }]);
    await expect(prepareAccountDeletion(BOAT)).rejects.toThrow(BLOCKED_MESSAGE);
    expect(seams.removeDocRecord).not.toHaveBeenCalled();
    expect(seams.prisma.$transaction).not.toHaveBeenCalled();
    expect(seams.closeRecipientAccount).not.toHaveBeenCalled();
  });

  it("boat account: writes the record, no claim, no Stripe", async () => {
    await prepareAccountDeletion(BOAT);
    expect(seams.tx.accountDeletionRecord.upsert).toHaveBeenCalledWith({
      where: { id: "u-boat" },
      create: { id: "u-boat", accountType: "BOAT", stripeAccountId: null },
      update: {},
    });
    expect(seams.tx.crewProfileClaim.delete).not.toHaveBeenCalled();
    expect(seams.closeRecipientAccount).not.toHaveBeenCalled();
  });

  it("crew account: documents, then transaction, then Stripe", async () => {
    crewWithEverything();
    await prepareAccountDeletion(CREW);
    expect(seams.order).toEqual(["doc", "doc", "tx", "stripe"]);
    expect(seams.prisma.credentialDoc.findMany).toHaveBeenCalledWith({
      where: { uploadedByUserId: "u-crew" },
    });
    expect(seams.removeDocRecord).toHaveBeenCalledWith(DOC_A);
    expect(seams.removeDocRecord).toHaveBeenCalledWith(DOC_B);
    expect(seams.tx.accountDeletionRecord.upsert).toHaveBeenCalledWith({
      where: { id: "u-crew" },
      create: { id: "u-crew", accountType: "CREW", stripeAccountId: "acct_1" },
      update: {},
    });
    expect(seams.tx.crewProfileClaim.delete).toHaveBeenCalledWith({ where: { userId: "u-crew" } });
    expect(seams.closeRecipientAccount).toHaveBeenCalledWith("acct_1");
    expect(seams.prisma.accountDeletionRecord.update).toHaveBeenCalledWith({
      where: { id: "u-crew" },
      data: { stripeCloseState: "CLOSED" },
    });
  });

  it("a storage failure aborts before the claim or Stripe are touched", async () => {
    crewWithEverything();
    seams.removeDocRecord.mockRejectedValue(new Error("storage down"));
    await expect(prepareAccountDeletion(CREW)).rejects.toThrow("storage down");
    expect(seams.prisma.$transaction).not.toHaveBeenCalled();
    expect(seams.closeRecipientAccount).not.toHaveBeenCalled();
  });

  it("a booking that arrives mid-delete aborts inside the transaction", async () => {
    crewWithEverything();
    seams.tx.booking.count.mockResolvedValue(1);
    await expect(prepareAccountDeletion(CREW)).rejects.toThrow(BLOCKED_MESSAGE);
    expect(seams.tx.booking.count).toHaveBeenCalledWith({
      where: { crewProfileId: "p1", state: { notIn: TERMINAL } },
    });
    expect(seams.tx.crewProfileClaim.delete).not.toHaveBeenCalled();
    expect(seams.closeRecipientAccount).not.toHaveBeenCalled();
  });

  it("a Stripe failure is recorded and does not block deletion", async () => {
    crewWithEverything();
    seams.closeRecipientAccount.mockRejectedValue(new Error("balance remaining"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(prepareAccountDeletion(CREW)).resolves.toBeUndefined();
    expect(seams.prisma.accountDeletionRecord.update).toHaveBeenCalledWith({
      where: { id: "u-crew" },
      data: { stripeCloseState: "FAILED" },
    });
    // D-1: the operator line names the user id only — never the email or Stripe's message
    expect(logged.mock.calls.flat().join(" ")).not.toContain("crew@example.test");
    logged.mockRestore();
  });

  it("retry after the claim is gone still closes Stripe from the record", async () => {
    seams.prisma.accountDeletionRecord.findUnique.mockResolvedValue({
      id: "u-crew",
      stripeAccountId: "acct_1",
      stripeCloseState: "FAILED",
    });
    await prepareAccountDeletion(CREW);
    expect(seams.tx.crewProfileClaim.delete).not.toHaveBeenCalled();
    expect(seams.closeRecipientAccount).toHaveBeenCalledWith("acct_1");
  });

  it("does not close an account already recorded as closed", async () => {
    seams.prisma.accountDeletionRecord.findUnique.mockResolvedValue({
      id: "u-crew",
      stripeAccountId: "acct_1",
      stripeCloseState: "CLOSED",
    });
    await prepareAccountDeletion(CREW);
    expect(seams.closeRecipientAccount).not.toHaveBeenCalled();
  });
});
