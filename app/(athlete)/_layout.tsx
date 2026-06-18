import { useEffect, useState } from "react";
import { Tabs } from "expo-router";
import { useRouter } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { resolveStartupAccountContext, routeForAccountContext } from "../../lib/accountContexts";

export default function AthleteTabs() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const resolution = await resolveStartupAccountContext();
      if (resolution.status === "ready" && resolution.context.kind === "athlete") {
        if (!cancelled) setAllowed(true);
        return;
      }
      if (resolution.status === "ready") {
        if (!cancelled) router.replace(routeForAccountContext(resolution.context));
        return;
      }
      if (!cancelled) router.replace("/(auth)/choose-account");
    })().catch(() => {
      if (!cancelled) router.replace("/(auth)/choose-account");
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!allowed) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }}>
        <ActivityIndicator />
        <Text style={{ color: "#64748b", fontWeight: "700" }}>Loading account...</Text>
      </View>
    );
  }

  return (
    <Tabs screenOptions={{ headerShown: true }}>
      {/* Visible tabs */}
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="month"
        options={{
          title: "Calendar",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="feedback"
        options={{
          title: "Log",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="create" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="warmups"
        options={{
          title: "Warmups",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="barbell" size={size} color={color} />
          ),
        }}
      />

      {/* Hidden routes (NOT tabs) */}
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="day" options={{ href: null, title: "Day" }} />
      <Tabs.Screen name="week" options={{ href: null, title: "Week" }} />
      <Tabs.Screen name="workout/[id]" options={{ href: null, title: "Workout" }} />
      <Tabs.Screen name="calendar" options={{ href: null, title: "Calendar" }} />
    </Tabs>
  );
}
