// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

async function signedLogoUrl(adminClient: any, logoPath: string | null | undefined, updatedAt: string | null | undefined) {
  const cleanPath = String(logoPath ?? "").trim();
  if (!cleanPath) return null;
  const { data, error } = await adminClient.storage.from("team-logos").createSignedUrl(cleanPath, 60 * 60 * 24 * 7);
  if (error) return null;
  const url = String(data?.signedUrl ?? "").trim();
  if (!url) return null;
  const version = String(updatedAt ?? "").trim();
  return version ? `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}` : url;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, status: "invalid", error: "Method not allowed" });

  try {
    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "").trim();
    if (!token) {
      return jsonResponse(400, {
        ok: false,
        status: "invalid",
        invite_kind: null,
        email: null,
        team_name: null,
        team_logo_url: null,
        athlete_name: null,
        staff_role: null,
        staff_name: null,
        first_name: null,
        last_name: null,
        expires_at: null,
        accepted_at: null,
        error: "Missing invite token.",
      });
    }

    const adminClient = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: invite, error: inviteError } = await adminClient
      .from("team_invites")
      .select("token,email,first_name,last_name,role,athlete_profile_id,team_id,expires_at,accepted_at")
      .eq("token", token)
      .maybeSingle();
    if (inviteError) throw inviteError;

    const role = String(invite?.role ?? "").trim().toLowerCase();
    const isStaff = role === "viewer" || role === "editor" || role === "coach";
    const isAthlete = role === "athlete";
    if (!invite || (!isStaff && !isAthlete)) {
      return jsonResponse(404, {
        ok: false,
        status: "invalid",
        invite_kind: null,
        email: null,
        team_name: null,
        team_logo_url: null,
        athlete_name: null,
        staff_role: null,
        staff_name: null,
        first_name: null,
        last_name: null,
        expires_at: null,
        accepted_at: null,
        error: "This invite link is invalid.",
      });
    }

    const [{ data: team, error: teamError }, athleteResult] = await Promise.all([
      adminClient.from("teams").select("name,logo_path,logo_updated_at").eq("id", invite.team_id).maybeSingle(),
      isAthlete
        ? adminClient
            .from("team_athletes")
            .select("display_name,first_name,last_name")
            .eq("team_id", invite.team_id)
            .eq("id", invite.athlete_profile_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (teamError) throw teamError;
    if (athleteResult.error) throw athleteResult.error;

    const acceptedAt = invite.accepted_at == null ? null : String(invite.accepted_at);
    const expiresAt = invite.expires_at == null ? null : String(invite.expires_at);
    const expired = expiresAt ? Date.parse(expiresAt) <= Date.now() : false;
    const status = acceptedAt ? "accepted" : expired ? "expired" : "valid";
    const athlete = athleteResult.data;
    const athleteName =
      String(athlete?.display_name ?? "").trim() ||
      `${String(athlete?.first_name ?? "").trim()} ${String(athlete?.last_name ?? "").trim()}`.trim() ||
      null;
    const logoUrl = await signedLogoUrl(adminClient, team?.logo_path, team?.logo_updated_at);
    const staffRole = isStaff ? (role === "viewer" ? "viewer" : "editor") : null;
    const inviteFirstName = String(invite.first_name ?? "").trim() || null;
    const inviteLastName = String(invite.last_name ?? "").trim() || null;
    const staffName = isStaff ? [inviteFirstName, inviteLastName].filter(Boolean).join(" ").trim() || null : null;

    return jsonResponse(200, {
      ok: status === "valid",
      status,
      invite_kind: isStaff ? "staff" : "athlete",
      email: invite.email == null ? null : String(invite.email),
      team_name: team?.name == null ? null : String(team.name),
      team_logo_url: logoUrl,
      athlete_name: isAthlete ? athleteName : null,
      staff_role: staffRole,
      staff_name: staffName,
      first_name: isStaff ? inviteFirstName : null,
      last_name: isStaff ? inviteLastName : null,
      expires_at: expiresAt,
      accepted_at: acceptedAt,
      message:
        status === "valid"
          ? "Invite is ready."
          : status === "accepted"
            ? "This invite has already been accepted."
            : "This invite has expired.",
    });
  } catch (error) {
    console.error("get-team-invite failed", error);
    return jsonResponse(500, {
      ok: false,
      status: "invalid",
      invite_kind: null,
      email: null,
      team_name: null,
      team_logo_url: null,
      athlete_name: null,
      staff_role: null,
      staff_name: null,
      first_name: null,
      last_name: null,
      expires_at: null,
      accepted_at: null,
      error: error instanceof Error ? error.message : "Could not load invite.",
    });
  }
});
