import "server-only";
import { APIError } from "better-auth/api";
import { prisma } from "@deckbook/db";
import { TERMINAL_STATES, type BookingState } from "@deckbook/types";
import { closeRecipientAccount } from "@deckbook/payments";
import { withElapsedWindow } from "./bookings";
import { isAdminEmail } from "./credential-rules";
import { removeDocRecord } from "./credential-service";

/* In-app account deletion (SOW v2 A1) — the ONE home for its rules. Called from
   Better Auth's deleteUser.beforeDelete (lib/auth.ts); the web page and
   /api/account/deletion only read deletionBlockers. Bookings are financial
   records and are never deleted here. Nothing is auto-cancelled and no booking
   outcome is ever penalized (M-2). Never log keys, URLs or emails (V-2, D-1). */

export type DeletionUser = { id: string; email: string; accountType?: string | null };

export type Blocker =
  | { kind: "OPEN_BOOKING"; bookingId: string; state: BookingState }
  | { kind: "ADMIN_ACCOUNT" };

const isOpen = (state: string) => !TERMINAL_STATES.has(state as BookingState);

/** Why this account can't be deleted right now — empty means it can. */
export async function deletionBlockers(user: DeletionUser): Promise<Blocker[]> {
  // Operator accounts are provisioned and removed out-of-band (V-1).
  if (isAdminEmail(user.email, process.env.ADMIN_EMAILS)) return [{ kind: "ADMIN_ACCOUNT" }];

  const claim = await prisma.crewProfileClaim.findUnique({ where: { userId: user.id } });
  const rows = await prisma.booking.findMany({
    where: {
      OR: [{ boatUserId: user.id }, ...(claim ? [{ crewProfileId: claim.profileId }] : [])],
    },
    orderBy: { requestedAt: "desc" },
  });
  // Settle any elapsed 48h window first so a finished booking never blocks forever (P-2).
  const settled = await Promise.all(rows.filter((b) => isOpen(b.state)).map(withElapsedWindow));
  return settled
    .filter((b) => isOpen(b.state))
    .map((b) => ({ kind: "OPEN_BOOKING" as const, bookingId: b.id, state: b.state as BookingState }));
}

/** One plain sentence for a blocked attempt — shown by both apps. */
export function blockerMessage(blockers: Blocker[]): string {
  if (blockers.some((b) => b.kind === "ADMIN_ACCOUNT")) {
    return "Operator accounts can't be deleted here.";
  }
  return "Finish or cancel your open bookings before deleting your account.";
}

const blocked = (blockers: Blocker[]) =>
  new APIError("BAD_REQUEST", { message: blockerMessage(blockers) });

/** Everything that must happen before Better Auth removes the user row. Throws to
    abort; every step is idempotent, so a retry after a partial failure is safe. */
export async function prepareAccountDeletion(user: DeletionUser): Promise<void> {
  const blockers = await deletionBlockers(user);
  if (blockers.length > 0) throw blocked(blockers);

  // Documents: storage object first, then the row (V-2); verified ones keep the
  // metadata-only removal record (V-1). A failure here leaves the account whole.
  const docs = await prisma.credentialDoc.findMany({ where: { uploadedByUserId: user.id } });
  for (const doc of docs) await removeDocRecord(doc);

  const claim = await prisma.crewProfileClaim.findUnique({ where: { userId: user.id } });
  await prisma.$transaction(async (tx) => {
    if (claim) {
      // Closes the race with a request landing after the blocker check.
      const open = await tx.booking.count({
        where: { crewProfileId: claim.profileId, state: { notIn: [...TERMINAL_STATES] } },
      });
      if (open > 0) throw blocked([]);
    }
    await tx.accountDeletionRecord.upsert({
      where: { id: user.id },
      create: {
        id: user.id,
        accountType: user.accountType ?? "UNKNOWN",
        stripeAccountId: claim?.stripeAccountId ?? null,
      },
      update: {}, // a retry must never blank the Stripe id captured the first time
    });
    if (claim) await tx.crewProfileClaim.delete({ where: { userId: user.id } });
  });

  // Stripe close runs from the record, not the claim, so a retry still finds the
  // id. Failure never blocks deletion — the operator follows up from the record.
  const record = await prisma.accountDeletionRecord.findUnique({ where: { id: user.id } });
  if (record?.stripeAccountId && record.stripeCloseState !== "CLOSED") {
    let stripeCloseState: "CLOSED" | "FAILED" = "CLOSED";
    try {
      await closeRecipientAccount(record.stripeAccountId);
    } catch {
      stripeCloseState = "FAILED";
      console.error(`account deletion ${user.id}: Stripe account close failed — operator follow-up`);
    }
    await prisma.accountDeletionRecord.update({
      where: { id: user.id },
      data: { stripeCloseState },
    });
  }
}
