import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

export default function AthleteTabs() {
  return (
    <Tabs screenOptions={{ headerShown: true }}>
      {/* Visible tabs */}
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
          title: "Feedback",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="create" size={size} color={color} />
          ),
        }}
      />

      {/* Hidden routes (NOT tabs) */}
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="week" options={{ href: null }} />
      <Tabs.Screen name="day" options={{ href: null }} />
      <Tabs.Screen name="workout/[id]" options={{ href: null }} />
    </Tabs>
  );
}
