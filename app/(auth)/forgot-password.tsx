import { useMemo, useState } from "react";
import { Alert, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";

const RESET_SUCCESS_MESSAGE = "If an account exists for that email, a reset link has been sent.";
const RESET_FAILURE_MESSAGE = "We couldn't send the reset email. Check your connection and try again.";

function getResetRedirectUrl() {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return `${window.location.origin}/update-password`;
  }

  // Native reset links are not the production target yet. Leaving redirectTo
  // undefined lets Supabase use the configured Site URL instead of a bad URL.
  return undefined;
}

export default function ForgotPassword() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = useMemo(() => email.trim().length > 3 && !busy, [email, busy]);

  async function sendResetLink() {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) return;

    setBusy(true);
    setMessage(null);
    setErrorMessage(null);
    try {
      const redirectTo = getResetRedirectUrl();
      const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo,
      });

      if (error) {
        console.warn("Password reset email failed", error);
        setErrorMessage(RESET_FAILURE_MESSAGE);
        return Alert.alert("Reset email failed", RESET_FAILURE_MESSAGE);
      }

      setMessage(RESET_SUCCESS_MESSAGE);
    } catch (error: any) {
      console.warn("Password reset email failed", error);
      setErrorMessage(RESET_FAILURE_MESSAGE);
      Alert.alert("Reset email failed", RESET_FAILURE_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 26, fontWeight: "600" }}>Reset Password</Text>
      <Text style={{ fontSize: 16, opacity: 0.7 }}>
        Enter your email and we&apos;ll send a secure link to reset your password.
      </Text>

      <Text style={{ fontSize: 14, opacity: 0.7 }}>Email</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        placeholder="you@email.com"
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, fontSize: 16 }}
      />

      <Pressable
        onPress={sendResetLink}
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
          {busy ? "Sending..." : "Send Reset Link"}
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
        onPress={() => router.replace("/(auth)/login")}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 14,
          borderRadius: 12,
          alignItems: "center",
        }}
      >
        <Text style={{ color: "#111827", fontSize: 16, fontWeight: "600" }}>Back to Sign In</Text>
      </Pressable>
    </View>
  );
}
