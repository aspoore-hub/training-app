// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";

type InviteRow = {
  id: string;
  token: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  athlete_profile_id: string | null;
  team_id: string;
  expires_at: string | null;
  accepted_at: string | null;
};

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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim();
}

function dotStuff(value: string) {
  return value
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function encodeBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readSmtpResponse(conn: Deno.TlsConn) {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(4096);
  let response = "";

  while (true) {
    const n = await conn.read(buffer);
    if (n === null) break;
    response += decoder.decode(buffer.subarray(0, n));
    const lines = response.split(/\r?\n/).filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? "";
    if (/^\d{3} /.test(lastLine)) return { code: Number(lastLine.slice(0, 3)), response };
  }

  return { code: 0, response };
}

async function smtpCommand(conn: Deno.TlsConn, command: string, expected: number[]) {
  const encoder = new TextEncoder();
  await conn.write(encoder.encode(`${command}\r\n`));
  const result = await readSmtpResponse(conn);
  if (!expected.includes(result.code)) {
    throw new Error(`SMTP command failed: ${command.split(" ")[0]} (${result.response.trim()})`);
  }
  return result;
}

async function sendZohoEmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const host = requiredEnv("ZOHO_SMTP_HOST");
  const port = Number(requiredEnv("ZOHO_SMTP_PORT"));
  const username = requiredEnv("ZOHO_SMTP_USER");
  const password = requiredEnv("ZOHO_SMTP_PASS");
  const from = requiredEnv("INVITE_EMAIL_FROM");
  const fromAddress = parseAddress(from) || username;
  const boundary = `trackside-${crypto.randomUUID()}`;
  const message = [
    `From: ${from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.html,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const conn = await Deno.connectTls({ hostname: host, port });
  try {
    const greeting = await readSmtpResponse(conn);
    if (greeting.code !== 220) throw new Error(`SMTP greeting failed: ${greeting.response.trim()}`);

    await smtpCommand(conn, "EHLO tracksidecoach.com", [250]);
    await smtpCommand(conn, "AUTH LOGIN", [334]);
    await smtpCommand(conn, encodeBase64(username), [334]);
    await smtpCommand(conn, encodeBase64(password), [235]);
    await smtpCommand(conn, `MAIL FROM:<${fromAddress}>`, [250]);
    await smtpCommand(conn, `RCPT TO:<${input.to}>`, [250, 251]);
    await smtpCommand(conn, "DATA", [354]);
    await smtpCommand(conn, `${dotStuff(message)}\r\n.`, [250]);
    await smtpCommand(conn, "QUIT", [221]);
  } finally {
    try {
      conn.close();
    } catch {
      // no-op
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const anonKey = requiredEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const authHeader = req.headers.get("Authorization") ?? "";
    const siteUrl = requiredEnv("PUBLIC_SITE_URL").replace(/\/+$/, "");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) {
      return jsonResponse(401, { ok: false, error: "Not authenticated" });
    }

    const body = await req.json().catch(() => ({}));
    const inviteId = String(body?.invite_id ?? "").trim();
    if (!inviteId) return jsonResponse(400, { ok: false, error: "Missing invite_id" });

    const { data: invite, error: inviteError } = await adminClient
      .from("team_invites")
      .select("id,token,email,first_name,last_name,role,athlete_profile_id,team_id,expires_at,accepted_at")
      .eq("id", inviteId)
      .maybeSingle();
    if (inviteError) throw inviteError;
    if (!invite) return jsonResponse(404, { ok: false, error: "Invite not found" });

    const inviteRow = invite as InviteRow;
    const role = String(inviteRow.role ?? "").trim().toLowerCase();
    if (role !== "viewer" && role !== "editor" && role !== "coach") {
      return jsonResponse(400, { ok: false, error: "Only staff invites can be sent by this function" });
    }
    if (inviteRow.athlete_profile_id) return jsonResponse(400, { ok: false, error: "Staff invite cannot include an athlete profile" });
    if (!inviteRow.email) return jsonResponse(400, { ok: false, error: "Invite has no email address" });
    if (!inviteRow.token) return jsonResponse(400, { ok: false, error: "Invite has no token" });
    if (inviteRow.accepted_at) return jsonResponse(409, { ok: false, error: "Invite has already been accepted" });
    if (inviteRow.expires_at && Date.parse(inviteRow.expires_at) <= Date.now()) {
      return jsonResponse(410, { ok: false, error: "Invite has expired" });
    }

    const { data: canManage } = await adminClient.rpc("can_manage_team_coaches", {
      p_team_id: inviteRow.team_id,
      p_user_id: userData.user.id,
    });
    if (canManage !== true) {
      return jsonResponse(403, { ok: false, error: "You do not have permission to send this invite" });
    }

    const { data: team, error: teamError } = await adminClient
      .from("teams")
      .select("name")
      .eq("id", inviteRow.team_id)
      .maybeSingle();
    if (teamError) throw teamError;

    const teamName = String(team?.name ?? "your team").trim() || "your team";
    const permissionLabel = role === "viewer" ? "Viewer" : "Editor";
    const inviteeName = [inviteRow.first_name, inviteRow.last_name]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(" ");
    const greeting = inviteeName ? `Hi ${inviteeName},` : "Hi,";
    const inviteUrl = `${siteUrl}/join?token=${encodeURIComponent(inviteRow.token)}`;
    const subject = `Accept your ${teamName} staff invite`;
    const text = [
      greeting,
      "",
      `You have been invited to join ${teamName} on Trackside Coach as ${permissionLabel}.`,
      "",
      `Open this link to create your account or sign in and accept your invite:`,
      inviteUrl,
      "",
      "If you were not expecting this invite, you can ignore this email.",
    ].join("\n");
    const html = [
      `<p>${escapeHtml(greeting)}</p>`,
      `<p>You have been invited to join <strong>${escapeHtml(teamName)}</strong> on Trackside Coach as <strong>${escapeHtml(permissionLabel)}</strong>.</p>`,
      `<p><a href="${escapeHtml(inviteUrl)}">Create your account or sign in and accept invite</a></p>`,
      `<p>If the button does not work, copy and paste this link:</p>`,
      `<p>${escapeHtml(inviteUrl)}</p>`,
      `<p>If you were not expecting this invite, you can ignore this email.</p>`,
    ].join("\n");

    await sendZohoEmail({
      to: inviteRow.email,
      subject,
      text,
      html,
    });

    return jsonResponse(200, {
      ok: true,
      message: "Staff invite email sent.",
      invite_url: inviteUrl,
    });
  } catch (error) {
    console.error("send-coach-invite failed", error);
    return jsonResponse(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Invite email failed to send",
    });
  }
});
