# In-App Account Deletion (SOW v2 A1) + CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in person can delete their own account from web and mobile; financial records survive; CI runs the repo's gates.

**Architecture:** Better Auth's `POST /api/auth/delete-user` is the single entry point. Its `beforeDelete` hook calls `apps/web/lib/account-deletion.ts`, which holds every rule (blockers, credential removal, claim removal, Stripe close). Web and mobile screens are thin wrappers plus one read-only route for blockers.

**Tech Stack:** Next.js 15, Better Auth 1.7.5, Prisma 6 / Postgres, Stripe SDK 22 (Accounts v2), Expo Router, vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-account-deletion-design.md`

**Ground rules for every task**
- Branch `feat/account-deletion`. Commit locally only — **never push** (a push to `main` deploys and runs `prisma migrate deploy` on production).
- Commit style: `[ai-assisted] <message> (<rule IDs>)`, ending with the `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` trailer.
- Copy rules: marketplace vocabulary only (M-1); never the word "escrow" in user-facing copy (G-1); never log s3 keys, URLs or emails (V-2, D-1).
- Web tests: `pnpm --filter web exec vitest run <path>`. Mobile: `pnpm --filter mobile exec vitest run <path>` (if the filter name differs, read `name` in `apps/mobile/package.json`).

## File map

| File | Action | Responsibility |
|---|---|---|
| `packages/db/prisma/schema.prisma` | modify | drop `Booking.boatUser` relation; add `AccountDeletionRecord` |
| `packages/db/prisma/migrations/20261125000000_account_deletion/migration.sql` | create | the migration |
| `packages/payments/src/connect.ts`, `index.ts` | modify | `closeRecipientAccount` |
| `packages/payments/src/connect.test.ts` | create | its test |
| `apps/web/lib/credential-service.ts` | modify | extract `removeDocRecord` |
| `apps/web/lib/account-deletion.ts` (+ `.test.ts`) | create | blockers + deletion steps |
| `apps/web/lib/auth.ts` | modify | enable `deleteUser`, wire `beforeDelete` |
| `apps/web/app/api/claim/route.ts` (+ test) | modify | booking-history guard |
| `apps/web/app/api/account/deletion/route.ts` (+ test) | create | blockers for mobile |
| `apps/web/components/delete-account-form.tsx` | create | password form (client) |
| `apps/web/app/account/delete/page.tsx` | create | web deletion page |
| `apps/web/app/account/page.tsx` | modify | entry panel |
| `apps/mobile/lib/account-deletion.ts` (+ `.test.ts`) | create | types + blocker copy |
| `apps/mobile/src/app/delete-account.tsx` | create | mobile screen |
| `apps/mobile/src/app/(tabs)/account.tsx` | modify | entry row |
| `.github/workflows/ci.yml` | create | CI |
| `docs/SOW-V2-AUDIT.md` | modify | A1 status + client defaults |

---

### Task 1: Schema and migration

**Files:** modify `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20261125000000_account_deletion/migration.sql`

- [ ] **Step 1: Edit the schema**

In `model User`, delete the line `bookings Booking[] @relation("BoatBookings")`.

In `model Booking`, replace

```prisma
  boatUserId    String
  boatUser      User   @relation("BoatBookings", fields: [boatUserId], references: [id], onDelete: Cascade)
```

with

```prisma
  // No User relation on purpose: bookings are financial records and must survive
  // account deletion (SOW v2 A1). The id stays as a pseudonymous reference.
  boatUserId    String
```

In `model CredentialDoc`, replace the trailing comment on the `uploadedBy` line
(`// TODO(account-deletion): ...`) with
`// account deletion removes the S3 object first (lib/account-deletion.ts); this cascade is only a backstop (V-2)`.

After `model CredentialDocDeletion`, add:

```prisma
// Account deletion audit (SOW v2 A1). Minimal operator trail: which account type
// was deleted and whether its Stripe recipient account closed. Id only for Stripe
// (P-1); no name, email, or any other personal field (D-1). No User relation on
// purpose — it must survive the deletion it records.
model AccountDeletionRecord {
  id               String   @id // the deleted user's id — retries can't double-log
  accountType      String
  stripeAccountId  String?
  stripeCloseState String? // "CLOSED" | "FAILED" | null (no Stripe account, or close not yet attempted)
  deletedAt        DateTime @default(now())

  @@map("account_deletion_record")
}
```

- [ ] **Step 2: Write the migration by hand** (local Postgres is not required)

```sql
-- DropForeignKey
ALTER TABLE "booking" DROP CONSTRAINT "booking_boatUserId_fkey";

-- CreateTable
CREATE TABLE "account_deletion_record" (
    "id" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "stripeAccountId" TEXT,
    "stripeCloseState" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_deletion_record_pkey" PRIMARY KEY ("id")
);
```

- [ ] **Step 3: Regenerate and check**

Run: `pnpm --filter @deckbook/db exec prisma validate && pnpm --filter @deckbook/db exec prisma generate`
Expected: "The schema at prisma/schema.prisma is valid" and "Generated Prisma Client".

Run: `grep -rn "boatUser\b" apps packages scripts --include=*.ts --include=*.tsx --include=*.mjs | grep -v node_modules | grep -v boatUserId`
Expected: no output (nothing used the relation).

If local Postgres is up (`docker compose up -d`), also run
`pnpm --filter @deckbook/db exec prisma migrate dev` and expect "Already in sync" after it applies; if Docker is not running, say so in the task report — do not skip silently.

- [ ] **Step 4: Run the suite, commit**

Run: `pnpm test` → all pass.

