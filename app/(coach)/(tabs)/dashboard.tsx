import { useEffect, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { canApplyPlanBuilder, canEditTraining, getCurrentTeamRole, type TeamRole } from "../../../lib/teamPermissions";

export default function Dashboard() {
  const router = useRouter();
  const [currentTeamRole, setCurrentTeamRole] = useState<TeamRole | null>(null);
  const canCreateTraining = canEditTraining(currentTeamRole);
  const canUsePlanBuilder = canApplyPlanBuilder(currentTeamRole);

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
    <View style={{ flex: 1, padding: 20, justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "600" }}>Coach Dashboard</Text>

      <Pressable
        onPress={() => router.push("/(auth)/choose-account")}
        style={{
          borderWidth: 1,
          borderColor: "#ddd",
          padding: 12,
          borderRadius: 12,
          alignItems: "center",
          backgroundColor: "white",
        }}
      >
        <Text style={{ fontWeight: "700" }}>Switch account/team</Text>
      </Pressable>

      {canCreateTraining ? (
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
      ) : null}

      {canUsePlanBuilder ? (
        <Pressable
          onPress={() => router.push("/(coach)/(tabs)/plan-builder")}
          style={{
            borderWidth: 1,
            borderColor: "#f0c36a",
            padding: 14,
            borderRadius: 12,
            alignItems: "center",
            backgroundColor: "#fff7dd",
          }}
        >
          <Text style={{ fontWeight: "800", color: "#7c4a03" }}>
            Workout Plan Builder (Draft)
          </Text>
          <Text style={{ marginTop: 4, color: "#7c4a03", fontWeight: "600" }}>
            Draft only - does not update Calendar yet.
          </Text>
        </Pressable>
      ) : (
        <View
          style={{
            borderWidth: 1,
            borderColor: "#cbd5e1",
            backgroundColor: "#f8fafc",
            padding: 12,
            borderRadius: 12,
          }}
        >
          <Text style={{ color: "#475569", fontWeight: "800" }}>Viewer access: editing is disabled.</Text>
        </View>
      )}

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
