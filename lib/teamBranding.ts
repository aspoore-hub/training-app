import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";

export const TEAM_LOGOS_BUCKET = "team-logos";
export const TEAM_LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const TEAM_LOGO_ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type TeamBranding = {
  id: string;
  name: string;
  logoPath: string | null;
  logoUpdatedAt: string | null;
  logoUrl: string | null;
};

type TeamBrandingRow = {
  id: string;
  name: string | null;
  logo_path?: string | null;
  logo_updated_at?: string | null;
};

function normalizeBrandingRow(row: TeamBrandingRow, logoUrl: string | null): TeamBranding {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? "").trim() || "My Team",
    logoPath: row.logo_path == null ? null : String(row.logo_path),
    logoUpdatedAt: row.logo_updated_at == null ? null : String(row.logo_updated_at),
    logoUrl,
  };
}

function appendLogoVersion(url: string, updatedAt: string | null) {
  const version = String(updatedAt ?? "").trim();
  if (!version) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;
}

async function createTeamLogoUrl(path: string | null | undefined, updatedAt: string | null | undefined) {
  const cleanPath = String(path ?? "").trim();
  if (!cleanPath) return null;

  const { data, error } = await supabase.storage
    .from(TEAM_LOGOS_BUCKET)
    .createSignedUrl(cleanPath, 60 * 60 * 24 * 7);
  if (error) throw error;
  const signedUrl = String(data?.signedUrl ?? "").trim();
  return signedUrl ? appendLogoVersion(signedUrl, updatedAt ?? null) : null;
}

export async function loadTeamBranding(teamId?: string | null): Promise<TeamBranding> {
  const resolvedTeamId = String(teamId ?? (await getCurrentTeamId()) ?? "").trim();
  if (!resolvedTeamId) throw new Error("No current team.");

  const { data, error } = await supabase
    .from("teams")
    .select("id,name,logo_path,logo_updated_at")
    .eq("id", resolvedTeamId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Team not found.");

  const row = data as TeamBrandingRow;
  const logoUrl = await createTeamLogoUrl(row.logo_path, row.logo_updated_at);
  return normalizeBrandingRow(row, logoUrl);
}

async function updateTeamBranding(args: {
  teamId: string;
  name?: string | null;
  logoPath?: string | null;
  updateLogo?: boolean;
}): Promise<TeamBranding> {
  const { data, error } = await supabase.rpc("update_team_branding", {
    p_team_id: args.teamId,
    p_name: args.name ?? null,
    p_logo_path: args.logoPath ?? null,
    p_update_logo: !!args.updateLogo,
  });
  if (error) throw error;

  const row = Array.isArray(data) ? (data[0] as TeamBrandingRow | undefined) : (data as TeamBrandingRow | null);
  if (!row) throw new Error("Team branding was not updated.");
  const logoUrl = await createTeamLogoUrl(row.logo_path, row.logo_updated_at);
  return normalizeBrandingRow(row, logoUrl);
}

export async function saveTeamBrandingName(name: string): Promise<TeamBranding> {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw new Error("Team name is required.");
  const teamId = await getCurrentTeamId();
  return updateTeamBranding({ teamId, name: cleanName });
}

function extensionForLogoFile(fileName: string, contentType: string) {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".png") || contentType === "image/png") return "png";
  if (lowerName.endsWith(".webp") || contentType === "image/webp") return "webp";
  return "jpg";
}

export function validateTeamLogoFile(file: { size?: number; type?: string; name?: string }) {
  const contentType = String(file.type ?? "").toLowerCase();
  const size = Number(file.size ?? 0);
  if (!TEAM_LOGO_ALLOWED_TYPES.includes(contentType as any)) {
    throw new Error("Choose a PNG, JPG, or WebP logo.");
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("Choose a valid logo file.");
  }
  if (size > TEAM_LOGO_MAX_BYTES) {
    throw new Error("Logo must be 2 MB or smaller.");
  }
}

export async function uploadTeamLogo(file: File): Promise<TeamBranding> {
  validateTeamLogoFile(file);
  const teamId = await getCurrentTeamId();
  const ext = extensionForLogoFile(String(file.name ?? ""), String(file.type ?? ""));
  const path = `${teamId}/logo-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(TEAM_LOGOS_BUCKET)
    .upload(path, file, {
      cacheControl: "3600",
      contentType: file.type,
      upsert: false,
    });
  if (uploadError) throw uploadError;

  return updateTeamBranding({
    teamId,
    logoPath: path,
    updateLogo: true,
  });
}

export async function clearTeamLogo(): Promise<TeamBranding> {
  const teamId = await getCurrentTeamId();
  return updateTeamBranding({
    teamId,
    logoPath: null,
    updateLogo: true,
  });
}
