import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, ScrollView, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";

import { loadRoster } from "../../lib/roster";
import {
  createClaimInvite,
  createTeamAthlete,
  ensureCoachTeam,
  getCurrentTeamId,
  listTeamAthletes,
  getMyUserId,
} from "../../lib/team";
import { teamStore, type TeamAthlete } from "../../lib/teamStore";
import { supabase } from "../../lib/supabase";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Divider } from "../ui/Divider";
import { Row } from "../ui/Row";
import { Screen } from "../ui/Screen";
import { TextField } from "../ui/TextField";
import { useAppTheme } from "../ui/useAppTheme";

const DEBUG_RLS = false; // flip true only when you need it

function splitName(displayName: string) {
  const parts = String(displayName ?? "").trim().split(/\s+/).filter(Boolean);
  const first = parts.slice(0, 1).join(" ");
  const last = parts.slice(1).join(" "); // everything after first token
  return { first, last };
}

function sortKeyForAthlete(a: TeamAthlete) {
  const { first, last } = splitName(a.display_name ?? "");
  // sort primarily by last, then first
  return {
    last: last.toLowerCase(),
    first: first.toLowerCase(),
  };
}

export function RosterListPane() {
  const router = useRouter();
  const { theme } = useAppTheme();
  const s = teamStore.use();

  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [lastInviteToken, setLastInviteToken] = useState("");

  async function debugRLS() {
    if (!DEBUG_RLS) return;

    const teamId = await getCurrentTeamId();
    const userId = await getMyUserId();

    console.log("DEBUG userId:", userId);
    console.log("DEBUG teamId:", teamId);

    const tm = await supabase
      .from("team_members")
      .select("team_id,user_id,role")
      .eq("team_id", teamId)
      .eq("user_id", userId)
      .maybeSingle();

    console.log("team_members row:", tm.data, tm.error);

    const t = await supabase
      .from("teams")
      .select("id,owner_id")
      .eq("id", teamId)
      .maybeSingle();

    console.log("team row:", t.data, t.error);
  }

  useEffect(() => {
    debugRLS();
  }, []);

  useFocusEffect(
    useCallback(() => {
      // refresh when screen is focused (safe + centralized)
      void teamStore.actions.refreshRoster();
    }, [])
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...s.roster].sort((a, b) => {
      const ak = sortKeyForAthlete(a);
      const bk = sortKeyForAthlete(b);
      const lastCmp = ak.last.localeCompare(bk.last);
      if (lastCmp !== 0) return lastCmp;
      return ak.first.localeCompare(bk.first);
    });

    if (!q) return sorted;

      return sorted.filter((a) => {
        const athleteId = String(a.id ?? "").toLowerCase();
        const athleteName = String(a.display_name ?? "").toLowerCase();
        const athleteEmail = String(a.email ?? "").toLowerCase();
        return athleteName.includes(q) || athleteEmail.includes(q) || athleteId.includes(q);
    });
  }, [s.roster, query]);

  async function copyToken(token: string) {
    await Clipboard.setStringAsync(token);
    if (Platform.OS === "web") setStatus("Invite token copied.");
  }

  function normName(s: string) {
    return String(s ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function isDuplicateFullName(first: string, last: string) {
    const target = normName(`${first} ${last}`);

    return teamStore.getState().roster.some((a) => {
      const existing = normName(a.display_name ?? "");
      return existing === target;
    });
  }

  const addAthlete = useCallback(async () => {
    const fn = firstName.trim();
    const ln = lastName.trim();
    const nextEmail = email.trim();
    if (!fn || !ln) {
      Alert.alert("Name required", "Enter both a first and last name.");
      return;
    }

    const displayName = `${fn} ${ln}`.trim();

    const actuallyCreate = async () => {
      setBusy(true);
      setStatus("");
      try {
        await createTeamAthlete(fn, ln, nextEmail || null);
        await teamStore.actions.refreshRoster();
        setFirstName("");
        setLastName("");
        setEmail("");
        if (Platform.OS === "web") setStatus("Athlete profile created.");
        else Alert.alert("Created", "Athlete profile created.");
      } catch (e: any) {
        console.warn("Create athlete failed", e);
        Alert.alert("Create failed", e?.message ?? "Could not create athlete profile.");
      } finally {
        setBusy(false);
      }
    };

    // Duplicate name prompt
    if (isDuplicateFullName(fn, ln)) {
      Alert.alert(
        "Duplicate name",
        `"${displayName}" already exists on the roster. Create another athlete with the same name?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Create anyway", style: "destructive", onPress: actuallyCreate },
        ]
      );
      return;
    }

    await actuallyCreate();
  }, [email, firstName, lastName]);

  const inviteAthlete = useCallback(async (athlete: TeamAthlete) => {
    const athleteEmail = String(athlete.email ?? "").trim();
    if (!athleteEmail) {
      Alert.alert("Missing email", "Add an email for this athlete, then generate the invite.");
      return;
    }

    setBusy(true);
    setStatus("");
    try {
      const token = await createClaimInvite(athlete.id, athleteEmail);
      await copyToken(token);
      setLastInviteToken(token);
      Alert.alert("Invite created", "Token copied");
    } catch (e: any) {
      console.warn("Invite failed", e);
      Alert.alert("Invite failed", e?.message ?? "Could not create invite token.");
    } finally {
      setBusy(false);
    }
  }, []);

  const importFromLocal = useCallback(async () => {
    setBusy(true);
    setStatus("");
    try {
      const local = await loadRoster();
      if (!local.length) {
        Alert.alert("Nothing to import", "Your local roster is empty on this device.");
        return;
      }

      await ensureCoachTeam("My Team");
      await teamStore.actions.refreshRoster();
      const existing = await listTeamAthletes();
      const existingEmails = new Set(
        existing.map((a) => String(a.email ?? "").trim().toLowerCase()).filter(Boolean)
      );
      const existingNames = new Set(
        existing.map((a) => String(a.display_name ?? "").trim().toLowerCase()).filter(Boolean)
      );

      let createdCount = 0;
      let skippedCount = 0;

      for (const a of local) {
        const first = String(a.firstName ?? "").trim();
        const last = String(a.lastName ?? "").trim();
        const em = String(a.email ?? "").trim();

        const display = `${first} ${last}`.trim() || em;
        if (!display) continue;

        const derivedFirst = first || display.split(/\s+/)[0] || "Athlete";
        const derivedLast = last || display.split(/\s+/).slice(1).join(" ") || "Profile";

        const emailKey = em.toLowerCase();
        const nameKey = display.toLowerCase();

        if ((emailKey && existingEmails.has(emailKey)) || existingNames.has(nameKey)) {
          skippedCount++;
          continue;
        }

        try {
          await createTeamAthlete(derivedFirst, derivedLast, em || null);
          createdCount++;
          if (emailKey) existingEmails.add(emailKey);
          existingNames.add(nameKey);
        } catch {
          skippedCount++;
        }
      }

      await teamStore.actions.refreshRoster();
      Alert.alert("Import complete", `Imported ${createdCount} athletes. Skipped ${skippedCount}.`);
    } catch (e: any) {
      console.warn("Import failed", e);
      Alert.alert("Import failed", e?.message ?? "Could not import local roster.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Screen padded={false} style={{ flex: 1 }}>
      <View style={{ padding: theme.space.lg, gap: theme.space.lg, flex: 1 }}>
        <View style={{ gap: 6 }}>
          <AppText variant="title">Roster</AppText>
          <AppText variant="caption" color="mutedText">
            Team athletes are stored in Supabase. Tap an athlete to edit details.
          </AppText>
        </View>

        {status ? <AppText variant="caption" color="success">{status}</AppText> : null}
        {s.lastError ? <AppText variant="caption" color="danger">{s.lastError}</AppText> : null}
        {lastInviteToken ? (
          <Card style={{ gap: theme.space.xs }}>
            <AppText variant="caption" color="mutedText">Latest invite token</AppText>
            <AppText variant="sub">{lastInviteToken}</AppText>
          </Card>
        ) : null}

        <Card style={{ gap: theme.space.md }}>
          <TextField
            label="First name"
            value={firstName}
            onChangeText={setFirstName}
            placeholder="e.g. Amelia"
            autoCapitalize="words"
          />
          <TextField
            label="Last name"
            value={lastName}
            onChangeText={setLastName}
            placeholder="e.g. Dodds"
            autoCapitalize="words"
          />
          <TextField
            label="Athlete email (optional for profile)"
            value={email}
            onChangeText={setEmail}
            placeholder="e.g. jane@email.com"
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <View style={{ flexDirection: "row", gap: theme.space.sm, flexWrap: "wrap" }}>
            <Button title={busy ? "Working..." : "Create Athlete"} onPress={addAthlete} disabled={busy} />
            <Button title="Import" variant="secondary" onPress={importFromLocal} disabled={busy} />
            <Button
              title={s.loadingCount > 0 ? "Refreshing..." : "Refresh"}
              variant="secondary"
              onPress={() => void teamStore.actions.refreshRoster()}
              disabled={busy || s.loadingCount > 0}
            />
          </View>
        </Card>

        <Card style={{ padding: 0, overflow: "hidden", flex: 1 }}>
          <View style={{ padding: theme.space.lg, gap: theme.space.md }}>
            <TextField
              label="Search"
              value={query}
              onChangeText={setQuery}
              placeholder="Name, email, or UUID..."
              autoCapitalize="none"
            />
            <AppText variant="headline">Athletes ({filtered.length})</AppText>
          </View>

          <Divider />

          <ScrollView contentContainerStyle={{ paddingBottom: theme.space.md }}>
            {filtered.map((a, idx) => (
              <View key={a.id}>
                <Row
                  title={a.display_name ?? "Unnamed athlete"}
                  subtitle={a.email ?? a.id}
                  right={
                    <Button
                      title="Invite"
                      variant="secondary"
                      disabled={busy}
                      onPress={() => inviteAthlete(a)}
                    />
                  }
                  onPress={() =>
                    router.push({
                      pathname: "/(coach)/(tabs)/roster/[id]",
                      params: { id: a.id },
                    })
                  }
                />
                {idx !== filtered.length - 1 ? <Divider /> : null}
              </View>
            ))}

            {!busy && filtered.length === 0 ? (
              <View style={{ padding: theme.space.xl }}>
                <AppText variant="body">No athletes found.</AppText>
                <AppText variant="caption" color="mutedText" style={{ marginTop: 6 }}>
                  Try a different search or add a new athlete.
                </AppText>
              </View>
            ) : null}
          </ScrollView>
        </Card>
      </View>
    </Screen>
  );
}
