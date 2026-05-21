import { Alert, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";

export default function AthleteSettingsScreen() {
  const router = useRouter();

  async function logOut() {
    try {
      await supabase.auth.signOut();
      router.replace("/(auth)/login");
    } catch (error: any) {
      Alert.alert("Log out failed", String(error?.message ?? "Please try again."));
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#f6f8fb", padding: 16 }}>
      <Text style={{ fontSize: 28, fontWeight: "900", color: "#0f172a" }}>Settings</Text>
      <Text style={{ marginTop: 6, color: "#475569", lineHeight: 20 }}>
        Account and app options.
      </Text>

      <View
        style={{
          marginTop: 16,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#e2e8f0",
          backgroundColor: "#ffffff",
          padding: 14,
        }}
      >
        <Pressable
          onPress={logOut}
          style={{
            borderRadius: 10,
            borderWidth: 1,
            borderColor: "#fecaca",
            backgroundColor: "#fff1f2",
            paddingVertical: 12,
            alignItems: "center",
          }}
        >
          <Text style={{ fontWeight: "900", color: "#b91c1c" }}>Log Out</Text>
        </Pressable>
      </View>
    </View>
  );
}

