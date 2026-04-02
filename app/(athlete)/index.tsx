import { useEffect, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert } from "react-native";
import { useRouter } from "expo-router";
import { saveJSON } from "../../lib/storage";
import { getCurrentTeamId, getMyClaimedAthleteProfileId } from "../../lib/team";

const ATHLETE_KEY = "training_app_selected_athlete_v1";

export default function AthleteIndex() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [claimedId, setClaimedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const teamId = await getCurrentTeamId(); // should be set by acceptInvite / profile update
        const id = await getMyClaimedAthleteProfileId(teamId ?? null);

        if (cancelled) return;

        setClaimedId(id);

        if (id) {
          // Persist selected athlete id for downstream screens that still rely on ATHLETE_KEY.
          await saveJSON(ATHLETE_KEY, id);
          router.replace("/(athlete)/dashboard");
          return;
        }

        // Not claimed yet → go join
        router.replace("/(auth)/join");
      } catch (e: any) {
        if (cancelled) return;
        console.warn("AthleteIndex failed", e);
        Alert.alert("Error", e?.message ?? "Could not load athlete profile.");
        router.replace("/(auth)/join");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 20 }}>
        <ActivityIndicator />
        <Text style={{ marginTop: 12, opacity: 0.7 }}>Loading…</Text>
      </View>
    );
  }

  // This will rarely show because we redirect, but it’s a safe fallback.
  if (!claimedId) {
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: 20, gap: 12 }}>
        <Text style={{ fontSize: 22, fontWeight: "600" }}>Join Team</Text>
        <Text style={{ opacity: 0.7 }}>
          You don’t have a claimed athlete profile yet. Ask your coach for an invite token.
        </Text>

        <Pressable
          onPress={() => router.replace("/(auth)/join")}
          style={{ backgroundColor: "black", padding: 14, borderRadius: 12, alignItems: "center" }}
        >
          <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>Enter Invite Token</Text>
        </Pressable>
      </View>
    );
  }

  return null;
}
