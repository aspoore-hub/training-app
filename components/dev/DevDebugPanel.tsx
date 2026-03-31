import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { usePathname } from "expo-router";
import { useAppRuntime } from "../../lib/appState";

export function DevDebugPanel() {
  const pathname = usePathname();
  const { state } = useAppRuntime();
  const [open, setOpen] = useState(false);

  const rows = useMemo(
    () => [
      ["route", pathname || "-"],
      ["team", state.currentTeamId || "-"],
      ["date", state.activeDateISO || "-"],
      ["planner debug", state.lastPlannerSubmitDebug || "-"],
      ["save error", state.lastSaveError || "-"],
      ["settings", state.lastSettingsLoadStatus || "-"],
    ],
    [pathname, state]
  );

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        right: 10,
        bottom: 10,
        zIndex: 9999,
      }}
    >
      <Pressable
        onPress={() => setOpen((prev) => !prev)}
        style={{
          alignSelf: "flex-end",
          borderWidth: 1,
          borderColor: "#1f2937",
          backgroundColor: "#111827",
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 6,
        }}
      >
        <Text style={{ color: "#e5e7eb", fontSize: 11, fontWeight: "900" }}>
          {open ? "Hide Debug" : "Show Debug"}
        </Text>
      </Pressable>

      {open ? (
        <View
          style={{
            marginTop: 8,
            minWidth: 280,
            maxWidth: 380,
            borderWidth: 1,
            borderColor: "#334155",
            backgroundColor: "#0f172a",
            borderRadius: 10,
            padding: 10,
            gap: 4,
          }}
        >
          {rows.map(([label, value]) => (
            <View key={label} style={{ flexDirection: "row", gap: 6 }}>
              <Text style={{ width: 110, color: "#93c5fd", fontSize: 11, fontWeight: "800" }}>{label}</Text>
              <Text style={{ flex: 1, color: "#f8fafc", fontSize: 11 }}>{String(value)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
