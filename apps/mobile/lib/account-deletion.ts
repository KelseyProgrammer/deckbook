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