```bash
git add packages/db/prisma
git commit -m "[ai-assisted] feat(db): bookings survive account deletion — drop Booking→User FK, add AccountDeletionRecord (P-1, D-1)"
```

---

### Task 2: `closeRecipientAccount` in payments

**Files:** modify `packages/payments/src/connect.ts`, `packages/payments/src/index.ts`; create `packages/payments/src/connect.test.ts`

- [ ] **Step 1: Failing test** — `packages/payments/src/connect.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const close = vi.hoisted(() => vi.fn());
vi.mock("./stripe", () => ({
  stripeClient: () => ({ v2: { core: { accounts: { close } } } }),
}));

import { closeRecipientAccount } from "./connect";

beforeEach(() => vi.clearAllMocks());

describe("closeRecipientAccount", () => {
  it("closes the account with its recipient configuration", async () => {
    close.mockResolvedValue({ id: "acct_1" });
    await closeRecipientAccount("acct_1");
    expect(close).toHaveBeenCalledWith("acct_1", { applied_configurations: ["recipient"] });
  });
  it("propagates Stripe failures to the caller", async () => {
    close.mockRejectedValue(new Error("balance remaining"));
    await expect(closeRecipientAccount("acct_1")).rejects.toThrow("balance remaining");
  });
});
```

- [ ] **Step 2:** Run `pnpm --filter @deckbook/payments exec vitest run src/connect.test.ts` → FAIL (`closeRecipientAccount` is not exported).

- [ ] **Step 3: Implement** — append to `connect.ts`:

```ts
/** Account deletion (SOW v2 A1): removes platform access to the crew member's
    recipient account. Stripe requires every applied configuration to be named;
    ours is recipient-only. Throws on failure — the caller decides what that means. */
export async function closeRecipientAccount(accountId: string): Promise<void> {
  await stripeClient().v2.core.accounts.close(accountId, {
    applied_configurations: ["recipient"],
  });
}
```

In `index.ts` change the first export line to:

```ts
export { closeRecipientAccount, createExpressAccount, createOnboardingLink, payoutReadiness } from "./connect";
```

- [ ] **Step 4:** Re-run the test → PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/payments/src
git commit -m "[ai-assisted] feat(payments): closeRecipientAccount — Accounts v2 close for account deletion (P-1)"
```

---

### Task 3: Extract `removeDocRecord`

**Files:** modify `apps/web/lib/credential-service.ts`. Existing coverage: `apps/web/app/account/credential-actions.test.ts` and `apps/web/app/api/credentials/[id]/route.test.ts` pin `deleteDoc` behavior — this is a refactor under green tests.

- [ ] **Step 1:** Run `pnpm --filter web exec vitest run app/account/credential-actions.test.ts "app/api/credentials"` → PASS (baseline).

- [ ] **Step 2: Refactor.** Add `type CredentialDoc` to the db import
(`import { prisma, type CredentialDoc } from "@deckbook/db";` — if the package does not re-export model types, use `import type { CredentialDoc } from "@prisma/client";` the way `Booking` is imported in `lib/bookings.ts`).

Insert above `deleteDoc`:

```ts
/** Storage-first removal of one document — shared by owner Remove and account
    deletion; never re-implement it. S3 first: if that throws, the row survives and
    the caller can retry (V-2). A verified doc leaves the metadata-only
    CredentialDocDeletion record in the same transaction as the row delete, so a
    retry can never double-log or lose it. Callers do their own authorization. */
export async function removeDocRecord(doc: CredentialDoc): Promise<void> {
  await deleteObject(doc.s3Key);
  if (!doc.verifiedAt) {
    await prisma.credentialDoc.delete({ where: { id: doc.id } });
    return;
  }
  await prisma.$transaction([
    prisma.credentialDocDeletion.create({
      data: {
        id: doc.id,
        profileId: doc.profileId,
        uploadedByUserId: doc.uploadedByUserId,
        kind: doc.kind,
        licenseClass: doc.licenseClass,
        expiresAt: doc.expiresAt,
        uploadedAt: doc.uploadedAt,
        verifiedAt: doc.verifiedAt,
        verifiedByEmail: doc.verifiedByEmail,
      },
    }),
    prisma.credentialDoc.delete({ where: { id: doc.id } }),
  ]);
}
```

Replace the body of `deleteDoc` after its authorization check with:

```ts
  await removeDocRecord(doc);
  return {};
```

- [ ] **Step 3:** Re-run the Step 1 command → PASS, same count.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/credential-service.ts
git commit -m "[ai-assisted] refactor(credentials): extract removeDocRecord for reuse by account deletion — no behavior change (V-1, V-2)"
```

---

### Task 4: `account-deletion.ts` — blockers

**Files:** create `apps/web/lib/account-deletion.ts`, `apps/web/lib/account-deletion.test.ts`

- [ ] **Step 1: Failing tests** — `account-deletion.test.ts`

```ts
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
    removeDocRecord: vi.fn(async () => undefined),
    closeRecipientAccount: vi.fn(async () => undefined),
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

beforeEach(() => {
  vi.clearAllMocks();
  seams.order.length = 0;
  delete process.env.ADMIN_EMAILS;
  seams.prisma.booking.findMany.mockResolvedValue([]);
  seams.prisma.crewProfileClaim.findUnique.mockResolvedValue(null);
  seams.prisma.credentialDoc.findMany.mockResolvedValue([]);
  seams.prisma.accountDeletionRecord.findUnique.mockResolvedValue(null);
  seams.tx.booking.count.mockResolvedValue(0);
  seams.withElapsedWindow.mockImplementation(async (b: unknown) => b);
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
```

