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
