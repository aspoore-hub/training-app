import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { acceptInvite, getMyClaimedAthleteProfileId, type AcceptInviteResult } from "../../lib/team";
import { bootstrapTeamSyncOnce } from "../../lib/bootstrapTeamSync";

const SELECTED_ATHLETE_KEY = "training_app_selected_athlete_v1";

export default function Join() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();

  const [token, setToken] = useState<string>(typeof params.token === "string" ? params.token : "");
  const [busy, setBusy] = useState(false);

  async function claim() {
    const t = token.trim();
    if (!t) return Alert.alert("Missing token", "Paste the invite token from your coach.");

    setBusy(true);
    try {
      const result = (await acceptInvite(t)) as AcceptInviteResult; // calls your RPC accept_team_invite

      let teamId: string | null = null;
      let athleteProfileId: string | null = null;
      if (typeof result === "string") {
        teamId = result;
      } else if (result && typeof result === "object") {
        teamId = result.team_id ?? null;
        athleteProfileId = result.athlete_profile_id ?? null;
      }

      await bootstrapTeamSyncOnce(); // pull team keys after claim

      // Auto-select claimed athlete profile in athlete mode.
      const selectedAthleteId =
        athleteProfileId ?? (await getMyClaimedAthleteProfileId(teamId));
      if (selectedAthleteId) {
        await AsyncStorage.setItem(SELECTED_ATHLETE_KEY, selectedAthleteId);
      }

      router.replace("/(athlete)"); // athlete view
    } catch (e: any) {
      Alert.alert("Invite failed", e?.message ?? "Invalid or expired invite.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // auto-claim if token came from URL
    if (token.trim()) {
      // do nothing automatically (safer); user clicks Claim
    }
  }, [token]);

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 26, fontWeight: "600" }}>Join Team</Text>
      <Text style={{ fontSize: 16, opacity: 0.7 }}>
        Paste your invite token to claim your athlete profile.
      </Text>

      <TextInput
        value={token}
        onChangeText={setToken}
        placeholder="Invite token"
        autoCapitalize="none"
        autoCorrect={false}
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, fontSize: 16 }}
      />

      <Pressable
        onPress={claim}
        disabled={busy}
        style={{
          backgroundColor: busy ? "#999" : "black",
          padding: 14,
          borderRadius: 12,
          alignItems: "center",
          marginTop: 8,
        }}
      >
        <Text style={{ color: "white", fontSize: 16, fontWeight: "600" }}>
          {busy ? "Claiming..." : "Claim Invite"}
        </Text>
      </Pressable>
    </View>
  );
}
