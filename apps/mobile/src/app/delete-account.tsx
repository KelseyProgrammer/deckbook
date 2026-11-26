import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { authClient, useSession } from "../../lib/auth-client";
import { API_URL } from "../../lib/api";
import { authGuardState } from "../../lib/auth-guard";
import {
  blockerLine,
  deleteErrorMessage,
  type DeletionStatus,
} from "../../lib/account-deletion";
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
      // Absolute URL: authClient prepends its /api/auth base to relative paths.
      const { data, error } = await authClient.$fetch<DeletionStatus>(
        `${API_URL}/api/account/deletion`,
      );
      setLoad(error || !data ? { kind: "error" } : { kind: "ready", status: data });
    } catch {
      setLoad({ kind: "error" });
    }
  }, []);

  // Redirect only on the authoritative no-session answer, and never mid-delete
  // (a successful delete clears the session before we route home ourselves).
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
        setBusy(false);
        void fetchStatus(); // a blocked attempt means the list is stale
        return;
      }
      // busy stays latched: the session is gone and this screen is leaving.
      router.replace("/");
    } catch (err) {
      setFormError(deleteErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
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
        {gate === "UNKNOWN" || (gate !== "CHECKING" && load.kind === "error") ? (
          <>
            <Text style={styles.muted}>Couldn&apos;t check your account — try again.</Text>
            <Pressable
              style={styles.button}
              onPress={() => void fetchStatus()}
              accessibilityRole="button"
            >
              <Text style={styles.buttonText}>Retry</Text>
            </Pressable>
          </>
        ) : load.kind !== "ready" ? (
          <View style={styles.inline}>
            <ActivityIndicator color={color.navyDeep} />
            <Text style={styles.muted}>Checking your bookings…</Text>
          </View>
        ) : !load.status.canDelete ? (
          <>
            <Text style={styles.eyebrow}>
              {load.status.blockers.some((b) => b.kind === "OPEN_BOOKING")
                ? "FINISH THESE FIRST"
                : "NOT AVAILABLE"}
            </Text>
            {load.status.blockers.some((b) => b.kind === "OPEN_BOOKING") && (
              <Text style={styles.body}>
                An account with open bookings can&apos;t be deleted. Finish or cancel each one,
                then come back.
              </Text>
            )}
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
                <Text key={`blocker-${i}`} style={styles.body}>
                  {blockerLine(b)}
                </Text>
              ),
            )}
          </>
        ) : (
          <>
            <Text style={styles.eyebrow}>CONFIRM WITH YOUR PASSWORD</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              placeholder="Password"
              placeholderTextColor={color.inkSoft}
              editable={!busy}
              accessibilityLabel="Password"
            />
            {formError && (
              <Text style={styles.error} accessibilityRole="alert">
                {formError}
              </Text>
            )}
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