- [ ] **Step 2:** Run `pnpm --filter web exec vitest run lib/account-deletion.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `apps/web/lib/account-deletion.ts`

```ts
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
```

(`APIError`, `closeRecipientAccount`, `removeDocRecord` are used in Task 5; if the linter flags them now, add them in Task 5 instead.)

If `TERMINAL_STATES` is not exported from `@deckbook/types`, check `packages/types/src/index.ts` for how `transition` is re-exported and export it the same way.

- [ ] **Step 4:** Re-run → PASS (all `deletionBlockers` tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/account-deletion.ts apps/web/lib/account-deletion.test.ts
git commit -m "[ai-assisted] feat(account): deletion blockers — open bookings and operator accounts block, elapsed windows settle first (M-2, P-2)"
```

---

### Task 5: `account-deletion.ts` — deletion steps

**Files:** modify `apps/web/lib/account-deletion.ts`, `apps/web/lib/account-deletion.test.ts`

Order (each step idempotent; any throw leaves the user row in place):
1. blockers → throw
2. credential documents, storage-first
3. one transaction: re-check open bookings on the claimed profile, upsert the record, delete the claim
4. Stripe close, driven **from the record** so a retry after the claim is gone still closes it; failure is recorded, never thrown

- [ ] **Step 1: Failing tests** — append to `account-deletion.test.ts`

```ts
describe("prepareAccountDeletion", () => {
  const CLAIM = { profileId: "p1", userId: "u-crew", stripeAccountId: "acct_1" };
  const DOC_A = { id: "d1", s3Key: "credentials/p1/d1.pdf", verifiedAt: null };
  const DOC_B = { id: "d2", s3Key: "credentials/p1/d2.pdf", verifiedAt: new Date() };

  function crewWithEverything() {
    seams.prisma.crewProfileClaim.findUnique.mockResolvedValue(CLAIM);
    seams.prisma.credentialDoc.findMany.mockResolvedValue([DOC_A, DOC_B]);
    seams.prisma.accountDeletionRecord.findUnique.mockResolvedValue({
      id: "u-crew", stripeAccountId: "acct_1", stripeCloseState: null,
    });
    seams.removeDocRecord.mockImplementation(async () => { seams.order.push("doc"); });
    seams.prisma.$transaction.mockImplementation(async (fn: (t: typeof seams.tx) => Promise<unknown>) => {
      seams.order.push("tx");
      return fn(seams.tx);
    });
    seams.closeRecipientAccount.mockImplementation(async () => { seams.order.push("stripe"); });
  }

  it("throws and touches nothing when blocked", async () => {
    seams.prisma.booking.findMany.mockResolvedValue([{ id: "b1", state: "ACCEPTED" }]);
    await expect(prepareAccountDeletion(BOAT)).rejects.toThrow(
      "Finish or cancel your open bookings before deleting your account.",
    );
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
      where: { id: "u-crew" }, data: { stripeCloseState: "CLOSED" },
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
    await expect(prepareAccountDeletion(CREW)).rejects.toThrow(
      "Finish or cancel your open bookings before deleting your account.",
    );
    expect(seams.tx.booking.count).toHaveBeenCalledWith({
      where: {
        crewProfileId: "p1",
        state: { notIn: ["PAID_OUT", "CANCELLED_WEATHER", "CANCELLED_BOAT", "CANCELLED_CREW"] },
      },
    });
    expect(seams.tx.crewProfileClaim.delete).not.toHaveBeenCalled();
    expect(seams.closeRecipientAccount).not.toHaveBeenCalled();
  });

  it("a Stripe failure is recorded and does not block deletion", async () => {
    crewWithEverything();
    seams.closeRecipientAccount.mockRejectedValue(new Error("balance remaining"));
    await expect(prepareAccountDeletion(CREW)).resolves.toBeUndefined();
    expect(seams.prisma.accountDeletionRecord.update).toHaveBeenCalledWith({
      where: { id: "u-crew" }, data: { stripeCloseState: "FAILED" },
    });
  });

  it("retry after the claim is gone still closes Stripe from the record", async () => {
    seams.prisma.crewProfileClaim.findUnique.mockResolvedValue(null);
    seams.prisma.accountDeletionRecord.findUnique.mockResolvedValue({
      id: "u-crew", stripeAccountId: "acct_1", stripeCloseState: "FAILED",
    });
    await prepareAccountDeletion(CREW);
    expect(seams.tx.crewProfileClaim.delete).not.toHaveBeenCalled();
    expect(seams.closeRecipientAccount).toHaveBeenCalledWith("acct_1");
  });

  it("does not close an account already recorded as closed", async () => {
    seams.prisma.accountDeletionRecord.findUnique.mockResolvedValue({
      id: "u-crew", stripeAccountId: "acct_1", stripeCloseState: "CLOSED",
    });
    await prepareAccountDeletion(CREW);
    expect(seams.closeRecipientAccount).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2:** Run the file → the new `describe` FAILS (`prepareAccountDeletion` is not exported).

- [ ] **Step 3: Implement** — append to `account-deletion.ts`

```ts
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
```

`blocked([])` yields the open-bookings sentence (no `ADMIN_ACCOUNT` entry) — intended.

- [ ] **Step 4:** Re-run the file → PASS (all tests). If a `toHaveBeenCalledWith` on `notIn` fails on ordering, compare against `[...TERMINAL_STATES]` imported from `@deckbook/types` in the test instead of the literal array.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/account-deletion.ts apps/web/lib/account-deletion.test.ts
git commit -m "[ai-assisted] feat(account): deletion steps — storage-first documents, record + claim in one transaction, Stripe close recorded not blocking (P-1, V-1, V-2, D-1)"
```

---

