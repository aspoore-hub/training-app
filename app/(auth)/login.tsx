import { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, Alert, Platform } from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { bootstrapSyncOnce } from "../../lib/bootstrapSync";
import { ensureProfile, getMyProfileFull, setMyRole, type UserRole } from "../../lib/profile";
import { ensureCoachTeam } from "../../lib/team";

export default function Login() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // role choice shown only when needed
  const [needsRole, setNeedsRole] = useState(false);
  const [pendingRole, setPendingRole] = useState<UserRole>("coach");

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

  async function goToRole(role: UserRole) {
    if (role === "coach") {
      try {
        await ensureCoachTeam("My Team");
      } catch (e: any) {
        console.warn("Coach team setup failed", e);
        Alert.alert(
          "Team setup issue",
          "We could not fully initialize your team yet. You can continue and try again."
        );
      }
      router.replace("/(coach)/(tabs)/calendar");
      return;
    }
    router.replace("/(athlete)");
  }

  async function afterAuth() {
    // 1) one-time bootstrap sync (cloud/local align)
    await runBootstrapBestEffort();

    // 2) ensure profile exists
    const profile = await getMyProfileFull();
    const role = profile?.role ?? null;
    if (!role) {
      setNeedsRole(true);
      return;
    }

    await goToRole(role);
  }

  async function signIn() {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) return Alert.alert("Sign in failed", error.message);

      await afterAuth();
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function signUp() {
    setBusy(true);
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

  async function saveRoleAndContinue() {
    setBusy(true);
    try {
      // Create/update profile role
      await setMyRole(pendingRole);

      // If profile was missing, create it now
      await ensureProfile(pendingRole);

      await goToRole(pendingRole);
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  // If we need role selection, show that screen
  if (needsRole) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
        <Text style={{ fontSize: 26, fontWeight: "600" }}>Choose your role</Text>
        <Text style={{ fontSize: 16, opacity: 0.7 }}>
          You can change this later. It just decides which screens you see.
        </Text>

        <Pressable
          onPress={() => setPendingRole("coach")}
          style={{
            backgroundColor: pendingRole === "coach" ? "black" : "#444",
            padding: 14,
            borderRadius: 12,
            alignItems: "center",
          }}
        >
          <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>Coach</Text>
        </Pressable>

        <Pressable
          onPress={() => setPendingRole("athlete")}
          style={{
            backgroundColor: pendingRole === "athlete" ? "black" : "#444",
            padding: 14,
            borderRadius: 12,
            alignItems: "center",
          }}
        >
          <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>Athlete</Text>
        </Pressable>

        <Pressable
          onPress={saveRoleAndContinue}
          disabled={busy}
          style={{
            backgroundColor: "#0a7",
            padding: 14,
            borderRadius: 12,
            alignItems: "center",
            marginTop: 8,
            opacity: busy ? 0.7 : 1,
          }}
        >
          <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>
            {busy ? "Saving..." : "Continue"}
          </Text>
        </Pressable>
      </View>
    );
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
