import { Ionicons } from "@expo/vector-icons";
import { usePathname, useRouter } from "expo-router";
import { type ReactNode, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { AccountContextSelector } from "../account/AccountContextSelector";
import { resolveCoachTitle } from "../../lib/coachNav";
import { CoachDrawer } from "./CoachDrawer";
import { CoachSidebar } from "./CoachSidebar";

type CoachShellProps = {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  statusText?: string;
};

export function CoachShell({ children, title, subtitle, statusText }: CoachShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isWeb = Platform.OS === "web";

  const resolvedTitle = useMemo(() => {
    if (title) return title;
    return resolveCoachTitle(pathname);
  }, [pathname, title]);

  const navigate = (href: string) => {
    router.replace(href as any);
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#f3f6fb", flexDirection: "row" }}>
      {isWeb ? <CoachSidebar pathname={pathname} onNavigate={navigate} /> : null}

      <View
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            height: 50,
            borderBottomWidth: 1,
            borderBottomColor: "#dbe2ee",
            backgroundColor: "#ffffff",
            paddingHorizontal: 10,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
            {!isWeb ? (
              <Pressable
                onPress={() => setDrawerOpen(true)}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: "#d3dbe8",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="menu" size={18} color="#24334f" />
              </Pressable>
            ) : null}
            <View style={{ minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "900", color: "#1f2a44" }}>
                {resolvedTitle}
              </Text>
              {subtitle ? (
                <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "700", color: "#5b6b86" }}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <AccountContextSelector compact />
            <Text style={{ fontSize: 11, fontWeight: "800", color: "#516179" }}>{statusText ?? "Ready"}</Text>
          </View>
        </View>

        <View
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            padding: 10,
            overflow: "hidden",
          }}
        >
          {children}
        </View>
      </View>

      {!isWeb ? (
        <CoachDrawer open={drawerOpen} pathname={pathname} onNavigate={navigate} onClose={() => setDrawerOpen(false)} />
      ) : null}
    </View>
  );
}
