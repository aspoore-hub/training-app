import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  getActiveAccountContext,
  listAccountContextsForCurrentUser,
  type AccountContext,
} from "../../lib/accountContexts";
import { switchAccountContext } from "../../lib/accountContextSwitch";

function roleLabel(context: Pick<AccountContext, "role" | "kind">) {
  if (context.kind === "athlete") return "Athlete";
  if (context.role === "owner") return "Owner";
  if (context.role === "editor") return "Editor";
  return "Viewer";
}

function contextPrimaryLabel(context: AccountContext | null) {
  if (!context) return "Account";
  if (context.kind === "athlete") return context.athleteName || context.teamName || "Athlete";
  return context.teamName || "Team";
}

function contextSecondaryLabel(context: AccountContext | null) {
  if (!context) return "Choose";
  return roleLabel(context);
}

type AccountContextSelectorProps = {
  compact?: boolean;
};

export function AccountContextSelector({ compact = false }: AccountContextSelectorProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [contexts, setContexts] = useState<AccountContext[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const activeContext = useMemo(
    () => contexts.find((context) => context.id === activeId) ?? null,
    [activeId, contexts]
  );

  const loadContexts = useCallback(async () => {
    setLoading(true);
    try {
      const [nextContexts, active] = await Promise.all([
        listAccountContextsForCurrentUser(),
        getActiveAccountContext(),
      ]);
      setContexts(nextContexts);
      setActiveId(active?.id ?? null);
    } catch (error: any) {
      console.error("Account selector load failed", error);
      Alert.alert("Account load failed", String(error?.message ?? "Could not load accounts."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadContexts();
  }, [loadContexts]);

  async function choose(context: AccountContext) {
    setSwitchingId(context.id);
    try {
      const route = await switchAccountContext(context);
      setActiveId(context.id);
      setOpen(false);
      router.replace(route);
    } catch (error: any) {
      console.error("Account switch failed", error);
      Alert.alert("Could not switch account", String(error?.message ?? "Please try again."));
    } finally {
      setSwitchingId(null);
    }
  }

  return (
    <>
      <Pressable
        onPress={() => {
          setOpen(true);
          void loadContexts();
        }}
        style={{
          maxWidth: compact ? 190 : 240,
          minHeight: 34,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: "#d5deec",
          backgroundColor: "#f8fbff",
          paddingHorizontal: 9,
          paddingVertical: 6,
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null),
        }}
      >
        <Ionicons name="people-circle-outline" size={17} color="#334155" />
        <View style={{ minWidth: 0, flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "900", color: "#1f2a44" }}>
            {contextPrimaryLabel(activeContext)}
          </Text>
          <Text numberOfLines={1} style={{ marginTop: 1, fontSize: 10, fontWeight: "800", color: "#64748b" }}>
            {contextSecondaryLabel(activeContext)}
          </Text>
        </View>
        <Ionicons name="chevron-down" size={14} color="#64748b" />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(15, 23, 42, 0.28)",
            justifyContent: "flex-start",
            alignItems: "flex-end",
            padding: 14,
            paddingTop: 58,
          }}
        >
          <View
            style={{
              width: "100%",
              maxWidth: 390,
              maxHeight: "82%",
              borderRadius: 8,
              borderWidth: 1,
              borderColor: "#d9e2ef",
              backgroundColor: "#ffffff",
              overflow: "hidden",
            }}
          >
            <View
              style={{
                paddingHorizontal: 14,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: "#e2e8f0",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <Text style={{ fontSize: 16, fontWeight: "900", color: "#0f172a" }}>Switch account</Text>
              <Pressable onPress={() => setOpen(false)} style={{ padding: 6 }}>
                <Ionicons name="close" size={18} color="#475569" />
              </Pressable>
            </View>

            {loading ? (
              <View style={{ padding: 18, alignItems: "center", gap: 10 }}>
                <ActivityIndicator />
                <Text style={{ color: "#64748b", fontWeight: "700" }}>Loading accounts...</Text>
              </View>
            ) : contexts.length === 0 ? (
              <View style={{ padding: 14, gap: 10 }}>
                <Text style={{ fontWeight: "900", color: "#78350f" }}>No team access found.</Text>
                <Pressable
                  onPress={() => {
                    setOpen(false);
                    router.push("/(auth)/choose-account");
                  }}
                  style={{ borderRadius: 8, backgroundColor: "#111827", paddingVertical: 10, alignItems: "center" }}
                >
                  <Text style={{ color: "#fff", fontWeight: "900" }}>Open account chooser</Text>
                </Pressable>
              </View>
            ) : (
              <ScrollView contentContainerStyle={{ padding: 10, gap: 8 }}>
                {contexts.map((context) => {
                  const active = context.id === activeId;
                  const isBusy = switchingId === context.id;
                  const isCoach = context.kind === "coach";
                  return (
                    <Pressable
                      key={context.id}
                      disabled={!!switchingId}
                      onPress={() => void choose(context)}
                      style={{
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: active ? "#2563eb" : "#dbe3ef",
                        backgroundColor: active ? "#eff6ff" : "#ffffff",
                        padding: 12,
                        opacity: switchingId && !isBusy ? 0.55 : 1,
                        ...(Platform.OS === "web" ? ({ cursor: switchingId ? "default" : "pointer" } as any) : null),
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <View style={{ minWidth: 0, flex: 1 }}>
                          <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "900", color: "#0f172a" }}>
                            {isCoach ? context.teamName : context.athleteName || "Athlete"}
                          </Text>
                          <Text numberOfLines={1} style={{ marginTop: 3, fontSize: 12, fontWeight: "700", color: "#64748b" }}>
                            {isCoach ? "Coach" : context.teamName}
                          </Text>
                        </View>
                        <View
                          style={{
                            borderRadius: 999,
                            borderWidth: 1,
                            borderColor: isCoach ? "#bfdbfe" : "#bbf7d0",
                            backgroundColor: isCoach ? "#eff6ff" : "#f0fdf4",
                            paddingHorizontal: 9,
                            paddingVertical: 4,
                          }}
                        >
                          <Text style={{ fontSize: 11, fontWeight: "900", color: isCoach ? "#1d4ed8" : "#166534" }}>
                            {isBusy ? "Switching..." : roleLabel(context)}
                          </Text>
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}
