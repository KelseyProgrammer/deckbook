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
      // A blocked attempt means the page's booking list is stale — re-render it.
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
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          disabled={pending}
        />
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