### Task 6: Wire Better Auth

**Files:** modify `apps/web/lib/auth.ts`

- [ ] **Step 1:** Add the import: `import { prepareAccountDeletion } from "./account-deletion";`

Inside `user: { ... }`, after `additionalFields`, add:

```ts
    // In-app account deletion (SOW v2 A1). Both apps send the password; without one
    // Better Auth only accepts a session younger than freshAge. All rules live in
    // lib/account-deletion.ts — a throw there aborts and leaves the account whole.
    // Arrow wrapper on purpose: account-deletion → bookings → auth is an import
    // cycle, so the binding must be read at call time, not at module load.
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        const u = user as typeof user & { accountType?: string };
        await prepareAccountDeletion({ id: u.id, email: u.email, accountType: u.accountType });
      },
    },
```

- [ ] **Step 2:** Run `pnpm --filter web test` → all pass. Run `pnpm --filter web build` → compiles (this is the check that the import cycle and types hold; web tsconfig is non-strict, so the build is the gate).

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/auth.ts
git commit -m "[ai-assisted] feat(auth): enable self-service account deletion behind prepareAccountDeletion (SOW v2 A1; M-2, V-2)"
```

---

### Task 7: Claim guard for profiles with booking history

**Files:** modify `apps/web/app/api/claim/route.ts`, `apps/web/app/api/claim/route.test.ts`

- [ ] **Step 1: Failing test.** In `route.test.ts`: add `booking: { count: vi.fn() },` to `seams.prisma`; add `seams.prisma.booking.count.mockResolvedValue(0);` to `beforeEach`; add:

```ts
  it("409 when the profile has booking history from a previous account", async () => {
    seams.prisma.booking.count.mockResolvedValue(3);
    const res = await post({ profileId: "p-known" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This profile has booking history and can't be claimed here.",
    });
    expect(seams.prisma.crewProfileClaim.create).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2:** Run `pnpm --filter web exec vitest run app/api/claim/route.test.ts` → the new test FAILS (200).

- [ ] **Step 3: Implement.** In `route.ts` extend the `Promise.all`:

```ts
  const [mine, taken, docCount, bookingCount] = await Promise.all([
    prisma.crewProfileClaim.findUnique({ where: { userId: user.id } }),
    prisma.crewProfileClaim.findUnique({ where: { profileId } }),
    prisma.credentialDoc.count({ where: { profileId } }),
    prisma.booking.count({ where: { crewProfileId: profileId } }),
  ]);
```

and after the `docCount` guard add:

```ts
  if (bookingCount > 0) {
    // Bookings are keyed to the profile, not the person. After an account deletion
    // frees a claim, a new claimant must never inherit the previous person's
    // booking ledger (D-1).
    return Response.json(
      { error: "This profile has booking history and can't be claimed here." },
      { status: 409 }
    );
  }
```

- [ ] **Step 4:** Re-run → PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/claim
git commit -m "[ai-assisted] fix(claim): a profile with booking history can't be self-claimed — no inherited ledgers after account deletion (D-1)"
```

---

### Task 8: `GET /api/account/deletion`

**Files:** create `apps/web/app/api/account/deletion/route.ts`, `route.test.ts`

- [ ] **Step 1: Failing test** — `route.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ getSession: vi.fn(), deletionBlockers: vi.fn() }));

vi.mock("../../../../lib/auth", () => ({ auth: { api: { getSession: seams.getSession } } }));
vi.mock("../../../../lib/account-deletion", () => ({ deletionBlockers: seams.deletionBlockers }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));

import { GET } from "./route";

const USER = { id: "u1", email: "c@x.test", accountType: "CREW" };

beforeEach(() => {
  vi.clearAllMocks();
  seams.getSession.mockResolvedValue({ user: USER });
  seams.deletionBlockers.mockResolvedValue([]);
});

describe("GET /api/account/deletion", () => {
  it("401 when signed out", async () => {
    seams.getSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
  it("canDelete true with no blockers", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canDelete: true, blockers: [] });
    expect(seams.deletionBlockers).toHaveBeenCalledWith({ id: "u1", email: "c@x.test", accountType: "CREW" });
  });
  it("canDelete false and lists blockers", async () => {
    const blockers = [{ kind: "OPEN_BOOKING", bookingId: "b1", state: "ACCEPTED" }];
    seams.deletionBlockers.mockResolvedValue(blockers);
    expect(await (await GET()).json()).toEqual({ canDelete: false, blockers });
  });
});
```

- [ ] **Step 2:** Run `pnpm --filter web exec vitest run app/api/account/deletion/route.test.ts` → FAIL (no route).

- [ ] **Step 3: Implement** — `route.ts`

```ts
import { headers } from "next/headers";
import { auth } from "../../../../lib/auth";
import { deletionBlockers } from "../../../../lib/account-deletion";

export const dynamic = "force-dynamic";

/* Read-only: what currently blocks deleting this account (SOW v2 A1). The delete
   itself is Better Auth's POST /api/auth/delete-user; rules live in
   lib/account-deletion.ts. */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return new Response("sign in required", { status: 401 });
  const u = session.user as { id: string; email: string; accountType?: string };
  const blockers = await deletionBlockers({ id: u.id, email: u.email, accountType: u.accountType });
  return Response.json({ canDelete: blockers.length === 0, blockers });
}
```

- [ ] **Step 4:** Re-run → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/account
git commit -m "[ai-assisted] feat(api): GET /api/account/deletion — blockers for the mobile delete screen (SOW v2 A1)"
```

---

### Task 9: Web screens

**Files:** create `apps/web/components/delete-account-form.tsx`, `apps/web/app/account/delete/page.tsx`; modify `apps/web/app/account/page.tsx`

