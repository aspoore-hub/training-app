import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import { CoachNavList } from "./CoachNavList";

type CoachSidebarProps = {
  pathname: string;
  onNavigate: (href: string) => void;
};

export function CoachSidebar({ pathname, onNavigate }: CoachSidebarProps) {
  return (
    <View
      style={{
        width: 244,
        borderRightWidth: 1,
        borderRightColor: "#dbe2ee",
        paddingHorizontal: 12,
        paddingVertical: 12,
        backgroundColor: "#f8fbff",
      }}
    >
      <Text style={{ fontSize: 15, fontWeight: "900", color: "#1f2a44", marginBottom: 10 }}>Coach Workspace</Text>
      <CoachNavList pathname={pathname} onNavigate={onNavigate} />
      <Pressable
        onPress={() => onNavigate("/(coach)/(tabs)/plan-builder")}
        style={{
          marginTop: 14,
          borderWidth: 1,
          borderColor: pathname.includes("/plan-builder") ? "#0f766e" : "#f0c36a",
          backgroundColor: pathname.includes("/plan-builder") ? "#ecfdf5" : "#fff7dd",
          borderRadius: 14,
          padding: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="grid-outline" size={16} color="#7c4a03" />
          <Text style={{ fontSize: 13, fontWeight: "900", color: "#7c4a03" }}>Workout Plan Builder</Text>
        </View>
        <Text style={{ marginTop: 5, fontSize: 11, fontWeight: "800", color: "#7c4a03" }}>
          Draft-only long-range workout planning
        </Text>
        <Text style={{ marginTop: 6, fontSize: 10, fontWeight: "900", color: "#0f766e" }}>
          Draft only - does not update Calendar
        </Text>
      </Pressable>
    </View>
  );
}
