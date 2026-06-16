import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  AccountContextLoadError,
  listAccountContextsForCurrentUser,
  type AccountContext,
} from "../../lib/accountContexts";
import { switchAccountContext } from "../../lib/accountContextSwitch";
import { supabase } from "../../lib/supabase";

function roleLabel(context: AccountContext) {
  if (context.role === "owner") return "Owner";
  if (context.role === "editor") return "Editor";
  if (context.role === "viewer") return "Viewer";
  return "Athlete";
}

function contextErrorMessage(error: unknown) {
  const base = "Signed in, but we couldn't load your team access. Please try again.";
  if (typeof __DEV__ === "undefined" || !__DEV__) return base;
  if (error instanceof AccountContextLoadError) {
    return `${base}\n\nDebug: ${error.failures.map((failure) => `${failure.area}: ${failure.message}`).join("; ")}`;
  }
  return base;
}

export default function ChooseAccountScreen() {
  const router = useRouter();
  const [contexts, setContexts] = useState<AccountContext[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyContextId, setBusyContextId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadContexts = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const next = await listAccountContextsForCurrentUser();
      setContexts(next);
    } catch (error: any) {
      console.error("Account context load failed", error);
      const message = contextErrorMessage(error);
      setErrorMessage(message);
      Alert.alert("Account load failed", String(error?.message ?? "Could not load team access."));
      setContexts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadContexts();
  }, [loadContexts]);

  async function choose(context: AccountContext) {
    setBusyContextId(context.id);
    setErrorMessage(null);
    try {
      const route = await switchAccountContext(context);
      router.replace(route);
    } catch (error: any) {
      console.error("Account context selection failed", error);
      setErrorMessage("Signed in, but we couldn't open that team access. Please try again.");
      Alert.alert("Could not open account", String(error?.message ?? "Please try again."));
    } finally {
      setBusyContextId(null);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/(auth)/login");
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#f6f8fb", padding: 18 }}>
      <Text style={{ fontSize: 28, fontWeight: "900", color: "#0f172a" }}>Choose account</Text>
      <Text style={{ marginTop: 6, color: "#475569", fontWeight: "700" }}>
        Select the team and role you want to use.
      </Text>

      {errorMessage ? (
        <View
          style={{
            marginTop: 14,
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

      {loading ? (
        <View style={{ marginTop: 24, alignItems: "center", gap: 10 }}>
          <ActivityIndicator />
          <Text style={{ color: "#64748b", fontWeight: "700" }}>Loading team access...</Text>
        </View>
      ) : contexts.length === 0 ? (
        <View
          style={{
            marginTop: 18,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: "#fde68a",
            backgroundColor: "#fffbeb",
            padding: 14,
            gap: 10,
          }}
        >
          <Text style={{ fontSize: 18, fontWeight: "900", color: "#78350f" }}>No team access found for this email.</Text>
          <Text style={{ color: "#92400e", lineHeight: 20 }}>
            Ask your coach for an invite link or make sure you used the same email.
          </Text>
          <Pressable
            onPress={signOut}
            style={{
              borderRadius: 10,
              backgroundColor: "#111827",
              paddingVertical: 11,
              alignItems: "center",
            }}
          >
            <Text style={{ color: "#fff", fontWeight: "900" }}>Sign out</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingTop: 16, paddingBottom: 20, gap: 10 }}>
          {contexts.map((context) => {
            const isBusy = busyContextId === context.id;
            const isCoach = context.kind === "coach";
            return (
              <Pressable
                key={context.id}
                disabled={!!busyContextId}
                onPress={() => void choose(context)}
                style={{
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: "#dbe3ef",
                  backgroundColor: "#fff",
                  padding: 14,
                  opacity: busyContextId && !isBusy ? 0.55 : 1,
                }}
              >
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 17, fontWeight: "900", color: "#0f172a" }} numberOfLines={1}>
                      {isCoach ? context.teamName : context.athleteName || "Athlete"}
                    </Text>
                    <Text style={{ marginTop: 4, color: "#475569", fontWeight: "700" }} numberOfLines={1}>
                      {isCoach ? "Coach workspace" : context.teamName}
                    </Text>
                  </View>
                  <View
                    style={{
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: isCoach ? "#bfdbfe" : "#bbf7d0",
                      backgroundColor: isCoach ? "#eff6ff" : "#f0fdf4",
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "900", color: isCoach ? "#1d4ed8" : "#166534" }}>
                      {roleLabel(context)}
                    </Text>
                  </View>
                </View>
                <Text style={{ marginTop: 10, color: "#0f172a", fontWeight: "900" }}>
                  {isBusy ? "Opening..." : isCoach ? "Open coach dashboard" : "Open athlete dashboard"}
                </Text>
              </Pressable>
            );
          })}

          <Pressable
            onPress={signOut}
            style={{
              marginTop: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: "#e2e8f0",
              backgroundColor: "#fff",
              paddingVertical: 11,
              alignItems: "center",
            }}
          >
            <Text style={{ color: "#334155", fontWeight: "900" }}>Sign out</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}