Read `docs/DESIGN.md` (and root `DESIGN.md`) first. The palette has no red: destructive actions use the existing `btn btn--ghost-ink`, the same weight as other secondary actions. Reuse existing classes (`account__panel`, `account__lede`, `eyebrow`, `field`, `field__label`, `auth__error`, `auth__error-label`, `btn`); add no new CSS unless the page is visibly broken.

- [ ] **Step 1: Client form** — `components/delete-account-form.tsx`

```tsx
"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "../lib/auth-client";

/* Final step of account deletion (SOW v2 A1). Password re-entry is the
   confirmation; the server re-checks every rule (lib/account-deletion.ts). */
export function DeleteAccountForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    const { error: err } = await authClient.deleteUser({ password });
    if (err) {
      setError(
        err.code === "INVALID_PASSWORD"
          ? "That password didn't match."
          : err.message ?? "Couldn't delete your account — try again.",
      );
      setPending(false);
      // A blocked attempt means the list above is stale — re-render it.
      router.refresh();
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form className="auth__form" onSubmit={onSubmit}>
      <label className="field">
        <span className="field__label">Password</span>
        <input type="password" name="password" autoComplete="current-password" required disabled={pending} />
        <span className="field__hint">Enter your password to confirm. This can&apos;t be undone.</span>
      </label>
      {error ? (
        <p className="auth__error" role="alert">
          <span className="auth__error-label">Not deleted</span>
          {error}
        </p>
      ) : null}
      <button className="btn btn--ghost-ink" type="submit" disabled={pending}>
        {pending ? "Deleting…" : "Delete my account"}
      </button>
    </form>
  );
}
```

Check how `SignInForm` in `components/auth-forms.tsx` reads the error code (`err.code` vs `err.message`) and match it.

- [ ] **Step 2: Page** — `app/account/delete/page.tsx`

```tsx
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Container } from "@deckbook/ui";
import { auth } from "../../../lib/auth";
import { deletionBlockers } from "../../../lib/account-deletion";
import { DeleteAccountForm } from "../../../components/delete-account-form";

/* Account deletion (SOW v2 A1). States plainly what goes and what stays — no
   retention prompts, nothing that pressures the choice. Marketplace vocabulary
   only (M-1); "funds held", never the E-word (G-1). */

export const metadata = { title: "Delete account — DECKBOOK" };

const STATE_LABELS: Record<string, string> = {
  REQUESTED: "Requested",
  ACCEPTED: "Accepted",
  ESCROW_FUNDED: "Funds held",
  IN_PROGRESS: "Underway",
  COMPLETED: "Trip complete",
  DISPUTE_WINDOW: "48h review",
};

export default async function DeleteAccount() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?from=/account/delete");
  const u = session.user as { id: string; email: string; accountType?: string };
  const blockers = await deletionBlockers({ id: u.id, email: u.email, accountType: u.accountType });
  const openBookings = blockers.filter((b) => b.kind === "OPEN_BOOKING");
  const isOperator = blockers.some((b) => b.kind === "ADMIN_ACCOUNT");
  const isCrew = u.accountType === "CREW";

  return (
    <main className="account">
      <Container wide>
        <div className="account__head">
          <div>
            <span className="eyebrow">ACCOUNT · DELETE</span>
            <h1 className="account__name">Delete your account</h1>
          </div>
          <a className="btn btn--ghost-ink" href="/account">Back to account</a>
        </div>

        <div className="account__panel">
          <span className="eyebrow">WHAT IS REMOVED</span>
          <p className="account__lede">
            Your sign-in, name and email.
            {isCrew
              ? " Your uploaded credential documents, your link to your board profile, and our connection to your Stripe payout account."
              : ""}
          </p>
          <span className="eyebrow">WHAT IS KEPT</span>
          <p className="account__lede">
            Records of past bookings — dates, amounts and payment references — are kept as
            financial records, with no name or email attached.
            {isCrew
              ? " If a verified credential is removed, a note that it existed and was removed is kept; the document itself is not."
              : ""}
          </p>
        </div>

        <div className="account__panel">
          {isOperator ? (
            <p className="account__lede">Operator accounts can&apos;t be deleted here.</p>
          ) : openBookings.length > 0 ? (
            <>
              <span className="eyebrow">FINISH THESE FIRST</span>
              <p className="account__lede">
                An account with open bookings can&apos;t be deleted. Finish or cancel each one,
                then come back.
              </p>
              <ul className="account__upcoming">
                {openBookings.map((b) =>
                  b.kind === "OPEN_BOOKING" ? (
                    <li key={b.bookingId}>
                      <span className="account__upcoming-label">{STATE_LABELS[b.state] ?? b.state}</span>
                      <a href={`/bookings/${b.bookingId}`}>Open this booking</a>
                    </li>
                  ) : null,
                )}
              </ul>
            </>
          ) : (
            <DeleteAccountForm />
          )}
        </div>
      </Container>
    </main>
  );
}
```

Confirm the booking detail route is `/bookings/[id]` (`ls apps/web/app/bookings`); adjust the href if not. If `@deckbook/ui` already exports a state-label map or `BookingStateBadge` usable here, use it instead of the local `STATE_LABELS`.

- [ ] **Step 3: Entry panel.** In `app/account/page.tsx`, after the closing `</div>` of the `account__panel--upcoming` block and before `</Container>`, add:

```tsx
        <div className="account__panel">
          <span className="eyebrow">DELETE ACCOUNT</span>
          <p className="account__lede">
            Remove your sign-in and personal details from DECKBOOK. You&apos;ll see exactly what
            is removed and what is kept before anything happens.
          </p>
          <a className="btn btn--ghost-ink" href="/account/delete">Delete account</a>
        </div>
```

