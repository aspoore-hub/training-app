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
        email: null,
        team_name: null,
        athlete_name: null,
        expires_at: null,
        accepted_at: null,
        error: "Missing invite token.",
      });
    }

    const adminClient = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: invite, error: inviteError } = await adminClient
      .from("team_invites")
      .select("token,email,role,athlete_profile_id,team_id,expires_at,accepted_at")
      .eq("token", token)
      .maybeSingle();
    if (inviteError) throw inviteError;

    if (!invite || String(invite.role ?? "").trim().toLowerCase() !== "athlete") {
      return jsonResponse(404, {
        ok: false,
        status: "invalid",
        email: null,
        team_name: null,
        athlete_name: null,
        expires_at: null,
        accepted_at: null,
        error: "This invite link is invalid.",
      });
    }

    const [{ data: team, error: teamError }, { data: athlete, error: athleteError }] = await Promise.all([
      adminClient.from("teams").select("name").eq("id", invite.team_id).maybeSingle(),
      adminClient
        .from("team_athletes")
        .select("display_name,first_name,last_name")
        .eq("team_id", invite.team_id)
        .eq("id", invite.athlete_profile_id)
        .maybeSingle(),
    ]);
    if (teamError) throw teamError;
    if (athleteError) throw athleteError;

    const acceptedAt = invite.accepted_at == null ? null : String(invite.accepted_at);
    const expiresAt = invite.expires_at == null ? null : String(invite.expires_at);
    const expired = expiresAt ? Date.parse(expiresAt) <= Date.now() : false;
    const status = acceptedAt ? "accepted" : expired ? "expired" : "valid";
    const athleteName =
      String(athlete?.display_name ?? "").trim() ||
      `${String(athlete?.first_name ?? "").trim()} ${String(athlete?.last_name ?? "").trim()}`.trim() ||
      null;

    return jsonResponse(200, {
      ok: status === "valid",
      status,
      email: invite.email == null ? null : String(invite.email),
      team_name: team?.name == null ? null : String(team.name),
      athlete_name: athleteName,
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
    console.error("get-athlete-invite failed", error);
    return jsonResponse(500, {
      ok: false,
      status: "invalid",
      email: null,
      team_name: null,
      athlete_name: null,
      expires_at: null,
      accepted_at: null,
      error: error instanceof Error ? error.message : "Could not load invite.",
    });
  }
});
