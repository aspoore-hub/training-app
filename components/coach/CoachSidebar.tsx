import { Text, View } from "react-native";
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
    </View>
  );
}