- [ ] **Step 4: Gates.** Run `pnpm --filter web lint && pnpm --filter web build && pnpm compliance:check` → all clean ("classification-lint: clean (M-1 gate passed)").

- [ ] **Step 5: See it.** If local Postgres/Docker is available: `pnpm --filter web dev`, sign up a throwaway boat account, open `/account/delete`, delete with a wrong password (expect "That password didn't match."), then the right one (expect redirect to `/`, signed out, sign-in with the old credentials fails). If Docker is not running, report this step as NOT RUN — do not claim it.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/delete-account-form.tsx apps/web/app/account
git commit -m "[ai-assisted] feat(web): delete-account page — states what is removed and kept, lists blocking bookings, password confirmation (SOW v2 A1; M-1, G-1, P-4)"
```

---

### Task 10: Mobile helper

**Files:** create `apps/mobile/lib/account-deletion.ts`, `apps/mobile/lib/account-deletion.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { blockerLine, deleteErrorMessage, type DeletionStatus } from "./account-deletion";

describe("blockerLine", () => {
  it("labels an open booking with the shared state vocabulary", () => {
    expect(blockerLine({ kind: "OPEN_BOOKING", bookingId: "b1", state: "ESCROW_FUNDED" }))
      .toBe("Funds held — open booking");
  });
  it("falls back to the raw state for an unknown one", () => {
    expect(blockerLine({ kind: "OPEN_BOOKING", bookingId: "b1", state: "NEW_STATE" }))
      .toBe("NEW_STATE — open booking");
  });
  it("explains an operator account", () => {
    expect(blockerLine({ kind: "ADMIN_ACCOUNT" })).toBe("Operator accounts can't be deleted here.");
  });
});

describe("deleteErrorMessage", () => {
  it("maps a wrong password", () => {
    expect(deleteErrorMessage({ code: "INVALID_PASSWORD", message: "Invalid password" }))
      .toBe("That password didn't match.");
  });
  it("passes the server's sentence through", () => {
    expect(deleteErrorMessage({ message: "Finish or cancel your open bookings before deleting your account." }))
      .toBe("Finish or cancel your open bookings before deleting your account.");
  });
  it("falls back when there is nothing usable", () => {
    expect(deleteErrorMessage(null)).toBe("Couldn't delete your account — try again.");
  });
});

// type-only: the wire shape of GET /api/account/deletion
const _shape: DeletionStatus = { canDelete: true, blockers: [] };
void _shape;
```

- [ ] **Step 2:** Run `pnpm --filter mobile exec vitest run lib/account-deletion.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `apps/mobile/lib/account-deletion.ts`

```ts
// Pure helpers for the delete-account screen (no RN imports). Wire shape mirrors
// apps/web/lib/account-deletion.ts — keep them in step. Copy: marketplace
// vocabulary only (M-1); state labels come from booking-labels (G-1).
import { STATE_LABELS } from "./booking-labels";
import { serverError } from "./server-error";

export type Blocker =
  | { kind: "OPEN_BOOKING"; bookingId: string; state: string }
  | { kind: "ADMIN_ACCOUNT" };

export type DeletionStatus = { canDelete: boolean; blockers: Blocker[] };

export function blockerLine(b: Blocker): string {
  if (b.kind === "ADMIN_ACCOUNT") return "Operator accounts can't be deleted here.";
  return `${STATE_LABELS[b.state] ?? b.state} — open booking`;
}

export function deleteErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "INVALID_PASSWORD") {
    return "That password didn't match.";
  }
  return serverError(error) ?? "Couldn't delete your account — try again.";
}
```

- [ ] **Step 4:** Re-run → PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/account-deletion.ts apps/mobile/lib/account-deletion.test.ts
git commit -m "[ai-assisted] feat(mobile): account-deletion helpers — blocker copy and delete error mapping (M-1, G-1)"
```

---

### Task 11: Mobile screen and entry row

**Files:** create `apps/mobile/src/app/delete-account.tsx`; modify `apps/mobile/src/app/(tabs)/account.tsx`

Read `apps/mobile/src/app/credentials.tsx` first and follow its conventions (auth guard, `authClient.$fetch` with absolute `API_URL`, `Stack.Screen` title, styles from `lib/tokens`).

- [ ] **Step 1:** Confirm `authClient.deleteUser` exists on the Expo client (`grep -n "deleteUser" apps/mobile/node_modules/better-auth/dist/client/*.d.mts | head -3` or rely on the Step 4 typecheck). Screens call it directly, as they do `authClient.$fetch`.

- [ ] **Step 2: Screen** — `src/app/delete-account.tsx`

```tsx
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { authClient, useSession } from "../../lib/auth-client";
import { API_URL } from "../../lib/api";
import { authGuardState } from "../../lib/auth-guard";
import { blockerLine, deleteErrorMessage, type DeletionStatus } from "../../lib/account-deletion";
import { confirmDestructive } from "../../lib/confirm";
import { color, font, radius, space } from "../../lib/tokens";

/* Delete account (SOW v2 A1). Says plainly what is removed and what is kept, lists
   anything blocking, and confirms with the password. Every rule is enforced by the
   server (apps/web/lib/account-deletion.ts) — this screen only presents.
   Marketplace vocabulary only (M-1); no pressure copy (P-4). */

type Load = { kind: "loading" } | { kind: "error" } | { kind: "ready"; status: DeletionStatus };

