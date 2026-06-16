import { Ionicons } from "@expo/vector-icons";
import { Modal, Pressable, Text, View } from "react-native";
import { CoachNavList } from "./CoachNavList";

type CoachDrawerProps = {
  open: boolean;
  pathname: string;
  onNavigate: (href: string) => void;
  onClose: () => void;
};

export function CoachDrawer({ open, pathname, onNavigate, onClose }: CoachDrawerProps) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(16, 23, 39, 0.36)", justifyContent: "flex-start", alignItems: "flex-start" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            marginTop: 0,
            width: 286,
            maxWidth: "86%",
            height: "100%",
            backgroundColor: "#f8fbff",
            borderRightWidth: 1,
            borderRightColor: "#dbe2ee",
            paddingHorizontal: 12,
            paddingVertical: 14,
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: "900", color: "#1f2a44", marginBottom: 10 }}>Coach Workspace</Text>
          <CoachNavList pathname={pathname} onNavigate={onNavigate} onItemPressDone={onClose} />
          <Pressable
            onPress={() => {
              onNavigate("/(coach)/(tabs)/plan-builder");
              onClose();
            }}
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
        </Pressable>
      </Pressable>
    </Modal>
  );
}
