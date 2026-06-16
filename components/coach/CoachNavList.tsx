import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { COACH_NAV_ITEMS, isCoachNavItemActive } from "../../lib/coachNav";
import { canEditTraining, getCurrentTeamRole, type TeamRole } from "../../lib/teamPermissions";

type CoachNavListProps = {
  pathname: string;
  onNavigate: (href: string) => void;
  onItemPressDone?: () => void;
};

export function CoachNavList({ pathname, onNavigate, onItemPressDone }: CoachNavListProps) {
  const [currentTeamRole, setCurrentTeamRole] = useState<TeamRole | null>(null);
  const canCreateTraining = canEditTraining(currentTeamRole);
  const visibleItems = useMemo(
    () => COACH_NAV_ITEMS.filter((item) => item.key !== "planner" || canCreateTraining),
    [canCreateTraining]
  );

  useEffect(() => {
    let cancelled = false;
    getCurrentTeamRole()
      .then((role) => {
        if (!cancelled) setCurrentTeamRole(role);
      })
      .catch(() => {
        if (!cancelled) setCurrentTeamRole(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={{ gap: 4 }}>
      {visibleItems.map((item) => {
        const active = isCoachNavItemActive(pathname, item.href);
        return (
          <Pressable
            key={item.key}
            onPress={() => {
              onNavigate(item.href);
              onItemPressDone?.();
            }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 10,
              paddingVertical: 9,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: active ? "#1f2a44" : "#d9dfeb",
              backgroundColor: active ? "#eef3ff" : "#ffffff",
              ...(Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null),
            }}
          >
            <Ionicons name={item.icon} size={16} color={active ? "#1f2a44" : "#4f5f7a"} />
            <Text style={{ fontSize: 13, fontWeight: active ? "800" : "700", color: active ? "#1f2a44" : "#2f3b52" }}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
