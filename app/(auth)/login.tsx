import { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, Alert, Platform } from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { bootstrapSyncOnce } from "../../lib/bootstrapSync";
import { AccountContextLoadError, resolveStartupAccountContext, routeForAccountContext } from "../../lib/accountContexts";
import { useIsCoachMobileView } from "../../lib/useCoachMobileView";

const DEBUG_LOGIN_ROUTING = false;

function debugLoginRouting(...args: unknown[]) {
  if (DEBUG_LOGIN_ROUTING) console.log("[login-routing]", ...args);
}

function contextErrorMessage(error: unknown) {
  const base = "Signed in, but we couldn't load your team access. Please try again.";
  if (typeof __DEV__ === "undefined" || !__DEV__) return base;
  if (error instanceof AccountContextLoadError) {
    return `${base}\n\nDebug: ${error.failures.map((failure) => `${failure.area}: ${failure.message}`).join("; ")}`;
  }
  return base;
}

export default function Login() {
  const router = useRouter();
  const isCoachMobileView = useIsCoachMobileView();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = useMemo(() => email.trim().length > 3 && password.length >= 6 && !busy, [
    email,
    password,
    busy,
  ]);

  async function runBootstrapBestEffort() {
    try {
      await Promise.race([
        bootstrapSyncOnce(),
        new Promise<void>((resolve) => setTimeout(resolve, 6000)),
      ]);
    } catch (e) {
      console.warn("Bootstrap sync failed", e);
    }
  }

  async function routeAfterAuth() {
    // 1) one-time bootstrap sync (cloud/local align)
    await runBootstrapBestEffort();

    const resolution = await resolveStartupAccountContext();
    debugLoginRouting("context resolution", {
      status: resolution.status,
      count: resolution.contexts.length,
      selectedId: resolution.status === "ready" ? resolution.context.id : null,
      selectedKind: resolution.status === "ready" ? resolution.context.kind : null,
    });

    if (resolution.status === "ready") {
      const route = routeForAccountContext(resolution.context, {
        coachDefault: isCoachMobileView ? "home" : "calendar",
      });
      debugLoginRouting("router.replace", route);
      router.replace(route);
      return;
    }

    debugLoginRouting("router.replace", "/(auth)/choose-account");
    router.replace("/(auth)/choose-account");
  }

  useEffect(() => {
    let cancelled = false;

    async function routeExistingSession() {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (!data.session || cancelled) return;

        setBusy(true);
        setErrorMessage(null);
        debugLoginRouting("existing session", { userId: data.session.user.id });
        await routeAfterAuth();
      } catch (error) {
        if (cancelled) return;
        console.error("Signed-in account routing failed", error);
        setErrorMessage(contextErrorMessage(error));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    void routeExistingSession();
    return () => {
      cancelled = true;
    };
  }, []);

  async function signIn() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      debugLoginRouting("signInWithPassword result", {
        success: !error,
        userId: data.user?.id ?? null,
        session: !!data.session,
      });
      if (error) {
        setErrorMessage(error.message);
        return Alert.alert("Sign in failed", error.message);
      }

      await routeAfterAuth();
    } catch (e: any) {
      console.error("Signed-in account routing failed", e);
      setErrorMessage(contextErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function signUp() {
    setBusy(true);
    setErrorMessage(null);
    try {
      const { error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });
      if (error) return Alert.alert("Sign up failed", error.message);

      if (Platform.OS === "web") {
        alert("Account created. If email confirmation is enabled, confirm your email then sign in.");
      } else {
        Alert.alert(
          "Account created",
          "If email confirmation is enabled, confirm your email then come back and sign in."
        );
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  // Normal login UI
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 26, fontWeight: "600" }}>Training App</Text>
      <Text style={{ fontSize: 16, opacity: 0.7 }}>Sign in to sync your data between phone and web.</Text>

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

      <Text style={{ fontSize: 14, opacity: 0.7 }}>Password</Text>
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="At least 6 characters"
        secureTextEntry
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, fontSize: 16 }}
      />

      <Pressable onPress={() => router.push("/(auth)/forgot-password")} style={{ alignSelf: "flex-start" }}>
        <Text style={{ color: "#2563eb", fontSize: 14, fontWeight: "600" }}>Forgot password?</Text>
      </Pressable>

      <Pressable
        onPress={signIn}
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
          {busy ? "Signing in..." : "Sign In"}
        </Text>
      </Pressable>

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
        onPress={signUp}
        disabled={!canSubmit}
        style={{ backgroundColor: canSubmit ? "#444" : "#bbb", padding: 14, borderRadius: 12, alignItems: "center" }}
      >
        <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>
          {busy ? "Working..." : "Create Account"}
        </Text>
      </Pressable>
    </View>
  );
}
