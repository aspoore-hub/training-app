import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";

import {
  createClaimInvite,
  createTeamAthlete,
  getCurrentTeamId,
  getMyUserId,
  linkTeamAthleteToExistingUserEmail,
} from "../../lib/team";
import { teamDataStore, type TeamAthlete } from "../../lib/teamDataStore";
import { canEditRoster, getCurrentTeamRole, type TeamRole } from "../../lib/teamPermissions";
import { supabase } from "../../lib/supabase";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Divider } from "../ui/Divider";
import { Screen } from "../ui/Screen";
import { TextField } from "../ui/TextField";
import { useAppTheme } from "../ui/useAppTheme";
import { useResponsive } from "../../lib/useResponsive";

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
  const { isDesktop } = useResponsive();
  const s = teamDataStore.use();

  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [lastInviteToken, setLastInviteToken] = useState("");
  const [rosterFilter, setRosterFilter] = useState<"active" | "all" | "inactive">("active");
  const [currentTeamRole, setCurrentTeamRole] = useState<TeamRole | null>(null);
  const readOnlyRoster = !canEditRoster(currentTeamRole);

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

  useFocusEffect(
    useCallback(() => {
      // refresh when screen is focused (safe + centralized)
      void teamDataStore.actions.refreshRoster();
    }, [])
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sourceRoster =
      rosterFilter === "all"
        ? s.roster
        : rosterFilter === "inactive"
          ? teamDataStore.getInactiveRoster()
          : teamDataStore.getActiveRoster();
    const sorted = [...sourceRoster].sort((a, b) => {
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
  }, [s.roster, query, rosterFilter]);

  const listCountLabel = useMemo(() => {
    const total = filtered.length;
    return `${total} athlete${total === 1 ? "" : "s"}`;
  }, [filtered.length]);

  const pageShellStyle = useMemo(
    () => ({
      padding: theme.space.md,
      gap: 10,
      flex: 1,
    }),
    [theme.space.md]
  );

  const sectionCardStyle = useMemo(
    () => ({
      borderColor: "#dfe6f2",
      borderRadius: 14,
      padding: 12,
      backgroundColor: "#fff",
      shadowColor: "#111827",
      shadowOpacity: Platform.OS === "web" ? 0.04 : 0.08,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 2 },
      elevation: 1,
    }),
    []
  );

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

    return teamDataStore.getState().roster.some((a) => {
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
        const created = await createTeamAthlete(fn, ln, nextEmail || null);
        if (nextEmail && created?.id) {
          try {
            const teamId = await getCurrentTeamId();
            const linkResult = await linkTeamAthleteToExistingUserEmail(teamId, created.id, nextEmail);
            if (linkResult.status === "linked") {
              setStatus(`Athlete profile created. Login linked to ${linkResult.linked_email ?? nextEmail}.`);
            } else if (linkResult.status === "no_user_found") {
              setStatus("Athlete profile created. Email saved, but no login account exists yet.");
            } else if (linkResult.status === "duplicate_claim") {
              setStatus("Athlete profile created. That login is already linked to another athlete on this team.");
            } else {
              setStatus("Athlete profile created. Login access was not linked.");
            }
          } catch (linkError) {
            console.warn("Create athlete login link failed", linkError);
            setStatus("Athlete profile created. Login access was not linked.");
          }
        }
        await teamDataStore.actions.refreshRoster();
        setFirstName("");
        setLastName("");
        setEmail("");
        if (!nextEmail && Platform.OS === "web") setStatus("Athlete profile created.");
        else if (Platform.OS !== "web") Alert.alert("Created", "Athlete profile created.");
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

  return (
    <Screen padded={false} style={{ flex: 1 }}>
      <View style={pageShellStyle}>
        <Card
          style={{
            ...sectionCardStyle,
            paddingVertical: 11,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="title">Roster</AppText>
            <AppText variant="caption" color="mutedText" style={{ marginTop: 3 }}>
              Manage athletes, profile access, and invite workflows.
            </AppText>
          </View>
          <View
            style={{
              borderWidth: 1,
              borderColor: "#d7dfeb",
              backgroundColor: "#f7f9fd",
              borderRadius: 999,
              paddingVertical: 5,
              paddingHorizontal: 10,
            }}
          >
            <AppText variant="sub" color="mutedText">
              {listCountLabel}
            </AppText>
          </View>
        </Card>

        {(status || s.lastError) ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {status ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: "#b8e7ca",
                  backgroundColor: "#eefaf2",
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                }}
              >
                <AppText variant="caption" color="success">{status}</AppText>
              </View>
            ) : null}
            {s.lastError ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: "#f4c1c1",
                  backgroundColor: "#fff1f1",
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                }}
              >
                <AppText variant="caption" color="danger">{s.lastError}</AppText>
              </View>
            ) : null}
          </View>
        ) : null}

        {lastInviteToken ? (
          <Card style={{ ...sectionCardStyle, gap: 3, paddingVertical: 8 }}>
            <AppText variant="caption" color="mutedText">Latest invite token</AppText>
            <AppText variant="sub" numberOfLines={1}>{lastInviteToken}</AppText>
          </Card>
        ) : null}

        {readOnlyRoster ? (
          <Card style={{ ...sectionCardStyle, gap: 3, paddingVertical: 10, backgroundColor: "#f8fafc" }}>
            <AppText variant="sub" style={{ color: "#475569", fontWeight: "800" }}>
              Viewer access: editing is disabled.
            </AppText>
            <AppText variant="caption" color="mutedText">
              Roster profiles and invite tools are available to Owners and Editors.
            </AppText>
          </Card>
        ) : (
          <Card style={{ ...sectionCardStyle, gap: 9, paddingVertical: 10 }}>
            <View style={{ gap: 2 }}>
              <AppText variant="headline">Add athlete</AppText>
              <AppText variant="caption" color="mutedText">
                Create a new roster profile.
              </AppText>
            </View>
            <View style={{ flexDirection: isDesktop ? "row" : "column", gap: 8 }}>
              <TextField
                label="First name"
                value={firstName}
                onChangeText={setFirstName}
                placeholder="e.g. Amelia"
                autoCapitalize="words"
                style={isDesktop ? { flex: 1 } : undefined}
              />
              <TextField
                label="Last name"
                value={lastName}
                onChangeText={setLastName}
                placeholder="e.g. Dodds"
                autoCapitalize="words"
                style={isDesktop ? { flex: 1 } : undefined}
              />
              <TextField
                label="Email (optional)"
                value={email}
                onChangeText={setEmail}
                placeholder="e.g. jane@email.com"
                keyboardType="email-address"
                autoCapitalize="none"
                style={isDesktop ? { flex: 1.2 } : undefined}
              />
            </View>
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Button
                title={busy ? "Working..." : "Create Athlete"}
                onPress={addAthlete}
                disabled={busy}
                style={{ height: 36 }}
              />
              <Button
                title={s.loadingCount > 0 ? "Refreshing..." : "Refresh"}
                variant="secondary"
                onPress={() => void teamDataStore.actions.refreshRoster()}
                disabled={busy || s.loadingCount > 0}
                style={{ height: 36 }}
              />
            </View>
          </Card>
        )}

        <Card style={{ ...sectionCardStyle, padding: 0, overflow: "hidden", flex: 1 }}>
          <View style={{ paddingHorizontal: theme.space.md, paddingTop: 9, paddingBottom: 8, gap: 7 }}>
            <View style={{ gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
                <AppText variant="headline">Roster list</AppText>
                <AppText variant="sub" color="mutedText">{listCountLabel}</AppText>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Pressable
                  onPress={() => setRosterFilter("active")}
                  style={{
                    borderWidth: 1,
                    borderColor: rosterFilter === "active" ? "#111" : "#d7dfeb",
                    backgroundColor: rosterFilter === "active" ? "#111" : "#fff",
                    borderRadius: 999,
                    paddingVertical: 4,
                    paddingHorizontal: 9,
                  }}
                >
                  <AppText variant="caption" style={{ color: rosterFilter === "active" ? "#fff" : "#111", fontWeight: "800" }}>
                    Active
                  </AppText>
                </Pressable>
                <Pressable
                  onPress={() => setRosterFilter("all")}
                  style={{
                    borderWidth: 1,
                    borderColor: rosterFilter === "all" ? "#111" : "#d7dfeb",
                    backgroundColor: rosterFilter === "all" ? "#111" : "#fff",
                    borderRadius: 999,
                    paddingVertical: 4,
                    paddingHorizontal: 9,
                  }}
                >
                  <AppText variant="caption" style={{ color: rosterFilter === "all" ? "#fff" : "#111", fontWeight: "800" }}>
                    All
                  </AppText>
                </Pressable>
                <Pressable
                  onPress={() => setRosterFilter("inactive")}
                  style={{
                    borderWidth: 1,
                    borderColor: rosterFilter === "inactive" ? "#111" : "#d7dfeb",
                    backgroundColor: rosterFilter === "inactive" ? "#111" : "#fff",
                    borderRadius: 999,
                    paddingVertical: 4,
                    paddingHorizontal: 9,
                  }}
                >
                  <AppText variant="caption" style={{ color: rosterFilter === "inactive" ? "#fff" : "#111", fontWeight: "800" }}>
                    Inactive
                  </AppText>
                </Pressable>
              </View>
              <AppText variant="caption" color="mutedText">
                Search by athlete name, email, or UUID.
              </AppText>
            </View>
            <TextField
              value={query}
              onChangeText={setQuery}
              placeholder="Name, email, or UUID..."
              autoCapitalize="none"
            />
          </View>

          <Divider />

          <ScrollView contentContainerStyle={{ paddingBottom: 6 }}>
            {filtered.map((a, idx) => (
              <View key={a.id}>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/(coach)/(tabs)/roster/[id]",
                      params: { id: a.id },
                    })
                  }
                  style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: theme.space.sm,
                      paddingHorizontal: theme.space.md,
                      paddingVertical: 8,
                      minHeight: 62,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <AppText variant="sub" numberOfLines={1} style={{ fontSize: 15 }}>
                        {a.display_name ?? "Unnamed athlete"}
                      </AppText>
                      <AppText variant="caption" color="mutedText" numberOfLines={1} style={{ fontSize: 11.5 }}>
                        {String(a.email ?? "").trim() ? a.email : "No email"}
                      </AppText>
                      <AppText
                        variant="caption"
                        color="mutedText"
                        numberOfLines={1}
                        style={{ fontSize: 10.5, opacity: 0.62 }}
                      >
                        ID: {a.id}
                      </AppText>
                    </View>
                    {!readOnlyRoster ? (
                      <View style={{ width: 86, alignItems: "flex-end" }}>
                        <Button
                          title="Invite"
                          variant="secondary"
                          disabled={busy}
                          onPress={() => inviteAthlete(a)}
                          style={{ height: 32, minWidth: 80 }}
                        />
                      </View>
                    ) : null}
                  </View>
                </Pressable>
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
