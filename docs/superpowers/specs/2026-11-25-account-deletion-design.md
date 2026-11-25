# In-App Account Deletion (SOW v2 A1) + CI — Design

**Date:** 2026-11-25 · **Status:** approved (approach, blocking rules, retention defaults user-approved in session)

Closes SOW v2 item A1: a signed-in person can delete their own account from the web app and the
mobile app. Both stores require this before submission. Adds the CI workflow the audit found missing.

## Approach

Better Auth's built-in `POST /api/auth/delete-user` (`user.deleteUser.enabled`) is the single entry
point for web and mobile. Its `beforeDelete` hook calls a new service,
`apps/web/lib/account-deletion.ts`, which holds every rule. Screens and routes are thin wrappers —
same discipline as `credential-service.ts`.

Re-authentication: both screens always send the password. Better Auth 1.7.5 verifies it when
present; a request with no password is accepted only from a session younger than `freshAge`
(default 1 day). No email verification step — the app has no mail sender.

Rejected: a custom delete route (re-implements password check and session teardown); soft delete
with a grace period (needs a scheduled job; none exists).

## Service: `apps/web/lib/account-deletion.ts`

```ts
type Blocker =
  | { kind: "OPEN_BOOKING"; bookingId: string; state: BookingState }
  | { kind: "ADMIN_ACCOUNT" };

deletionBlockers(user: { id; email; accountType }): Promise<Blocker[]>
prepareAccountDeletion(user): Promise<void>   // throws APIError("BAD_REQUEST") when blocked
```

### Blocking rules — `deletionBlockers`

1. `isAdminEmail(user.email, ADMIN_EMAILS)` → `ADMIN_ACCOUNT`. Operator accounts are provisioned
   and removed out-of-band.
2. Load the user's bookings: BOAT by `boatUserId`; CREW by the claimed `crewProfileId` (none if
   no claim). Each is passed through `withElapsedWindow` first, so a booking whose 48h window has
   passed settles (P-2) instead of blocking forever.
3. Any booking whose state is not in `TERMINAL_STATES` → `OPEN_BOOKING`.

Nothing is auto-cancelled; the person resolves each booking through the existing flow. No
decline/cancel penalty is introduced anywhere (M-2).

### Deletion steps — `prepareAccountDeletion`

Runs inside `beforeDelete`; any throw aborts and leaves the account intact. Every step is
idempotent, so a retry after a partial failure is safe.

1. `deletionBlockers` — non-empty → throw `APIError("BAD_REQUEST")` with a plain message.
2. Credential documents uploaded by the user: for each, storage object first, then the row;
   verified docs leave the existing `CredentialDocDeletion` metadata record (V-1, V-2, client
   policy 2026-10-06). The row-removal core of `deleteDoc` is extracted to a shared
   `removeDocRecord(doc)` in `credential-service.ts`; both callers use it.
3. Stripe recipient account, if the claim holds a `stripeAccountId`:
   `closeRecipientAccount(id)` (new, `packages/payments/src/connect.ts`) calls
   `v2.core.accounts.close(id, { applied_configurations: ["recipient"] })`. Failure does **not**
   block deletion; the outcome is recorded (step 4) for the operator. Only the account id is ever
   stored (P-1).
4. One transaction: re-count open bookings for the claimed profile (closes the race with a
   request arriving mid-delete; non-zero → abort), upsert `AccountDeletionRecord`, delete the
   `CrewProfileClaim`.
5. Return. Better Auth then deletes the user; `Session` and `Account` rows cascade.

## Schema (one Prisma migration)

- `Booking.boatUser` relation and `User.bookings` removed; `boatUserId` stays as a plain indexed
  column (same pattern as `crewProfileId` and `CredentialDocDeletion.uploadedByUserId`). Bookings
  are financial records and survive deletion with no name or email attached.
- The `TODO(account-deletion)` on `CredentialDoc.uploadedBy` is resolved by step 2; the cascade
  stays as a backstop.
- New model, no `User` relation:

```prisma
model AccountDeletionRecord {
  id               String   @id            // the deleted user's id — retries can't double-log
  accountType      String
  stripeAccountId  String?                 // id only (P-1)
  stripeCloseState String?                 // "CLOSED" | "FAILED" | null (no Stripe account)
  deletedAt        DateTime @default(now())
  @@map("account_deletion_record")
}
```

No name, email, or any D-1/D-3 data.

## Claim guard (privacy fix required by this feature)

Crew bookings are keyed to the seed profile. Once a claim is freed, the next claimant of that
profile would see the previous person's bookings. `POST /api/claim` gains a guard beside the
existing documents-on-file one: a profile with any `Booking` rows returns 409 "This profile has
booking history and can't be claimed here."

## Surfaces

- `GET /api/account/deletion` → `{ canDelete: boolean, blockers: Blocker[] }` (401 when signed
  out). Used by mobile; the web page calls the service directly.
- **Web:** "Delete account" panel at the bottom of `/account` → `/account/delete`: what is
  removed, what is kept (booking records without name/email; the verified-credential removal
  record), blockers with links to each booking, password field, one destructive button. On
  success: session cookie is cleared by Better Auth; redirect to `/`.
- **Mobile:** "Delete account" row on the Account tab → `src/app/delete-account.tsx`, same
  content, `authClient.deleteUser({ password })`; on success route to `/`.
- Copy: plain, no guilt or retention prompts (P-4), marketplace vocabulary only (M-1). D-2
  placement is unchanged.

## Errors

| Case | Result |
|---|---|
| Wrong password | Better Auth 400; screen shows "That password didn't match." |
| Blocked | 400 with blocker message; screen re-fetches and lists blockers |
| Storage delete fails | abort; account intact; "Couldn't delete your account — try again." |
| Stripe close fails | deletion proceeds; `stripeCloseState: "FAILED"` |

Never log document keys, presigned URLs, or email (V-2, D-1).

## Defaults for the client to confirm (recorded in SOW-V2-AUDIT)

1. Credential documents are deleted immediately on account deletion.
2. A failed Stripe close does not block deletion; the operator follows up from the record.
3. Retained booking rows and `AccountDeletionRecord` need a line in the privacy policy (B2,
   attorney wording).

## Testing (TDD, vitest)

- `account-deletion.test.ts`: blocker matrix across all ten booking states for BOAT and CREW;
  admin block; elapsed-window settlement; storage-first ordering; verified-doc record; Stripe
  failure path; transaction race abort; retry idempotency.
- `claim/route.test.ts`: booking-history guard.
- `api/account/deletion/route.test.ts`: 401, blocked, clear.
- `payments`: `closeRecipientAccount` passes the recipient configuration.
- Mobile: blocker-label helper test.
- Gates: `pnpm test`, `pnpm build` (web tsconfig is non-strict), `pnpm lint`,
  `pnpm compliance:check`.

## CI (separate commit)

`.github/workflows/ci.yml`, on push and pull request: pnpm install (frozen lockfile), Prisma
generate, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm compliance:check` (rule G-2). Build-time
env vars are placeholder values; no secrets.

## Out of scope

Privacy/terms/support links (A4), email confirmation of deletion, admin-initiated deletion,
purging demo accounts (B3).
