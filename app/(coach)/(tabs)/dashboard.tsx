import { View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";

export default function Dashboard() {
  const router = useRouter();

  return (
    <View style={{ flex: 1, padding: 20, justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "600" }}>Coach Dashboard</Text>

      <Pressable
        onPress={() => router.replace("/(auth)/login")}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 12,
          borderRadius: 12,
          alignItems: "center",
          backgroundColor: "white",
        }}
      >
        <Text style={{ fontWeight: "700" }}>Back to Role Select</Text>
      </Pressable>

      <Pressable
        onPress={() => router.push("/(coach)/(tabs)/planner")}
        style={{
          backgroundColor: "black",
          padding: 14,
          borderRadius: 12,
          alignItems: "center",
        }}
      >
        <Text style={{ color: "white", fontWeight: "700" }}>
          Create Training Session
        </Text>
      </Pressable>

      <Pressable
        onPress={() => router.push("/(coach)/workouts")}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 14,
          borderRadius: 12,
          alignItems: "center",
        }}
      >
        <Text style={{ fontWeight: "700" }}>View Athlete Workouts</Text>
      </Pressable>
    </View>
  );
}
