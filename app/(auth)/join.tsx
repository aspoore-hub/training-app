import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  acceptInvite,
  getAthleteInvitePreview,
  getMyClaimedAthleteProfileId,
  type AcceptInviteResult,
  type AthleteInvitePreview,
} from "../../lib/team";
import { bootstrapTeamSyncOnce } from "../../lib/bootstrapTeamSync";
import {
  listAccountContextsForCurrentUser,
  type AccountContext,
} from "../../lib/accountContexts";
import { switchAccountContext } from "../../lib/accountContextSwitch";
import { supabase } from "../../lib/supabase";

const SELECTED_ATHLETE_KEY = "training_app_selected_athlete_v1";

type JoinMode = "create" | "signin";
type SessionUser = { email: string | null } | null;

function firstString(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function friendlyInviteError(preview: AthleteInvitePreview | null, fallback?: string) {
  if (!preview) return fallback || "Could not load this invite.";
  if (preview.status === "expired") return "This invite has expired. Ask your coach for a new invite.";
  if (preview.status === "accepted") return "This invite has already been accepted.";
  if (preview.status === "invalid") return "This invite link is invalid. Ask your coach for a new invite.";
  return fallback || preview.error || "Could not load this invite.";
}

function isExistingUserError(error: any) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return message.includes("already") || message.includes("registered") || message.includes("exists");
}

function emailMismatchMessage(invitedEmail: string, signedInEmail: string) {
  return `This invite is for ${invitedEmail}. You are signed in as ${signedInEmail}. Please sign out and continue with the invited email.`;
}