export default function DeleteAccountScreen() {
  const router = useRouter();
  const { data: session, isPending, error: sessionError } = useSession();
  const gate = authGuardState({ isPending, session, error: sessionError });
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isCrew = (session?.user as { accountType?: string } | undefined)?.accountType === "CREW";

  const fetchStatus = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const { data, error } = await authClient.$fetch<DeletionStatus>(`${API_URL}/api/account/deletion`);
      setLoad(error || !data ? { kind: "error" } : { kind: "ready", status: data });
    } catch {
      setLoad({ kind: "error" });
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (gate === "SIGNED_OUT" && !busy) {
        router.replace("/sign-in");
        return;
      }
      if (gate === "SIGNED_IN") void fetchStatus();
    }, [gate, busy, router, fetchStatus]),
  );

  async function onDelete() {
    if (busy || !password) return;
    const ok = await confirmDestructive({
      title: "Delete your account?",
      message: "This removes your sign-in and personal details. It can't be undone.",
      confirmLabel: "Delete account",
      cancelLabel: "Keep account",
    });
    if (!ok) return;
    setBusy(true);
    setFormError(null);
    try {
      const { error } = await authClient.deleteUser({ password });
      if (error) {
        setFormError(deleteErrorMessage(error));
        void fetchStatus(); // a blocked attempt means the list is stale
        return;
      }
      router.replace("/");
    } catch (err) {
      setFormError(deleteErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: "Delete account" }} />

      <View style={styles.panel}>
        <Text style={styles.eyebrow}>WHAT IS REMOVED</Text>
        <Text style={styles.body}>
          Your sign-in, name and email.
          {isCrew
            ? " Your uploaded credential documents, your link to your board profile, and our connection to your Stripe payout account."
            : ""}
        </Text>
        <Text style={styles.eyebrow}>WHAT IS KEPT</Text>
        <Text style={styles.body}>
          Records of past bookings — dates, amounts and payment references — are kept as financial
          records, with no name or email attached.
          {isCrew
            ? " If a verified credential is removed, a note that it existed and was removed is kept; the document itself is not."
            : ""}
        </Text>
      </View>

      <View style={styles.panel}>
        {(gate === "CHECKING" || load.kind === "loading") && (
          <View style={styles.inline}>
            <ActivityIndicator color={color.navyDeep} />
            <Text style={styles.muted}>Checking your bookings…</Text>
          </View>
        )}

        {load.kind === "error" && gate !== "CHECKING" && (
          <>
            <Text style={styles.muted}>Couldn&apos;t check your account — try again.</Text>
            <Pressable style={styles.button} onPress={() => void fetchStatus()} accessibilityRole="button">
              <Text style={styles.buttonText}>Retry</Text>
            </Pressable>
          </>
        )}

        {load.kind === "ready" && !load.status.canDelete && (
          <>
            <Text style={styles.eyebrow}>FINISH THESE FIRST</Text>
            <Text style={styles.body}>
              An account with open bookings can&apos;t be deleted. Finish or cancel each one, then
              come back.
            </Text>
            {load.status.blockers.map((b, i) =>
              b.kind === "OPEN_BOOKING" ? (
                <Pressable
                  key={b.bookingId}
                  style={styles.row}
                  onPress={() => router.push(`/bookings/${b.bookingId}`)}
                  accessibilityRole="button"
                >
                  <Text style={styles.rowText}>{blockerLine(b)}</Text>
                  <Text style={styles.rowChevron}>›</Text>
                </Pressable>
              ) : (
                <Text key={`b${i}`} style={styles.body}>{blockerLine(b)}</Text>
              ),
            )}
          </>
        )}

        {load.kind === "ready" && load.status.canDelete && (
          <>
            <Text style={styles.eyebrow}>CONFIRM WITH YOUR PASSWORD</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="current-password"
              textContentType="password"
              placeholder="Password"
              placeholderTextColor={color.inkSoft}
              editable={!busy}
              accessibilityLabel="Password"
            />
            {formError && <Text style={styles.error} accessibilityRole="alert">{formError}</Text>}
            <Pressable
              style={[styles.button, (busy || !password) && styles.buttonDisabled]}
              onPress={onDelete}
              disabled={busy || !password}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || !password }}
            >
              <Text style={styles.buttonText}>{busy ? "Deleting…" : "Delete my account"}</Text>
            </Pressable>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.boardBg },
  content: { paddingBottom: space.s7 },
  panel: {
    backgroundColor: color.whiteCrisp,
    marginTop: space.s3,
    marginHorizontal: space.s3,
    padding: space.s5,
    gap: space.s3,
    borderWidth: 1,
    borderColor: color.lineOnWhite,
    borderRadius: radius,
  },
  eyebrow: {
    fontFamily: font.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    color: color.inkSoft,
    textTransform: "uppercase",
  },
  body: { fontFamily: font.body, fontSize: 14, lineHeight: 20, color: color.ink },
  muted: { fontFamily: font.body, fontSize: 13, color: color.inkSoft },
  inline: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  row: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: color.brass,
    borderRadius: radius,
    paddingHorizontal: space.s4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowText: { fontFamily: font.body, fontSize: 14, color: color.ink, flexShrink: 1 },
  rowChevron: { fontFamily: font.body, fontSize: 20, color: color.brassText },
  input: {
    borderWidth: 1,
    borderColor: color.lineOnWhite,
    borderRadius: radius,
    minHeight: 48,
    paddingHorizontal: space.s3,
    fontFamily: font.body,
    fontSize: 15,
    color: color.ink,
  },
  error: { fontFamily: font.body, fontSize: 14, color: color.ink },
  button: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    borderWidth: 1,
    borderColor: color.brass,
    borderRadius: radius,
    paddingVertical: space.s3,
    paddingHorizontal: space.s5,
    backgroundColor: color.whiteCrisp,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { fontFamily: font.body, fontSize: 15, fontWeight: "600", color: color.brassText },
});
```

The Account tab's `useFocusEffect` already redirects only when its own tab is focused, so the post-delete `router.replace("/")` lands on the board signed out.

- [ ] **Step 3: Entry row.** In `(tabs)/account.tsx`, directly after the Sign out `</Pressable>` add:

```tsx
      <Pressable
        style={styles.deleteLink}
        onPress={() => router.push("/delete-account")}
        accessibilityRole="button"
      >
        <Text style={styles.deleteLinkText}>Delete account</Text>
      </Pressable>
