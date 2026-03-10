import { View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";

export default function Feedback() {
  const router = useRouter();

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: 20 }}>Submit Feedback</Text>
      <Pressable
        onPress={() => router.replace("/(auth)/login")}
        style={{
          marginTop: 16,
          borderWidth: 1,
          borderColor: "#ddd",
          paddingVertical: 10,
          paddingHorizontal: 14,
          borderRadius: 10,
          backgroundColor: "white",
        }}
      >
        <Text style={{ fontWeight: "700" }}>Back to Role Select</Text>
      </Pressable>
    </View>
  );
}
