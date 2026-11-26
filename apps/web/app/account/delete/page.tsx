import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BookingStateBadge, Container } from "@deckbook/ui";
import { auth } from "../../../lib/auth";
import { deletionBlockers } from "../../../lib/account-deletion";
import { DeleteAccountForm } from "../../../components/delete-account-form";

/* Account deletion (SOW v2 A1). States plainly what goes and what stays — no
   retention prompts, nothing that pressures the choice. Marketplace vocabulary
   only (M-1); booking states render through the shared badge (G-1). */

export const metadata = { title: "Delete account — DECKBOOK" };

export default async function DeleteAccount() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?from=/account/delete");
  const u = session.user as { id: string; email: string; accountType?: string };
  const blockers = await deletionBlockers({ id: u.id, email: u.email, accountType: u.accountType });
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
          <a className="btn btn--ghost-ink" href="/account">
            Back to account
          </a>
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
          ) : blockers.length > 0 ? (
            <>
              <span className="eyebrow">FINISH THESE FIRST</span>
              <p className="account__lede">
                An account with open bookings can&apos;t be deleted. Finish or cancel each one,
                then come back.
              </p>
              <ul className="account__upcoming">
                {blockers.map((b) =>
                  b.kind === "OPEN_BOOKING" ? (
                    <li key={b.bookingId}>
                      <BookingStateBadge state={b.state} />
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
