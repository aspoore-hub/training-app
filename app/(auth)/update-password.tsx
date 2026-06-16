import { useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";

function firstString(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function readResetCodeFromUrl(paramCode: string | string[] | undefined) {
  const codeFromParams = firstString(paramCode);
  if (codeFromParams) return codeFromParams;

  if (Platform.OS !== "web" || typeof window === "undefined") return null;

  const searchCode = new URLSearchParams(window.location.search).get("code");
  if (searchCode) return searchCode;

  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(hash).get("code");
}

function readResetErrorFromUrl() {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;

  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(
    window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash
  );
  return (
    search.get("error_description") ??
    search.get("error") ??
    hash.get("error_description") ??
    hash.get("error")
  );
}

export default function UpdatePassword() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string | string[] }>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => ready && !busy && newPassword.length >= 6 && confirmPassword.length >= 6,
    [ready, busy, newPassword, confirmPassword]
  );

  useEffect(() => {
    let cancelled = false;

    async function prepareRecoverySession() {
      setReady(false);
      setErrorMessage(null);

      const urlError = readResetErrorFromUrl();
      if (urlError) {
        if (!cancelled) {
          setErrorMessage(urlError);
          setReady(false);
        }
        return;
      }

      try {
        const code = readResetCodeFromUrl(params.code);
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else {
          const { data, error } = await supabase.auth.getSession();
          if (error) throw error;
          if (!data.session) {
            throw new Error("This reset link is missing or expired. Request a new password reset email.");
          }
        }

        if (!cancelled) setReady(true);
      } catch (error: any) {
        if (!cancelled) {
          setErrorMessage(String(error?.message ?? "Could not open this reset link."));
          setReady(false);
        }
      }
    }

    void prepareRecoverySession();
    return () => {
      cancelled = true;
    };
  }, [params.code]);

  async function updatePassword() {
    setErrorMessage(null);
    setMessage(null);

    if (newPassword.length < 6) {
      setErrorMessage("Password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;

      setMessage("Password updated. You can now sign in with your new password.");
      await supabase.auth.signOut();
      setTimeout(() => {
        router.replace("/(auth)/login");
      }, 1200);
    } catch (error: any) {
      const nextMessage = String(error?.message ?? "Could not update password.");
      setErrorMessage(nextMessage);
      Alert.alert("Password update failed", nextMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 26, fontWeight: "600" }}>Create New Password</Text>
      <Text style={{ fontSize: 16, opacity: 0.7 }}>
        Enter a new password for your Training App account.
      </Text>

      <Text style={{ fontSize: 14, opacity: 0.7 }}>New password</Text>
      <TextInput
        value={newPassword}
        onChangeText={setNewPassword}
        placeholder="At least 6 characters"
        secureTextEntry
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, fontSize: 16 }}
      />

      <Text style={{ fontSize: 14, opacity: 0.7 }}>Confirm password</Text>
      <TextInput
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        placeholder="Re-enter password"
        secureTextEntry
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, fontSize: 16 }}
      />

      <Pressable
        onPress={updatePassword}
        disabled={!canSubmit}
        style={{
          backgroundColor: canSubmit ? "black" : "#999",
          padding: 14,
          borderRadius: 12,
          alignItems: "center",
          marginTop: 8,
        }}
      >
        <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>
          {busy ? "Updating..." : "Update Password"}
        </Text>
      </Pressable>

      {message ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: "#bbf7d0",
            backgroundColor: "#f0fdf4",
            borderRadius: 12,
            padding: 12,
          }}
        >
          <Text style={{ color: "#166534", fontWeight: "700", lineHeight: 20 }}>{message}</Text>
        </View>
      ) : null}

      {errorMessage ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: "#fecaca",
            backgroundColor: "#fef2f2",
            borderRadius: 12,
            padding: 12,
          }}
        >
          <Text selectable style={{ color: "#991b1b", fontWeight: "700", lineHeight: 20 }}>
            {errorMessage}
          </Text>
        </View>
      ) : null}

      <Pressable
        onPress={() => router.replace(message ? "/(auth)/login" : "/")}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 14,
          borderRadius: 12,
          alignItems: "center",
        }}
      >
        <Text style={{ color: "#111827", fontSize: 16, fontWeight: "600" }}>
          {message ? "Back to Sign In" : "Return to App"}
        </Text>
      </Pressable>
    </View>
  );
}
