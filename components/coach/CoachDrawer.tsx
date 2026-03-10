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
        </Pressable>
      </Pressable>
    </Modal>
  );
}
