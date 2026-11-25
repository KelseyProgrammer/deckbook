import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { expo } from "@better-auth/expo";
import { APIError } from "better-auth/api";
import { prisma } from "@deckbook/db";
import { prepareAccountDeletion } from "./account-deletion";
import { isAdminEmail } from "./credential-rules";

/* Accounts & Roles (SOW 2.i). Two account types only: CREW offers services, BOAT books
   them (M-1). ADMIN is never a signup option — operator accounts are promoted manually. */

export const ACCOUNT_TYPES = ["CREW", "BOAT"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true },
  trustedOrigins: [
    "deckbook://", // standalone / dev-client builds use the app scheme
    // Expo Go sends origin `exp://<lan-ip>:8081`. The @better-auth/expo plugin only
    // auto-trusts "exp://" when NODE_ENV==="development"; on Vercel (production) it
    // doesn't, so we trust it explicitly for the Expo Go device pass. DEV/DEMO ONLY —
    // remove before a real production launch (standalone builds use deckbook://).
    "exp://",
    "http://localhost:3000",
    "http://localhost:3002",
    "https://deckbook-web.vercel.app",
    "https://deckbook-demo.vercel.app", // DEV/DEMO ONLY — web-parity demo, remove before launch
  ],
  user: {
    additionalFields: {
      accountType: { type: "string", required: true, input: true },
      // Rule D-2: signup requires attesting the marketplace disclaimer.
      disclaimerAccepted: { type: "boolean", required: true, input: true },
      disclaimerAcceptedAt: { type: "date", required: false, input: false },
    },
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
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const u = user as typeof user & { accountType?: string; disclaimerAccepted?: boolean };
          if (isAdminEmail(u.email, process.env.ADMIN_EMAILS)) {
            // Admin accounts are provisioned out-of-band, never via self-signup —
            // otherwise anyone could register an allowlisted address and pass the
            // /admin gate (V-1).
            throw new APIError("BAD_REQUEST", { message: "This email can't be used for sign-up." });
          }
          if (!ACCOUNT_TYPES.includes(u.accountType as AccountType)) {
            throw new APIError("BAD_REQUEST", { message: "Choose a crew or boat account." });
          }
          if (u.disclaimerAccepted !== true) {
            throw new APIError("BAD_REQUEST", {
              message: "You must acknowledge the marketplace disclaimer to create an account.",
            });
          }
          return { data: { ...user, disclaimerAcceptedAt: new Date() } };
        },
      },
    },
  },
  plugins: [expo(), nextCookies()],
});

export type ServerSession = typeof auth.$Infer.Session;