export default function Join() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = useMemo(() => String(firstString(params.token) ?? "").trim(), [params.token]);

  const [preview, setPreview] = useState<AthleteInvitePreview | null>(null);
  const [sessionUser, setSessionUser] = useState<SessionUser>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<JoinMode>("create");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const autoClaimAttemptedRef = useRef(false);

  const inviteEmail = normalizeEmail(preview?.email);
  const activeEmail = normalizeEmail(sessionUser?.email);
  const emailLocked = !!inviteEmail;
  const emailMismatch = !!sessionUser && !!inviteEmail && activeEmail !== inviteEmail;
  const canCreate = email.trim().length > 3 && password.length >= 6 && confirmPassword.length >= 6 && !busy;
  const canSignIn = email.trim().length > 3 && password.length >= 6 && !busy;

  useEffect(() => {
    let cancelled = false;

    async function loadInvite() {
      setLoading(true);
      setErrorMessage(null);
      setMessage(null);
      autoClaimAttemptedRef.current = false;

      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (!cancelled) setSessionUser(data.session?.user ? { email: data.session.user.email ?? null } : null);

        if (!token) {
          if (!cancelled) {
            setPreview(null);
            setErrorMessage("This invite link is missing a token. Open the link from your coach's email.");
          }
          return;
        }

        const nextPreview = await getAthleteInvitePreview(token);
        if (cancelled) return;
        setPreview(nextPreview);
        if (nextPreview.email) setEmail(nextPreview.email);
        if (!nextPreview.ok) setErrorMessage(friendlyInviteError(nextPreview));
      } catch (error: any) {
        if (!cancelled) setErrorMessage(String(error?.message ?? "Could not load this invite."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadInvite();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function routeAfterClaim(result: AcceptInviteResult) {
    let teamId: string | null = null;
    let athleteProfileId: string | null = null;
    if (typeof result === "string") {
      teamId = result;
    } else if (result && typeof result === "object") {
      teamId = result.team_id ?? null;
      athleteProfileId = result.athlete_profile_id ?? null;
    }

    const acceptedRole = typeof result === "object" ? String(result.role ?? "").trim().toLowerCase() : "";
    if (acceptedRole === "editor" || acceptedRole === "viewer" || acceptedRole === "coach") {
      const contexts = await listAccountContextsForCurrentUser();
      const acceptedContext =
        contexts.find((context) => context.kind === "coach" && context.teamId === teamId) ??
        contexts.find((context) => context.kind === "coach");
      if (acceptedContext) {
        const route = await switchAccountContext(acceptedContext);
        await bootstrapTeamSyncOnce();
        router.replace(route);
        return;
      }
      router.replace("/(auth)/choose-account");
      return;
    }

    const selectedAthleteId = athleteProfileId ?? (await getMyClaimedAthleteProfileId(teamId));
    if (selectedAthleteId) {
      await AsyncStorage.setItem(SELECTED_ATHLETE_KEY, selectedAthleteId);
    }

    const contexts = await listAccountContextsForCurrentUser();
    const acceptedContext: AccountContext | undefined =
      contexts.find(
        (context) =>
          context.kind === "athlete" &&
          (!teamId || context.teamId === teamId) &&
          (!selectedAthleteId || context.athleteId === selectedAthleteId)
      ) ?? contexts.find((context) => context.kind === "athlete" && (!teamId || context.teamId === teamId));

    if (acceptedContext) {
      const route = await switchAccountContext(acceptedContext);
      await bootstrapTeamSyncOnce();
      router.replace(route);
      return;
    }

    router.replace("/(athlete)/dashboard");
  }

  async function claimInvite() {
    if (!token) {
      setErrorMessage("This invite link is missing a token. Open the link from your coach's email.");
      return;
    }
    if (preview && !preview.ok) {
      setErrorMessage(friendlyInviteError(preview));
      return;
    }

    setBusy(true);
    setErrorMessage(null);
    setMessage("Accepting invite...");
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      const signedInEmail = normalizeEmail(userData.user?.email);
      if (!signedInEmail) {
        throw new Error("Sign in with the invited email address to accept this invite.");
      }
      if (inviteEmail && signedInEmail !== inviteEmail) {
        setSessionUser({ email: signedInEmail });
        setMessage(null);
        setErrorMessage(emailMismatchMessage(inviteEmail, signedInEmail));
        return;
      }

      const result = await acceptInvite(token);
      setMessage("Invite accepted. Opening your athlete dashboard...");
      await new Promise((resolve) => setTimeout(resolve, 700));
      await routeAfterClaim(result);
    } catch (error: any) {
      setMessage(null);
      setErrorMessage(String(error?.message ?? "Could not accept this invite."));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (loading || busy || autoClaimAttemptedRef.current) return;
    if (!preview?.ok || !sessionUser || emailMismatch) return;
    autoClaimAttemptedRef.current = true;
    void claimInvite();
  }, [loading, busy, preview?.ok, sessionUser, emailMismatch]);

  async function createAccountAndClaim() {
    const cleanEmail = normalizeEmail(email);
    setErrorMessage(null);
    setMessage(null);

    if (inviteEmail && cleanEmail !== inviteEmail) {
      setErrorMessage("Use the invited email address to accept this invite.");
      return;
    }
    if (password.length < 6) {
      setErrorMessage("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: cleanEmail,
        password,
      });

      if (error) {
        if (isExistingUserError(error)) {
          setMode("signin");
          setMessage("An account already exists for this email. Sign in to claim this invite.");
          return;
        }
        throw error;
      }

      const identities = data.user?.identities;
      if (Array.isArray(identities) && identities.length === 0) {
        setMode("signin");
        setMessage("An account already exists for this email. Sign in to claim this invite.");
        return;
      }

      if (!data.session) {
        const signInResult = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
        if (signInResult.error) {
          setMessage("Account created. Confirm your email if prompted, then sign in here to claim this invite.");
          setMode("signin");
          return;
        }
      }

      setSessionUser({ email: cleanEmail });
      await claimInvite();
    } catch (error: any) {
      setErrorMessage(String(error?.message ?? "Could not create this account."));
    } finally {
      setBusy(false);
    }
  }

  async function signInAndClaim() {
    const cleanEmail = normalizeEmail(email);
    setErrorMessage(null);
    setMessage(null);

    if (inviteEmail && cleanEmail !== inviteEmail) {
      setErrorMessage("Sign in with the invited email address to accept this invite.");
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
      if (error) throw error;
      setSessionUser({ email: cleanEmail });
      await claimInvite();
    } catch (error: any) {
      setErrorMessage(String(error?.message ?? "Could not sign in."));
    } finally {
      setBusy(false);
    }
  }

  async function signOutForInviteEmail() {
    setBusy(true);
    try {
      await supabase.auth.signOut();
      setSessionUser(null);
      setMode("signin");
      setMessage(`Signed out. Sign in with ${inviteEmail || "the invited email"} to claim this invite.`);
    } catch (error: any) {
      Alert.alert("Sign out failed", error?.message ?? "Could not sign out.");
    } finally {
      setBusy(false);
    }
  }

  const teamLabel = preview?.team_name?.trim() || "your team";
  const athleteLabel = preview?.athlete_name?.trim() || "your athlete profile";

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12, alignItems: "center" }}>
        <ActivityIndicator />
        <Text style={{ fontSize: 16, opacity: 0.7 }}>Loading invite...</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 26, fontWeight: "600" }}>Accept Invite</Text>
      <Text style={{ fontSize: 16, opacity: 0.7 }}>
        {preview?.ok
          ? `Join ${teamLabel} as ${athleteLabel}.`
          : "We couldn't open this invite."}
      </Text>

      {preview ? (
        <View style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, gap: 6 }}>
          <Text style={{ fontSize: 14, opacity: 0.7 }}>Team</Text>
          <Text style={{ fontSize: 16, fontWeight: "600" }}>{teamLabel}</Text>
          <Text style={{ fontSize: 14, opacity: 0.7 }}>Athlete</Text>
          <Text style={{ fontSize: 16, fontWeight: "600" }}>{athleteLabel}</Text>
          <Text style={{ fontSize: 14, opacity: 0.7 }}>Invited email</Text>
          <Text style={{ fontSize: 16, fontWeight: "600" }}>{preview.email || "Not provided"}</Text>
        </View>
      ) : null}

      {emailMismatch ? (
        <View style={{ borderWidth: 1, borderColor: "#fecaca", backgroundColor: "#fef2f2", borderRadius: 12, padding: 12, gap: 8 }}>
          <Text style={{ color: "#991b1b", fontWeight: "700", lineHeight: 20 }}>
            {emailMismatchMessage(inviteEmail, activeEmail)}
          </Text>
          <Pressable
            onPress={signOutForInviteEmail}
            disabled={busy}
            style={{ backgroundColor: busy ? "#999" : "black", padding: 14, borderRadius: 12, alignItems: "center" }}
          >
            <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>{busy ? "Signing out..." : "Sign Out"}</Text>
          </Pressable>
        </View>
      ) : null}

      {preview?.ok && !sessionUser ? (
        <>
          {message ? <Text style={{ color: "#166534", fontWeight: "700", lineHeight: 20 }}>{message}</Text> : null}
          <Text style={{ fontSize: 14, opacity: 0.7 }}>Email</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            editable={!emailLocked}
            placeholder="you@email.com"
            style={{
              borderWidth: 1,
              borderColor: "#ddd",
              borderRadius: 12,
              padding: 12,
              fontSize: 16,
              backgroundColor: emailLocked ? "#f8fafc" : "white",
            }}
          />

          <Text style={{ fontSize: 14, opacity: 0.7 }}>Password</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="At least 6 characters"
            secureTextEntry
            style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, fontSize: 16 }}
          />

          {mode === "create" ? (
            <>
              <Text style={{ fontSize: 14, opacity: 0.7 }}>Confirm password</Text>
              <TextInput
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="Re-enter password"
                secureTextEntry
                style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, fontSize: 16 }}
              />
              <Pressable
                onPress={createAccountAndClaim}
                disabled={!canCreate}
                style={{ backgroundColor: canCreate ? "black" : "#999", padding: 14, borderRadius: 12, alignItems: "center", marginTop: 8 }}
              >
                <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>
                  {busy ? "Creating..." : "Create Account and Accept Invite"}
                </Text>
              </Pressable>
              <Pressable onPress={() => setMode("signin")} disabled={busy} style={{ alignItems: "center", padding: 8 }}>
                <Text style={{ color: "#2563eb", fontSize: 14, fontWeight: "600" }}>
                  Already have an account? Sign in to claim this invite.
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                onPress={signInAndClaim}
                disabled={!canSignIn}
                style={{ backgroundColor: canSignIn ? "black" : "#999", padding: 14, borderRadius: 12, alignItems: "center", marginTop: 8 }}
              >
                <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>
                  {busy ? "Signing in..." : "Sign In and Accept Invite"}
                </Text>
              </Pressable>
              <Pressable onPress={() => setMode("create")} disabled={busy} style={{ alignItems: "center", padding: 8 }}>
                <Text style={{ color: "#2563eb", fontSize: 14, fontWeight: "600" }}>
                  Need an account? Create one for this invite.
                </Text>
              </Pressable>
            </>
          )}
        </>
      ) : null}

      {preview?.ok && sessionUser && !emailMismatch ? (
        <View style={{ borderWidth: 1, borderColor: "#bbf7d0", backgroundColor: "#f0fdf4", borderRadius: 12, padding: 12 }}>
          <Text style={{ color: "#166534", fontWeight: "700", lineHeight: 20 }}>
            {message || "Signed in. Accepting your invite..."}
          </Text>
        </View>
      ) : null}

      {errorMessage ? (
        <View style={{ borderWidth: 1, borderColor: "#fecaca", backgroundColor: "#fef2f2", borderRadius: 12, padding: 12 }}>
          <Text selectable style={{ color: "#991b1b", fontWeight: "700", lineHeight: 20 }}>
            {errorMessage}
          </Text>
        </View>
      ) : null}

      {!preview?.ok ? (
        <Pressable
          onPress={() => router.replace("/(auth)/login")}
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 14, borderRadius: 12, alignItems: "center" }}
        >
          <Text style={{ color: "#111827", fontSize: 16, fontWeight: "600" }}>Back to Sign In</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
