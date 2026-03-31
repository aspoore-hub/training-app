import { useEffect } from "react";
import { View, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

export default function AthleteCalendarRedirect() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name?: string }>();

  useEffect(() => {
    const name = String(params?.name ?? "").trim();
    router.replace({
      pathname: "/(athlete)/month",
      params: name ? { name } : undefined,
    });
  }, [params?.name, router]);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 20 }}>
      <Text style={{ opacity: 0.7 }}>Redirecting to monthly calendar…</Text>
    </View>
  );
}
