import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";

import { AppText } from "../../../../components/ui/AppText";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { Divider } from "../../../../components/ui/Divider";
import { Screen } from "../../../../components/ui/Screen";
import { TextField } from "../../../../components/ui/TextField";
import { useAppTheme } from "../../../../components/ui/useAppTheme";
import { useResponsive } from "../../../../lib/useResponsive";
import { teamDataStore } from "../../../../lib/teamDataStore";
import { createClaimInvite } from "../../../../lib/team";

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export default function CoachEditTeamAthlete() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const athleteId = useMemo(() => (Array.isArray(id) ? id[0] : id) ?? "", [id]);

  const { theme } = useAppTheme();
  const { isDesktop } = useResponsive();
  const s = teamDataStore.use();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [claimed, setClaimed] = useState(false);

  // ---- IMPORTANT: prevent navigation loops on web (idempotent nav) ----
  const didNavigateRef = useRef(false);

  const safeGoBack = useCallback(() => {
    if (didNavigateRef.current) return;
    didNavigateRef.current = true;

    try {
      const canGoBack = (router as any)?.canGoBack?.() ?? false;
      if (canGoBack) {
        router.back();
        return;
      }
    } catch {}

    router.replace("/(coach)/(tabs)/roster");
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!athleteId) {
        safeGoBack();
        return;
      }

      if (!isUuid(athleteId)) {
        Alert.alert("Invalid athlete id", athleteId);
        safeGoBack();
        return;
      }

      setLoading(true);
      try {
        // Ensure roster is loaded at least once
        if (!teamDataStore.getState?.().rosterLoaded) {
          await teamDataStore.actions.refreshRoster({ throwOnError: true });
        }

        if (cancelled) return;

        // Read fresh state AFTER refresh
        const a = teamDataStore.getAthleteById(athleteId);
        if (!a) {
          Alert.alert("Not found", "This athlete may have been deleted.");
          safeGoBack();
          return;
        }

        setName(String(a.display_name ?? ""));
        setEmail(String(a.email ?? ""));
        setClaimed(!!a.claimed_user_id);
      } catch (e: any) {
        if (!cancelled) {
          Alert.alert("Load failed", e?.message ?? "Could not load athlete.");
          safeGoBack();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [athleteId, safeGoBack]);

  async function save() {
    if (!isUuid(athleteId)) {
      Alert.alert("Save blocked", `Invalid athlete id: ${athleteId}`);
      return;
    }

    setBusy(true);
    try {
      await teamDataStore.actions.updateAthlete(athleteId, {
        display_name: name.trim(),
        email: email.trim() || null,
      });

      // Web: navigate immediately (alerts can behave oddly with router)
      if (Platform.OS === "web") {
        safeGoBack();
        return;
      }

      Alert.alert("Saved", "Athlete updated.", [{ text: "OK", onPress: safeGoBack }]);
    } catch (e: any) {
      Alert.alert("Save failed", e?.message ?? "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function invite() {
    if (!isUuid(athleteId)) {
      Alert.alert("Invite blocked", `Invalid athlete id: ${athleteId}`);
      return;
    }

    const e = email.trim();
    if (!e) return Alert.alert("Email required", "Enter an email before creating an invite.");

    setBusy(true);
    try {
      const token = await createClaimInvite(athleteId, e);
      await Clipboard.setStringAsync(token);

      Alert.alert("Invite created", "Token copied to clipboard.");
    } catch (e: any) {
      Alert.alert("Invite failed", e?.message ?? "Could not create invite token.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!isUuid(athleteId)) {
      Alert.alert("Delete blocked", `Invalid athlete id: ${athleteId}`);
      return;
    }

    const runDelete = async () => {
      setBusy(true);
      try {
        await teamDataStore.actions.deleteAthlete(athleteId);

        // Web: navigate immediately
        if (Platform.OS === "web") {
          safeGoBack();
          return;
        }

        Alert.alert("Deleted", "Athlete removed.", [{ text: "OK", onPress: safeGoBack }]);
      } catch (e: any) {
        console.warn("DELETE TEAM ATHLETE ERROR", e);
        Alert.alert("Delete failed", e?.message ?? "Could not delete.");
      } finally {
        setBusy(false);
      }
    };

    if (Platform.OS === "web" && typeof globalThis.confirm === "function") {
      if (!globalThis.confirm("Delete athlete?")) return;
      await runDelete();
      return;
    }

    Alert.alert("Delete athlete?", "This removes the athlete from the team roster.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void runDelete() },
    ]);
  }

  return (
    <Screen style={{ gap: 10 }}>
      <Card
        style={{
          borderColor: "#dde4f0",
          backgroundColor: "#fff",
          shadowColor: "#111827",
          shadowOpacity: Platform.OS === "web" ? 0.04 : 0.08,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 2 },
          elevation: 1,
          paddingVertical: 11,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <View style={{ gap: 3, flex: 1 }}>
            <AppText variant="caption" color="mutedText">
              Roster profile
            </AppText>
            <AppText variant="title" numberOfLines={1}>
              {name.trim() ? name : "Athlete Details"}
            </AppText>
            <AppText variant="caption" color="mutedText" numberOfLines={1}>
              {athleteId}
            </AppText>
          </View>

          <View
            style={{
              borderWidth: 1,
              borderColor: "#d7dfeb",
              backgroundColor: claimed ? "#eefaf2" : "#f7f9fd",
              borderRadius: 999,
              paddingVertical: 5,
              paddingHorizontal: 10,
            }}
          >
            <AppText variant="caption" color={claimed ? "success" : "mutedText"}>
              {claimed ? "Claimed" : "Not claimed"}
            </AppText>
          </View>

          {!isDesktop ? <Button title="Back" variant="secondary" onPress={safeGoBack} /> : null}
        </View>
      </Card>

      <Card style={{ gap: theme.space.md, borderColor: "#dde4f0", backgroundColor: "#fff" }}>
        <View style={{ gap: 4 }}>
          <AppText variant="headline">Profile</AppText>
          <AppText variant="caption" color="mutedText">Edit athlete identity and invite contact details.</AppText>
        </View>
        <Divider />
        <TextField
          label="Display name"
          value={name}
          onChangeText={setName}
          placeholder="e.g. Alex Rivera"
          autoCapitalize="words"
        />
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="athlete@email.com"
          keyboardType="email-address"
        />
        <View style={{ flexDirection: "row", gap: theme.space.sm, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Button title={busy || loading ? "Saving..." : "Save"} onPress={save} disabled={busy || loading} />
          <Button title="Create invite" variant="secondary" onPress={invite} disabled={busy || loading} />
        </View>

        {s.lastError ? (
          <AppText variant="caption" color="danger">
            {s.lastError}
          </AppText>
        ) : null}
      </Card>

      <Card style={{ gap: theme.space.md, borderColor: "#f2d7d7", backgroundColor: "#fff" }}>
        <AppText variant="headline">Danger zone</AppText>
        <Divider />
        <AppText variant="caption" color="mutedText">
          Deleting removes this athlete from your team roster.
        </AppText>
        <Button title="Delete athlete" variant="danger" onPress={remove} disabled={busy || loading} />
      </Card>
    </Screen>
  );
}