```

and to `styles`:

```ts
  deleteLink: {
    marginTop: space.s4,
    marginHorizontal: space.s3,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteLinkText: {
    fontFamily: font.body,
    fontSize: 14,
    color: color.inkSoft,
    textDecorationLine: "underline",
  },
```

Also update that file's header comment: replace "this is identity + a way out" with "this is identity, a way out, and the entry to account deletion (SOW v2 A1)".

- [ ] **Step 4: Gates.** Run `pnpm --filter mobile lint && pnpm --filter mobile test` → clean. Run `pnpm --filter mobile exec tsc --noEmit` → no errors (if the package has no such script path, run the typecheck the way `apps/mobile/package.json` defines it). Run `pnpm compliance:check` → clean.

Device behavior is NOT verified by these gates. Report it as unverified; it goes on the device-pass list in Task 13.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/app apps/mobile/lib
git commit -m "[ai-assisted] feat(mobile): delete-account screen + Account tab entry — blockers, password confirmation (SOW v2 A1; M-1, P-4)"
```

---

### Task 12: CI workflow

**Files:** create `.github/workflows/ci.yml`

- [ ] **Step 1: Write it**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      # Placeholders only — the build must not need real services or secrets.
      POSTGRES_PRISMA_URL: postgresql://ci:ci@localhost:5432/ci
      DATABASE_URL_UNPOOLED: postgresql://ci:ci@localhost:5432/ci
      BETTER_AUTH_SECRET: ci-placeholder-secret-not-used-anywhere
      BETTER_AUTH_URL: http://localhost:3000
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Compliance lint (M-1, rule G-2)
        run: pnpm compliance:check
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build
```

`pnpm/action-setup@v4` reads the version from `packageManager` in the root `package.json`. Confirm `.nvmrc` exists at the repo root (`cat .nvmrc`); if it does not, replace `node-version-file` with `node-version: 22`.

- [ ] **Step 2: Prove it locally with the same env**

```bash
env -i HOME="$HOME" PATH="$PATH" \
  POSTGRES_PRISMA_URL=postgresql://ci:ci@localhost:5432/ci \
  DATABASE_URL_UNPOOLED=postgresql://ci:ci@localhost:5432/ci \
  BETTER_AUTH_SECRET=ci-placeholder-secret-not-used-anywhere \
  BETTER_AUTH_URL=http://localhost:3000 \
  sh -c 'pnpm compliance:check && pnpm lint && pnpm test && pnpm build'
```

Expected: all four succeed. If `pnpm build` needs another variable at build time, add a placeholder for it to both this command and the workflow `env` — never a real value. If any step fails for a reason that predates this branch, fix it only if it is a one-line fix; otherwise stop and report.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "[ai-assisted] ci: build, tests, lint and the M-1 compliance lint on push and pull request (G-2)"
```

The workflow cannot be observed running until the branch is pushed. Say so in the report.

---

### Task 13: Records and final gates

**Files:** modify `docs/SOW-V2-AUDIT.md`, `docs/superpowers/specs/2026-11-25-account-deletion-design.md`

- [ ] **Step 1: Audit row.** Replace the A1 row's Status with `🟡` and its notes with:

`Built 11/25 on branch feat/account-deletion (not yet merged or deployed): Better Auth delete-user behind apps/web/lib/account-deletion.ts; open bookings and operator accounts block; credential objects removed storage-first; bookings kept as financial records (Booking→User FK dropped); AccountDeletionRecord keeps user id, account type and Stripe account id only; claim route refuses profiles with booking history. Web /account/delete and mobile delete-account screen. Not verified: mobile screen on a device; Stripe close against a real recipient account; migration 20261125000000_account_deletion not applied to production. ⛔ client to confirm in writing: immediate credential-document deletion, Stripe-close failure not blocking, privacy-policy line for retained records (B2).`

In "Housekeeping found during the audit", change the "No CI exists" bullet to: `CI added 11/25 (.github/workflows/ci.yml: compliance lint, lint, tests, build) — first run happens on push.`

- [ ] **Step 2: Spec.** The spec lists Stripe close as step 3 and the transaction as step 4; the build runs the transaction first and closes Stripe from the record. Swap those two numbered steps in "Deletion steps" and add "Stripe close reads the id from `AccountDeletionRecord`, so a retry after the claim is gone still closes it." Change the model comment for `stripeCloseState` to `"CLOSED" | "FAILED" | null (no Stripe account, or close not yet attempted)`.

- [ ] **Step 3: Full gates from the repo root**

Run: `pnpm compliance:check && pnpm lint && pnpm test && pnpm build`
Expected: all succeed. Record the test counts in the report.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "[ai-assisted] docs: A1 account deletion built, CI added — audit row, client defaults to confirm, spec step order matches the build (no rules touched)"
```

- [ ] **Step 5: Report, don't push.** State what was verified by command, what was not (device pass, live Stripe close, production migration, CI run), and that nothing has been pushed.
