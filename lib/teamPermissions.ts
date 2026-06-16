import { supabase } from "./supabase";

export type TeamRole = "owner" | "editor" | "viewer";
export type TeamMemberRoleValue = TeamRole | "coach" | "admin" | "member" | string | null | undefined;

export type TeamPermission =
  | "team.view"
  | "team.manage_settings"
  | "coaches.manage"
  | "roster.edit"
  | "training.edit"
  | "training.publish"
  | "mileage.edit"
  | "logs.view"
  | "catalog.edit"
  | "plan_builder.apply"
  | "exports.create";

const VIEWER_EDITING_DISABLED_MESSAGE = "You have viewer access. Editing is disabled.";

export function normalizeTeamRole(role: TeamMemberRoleValue): TeamRole {
  const value = String(role ?? "").trim().toLowerCase();
  if (value === "owner") return "owner";
  if (value === "viewer") return "viewer";
  if (value === "editor") return "editor";
  if (value === "coach" || value === "admin" || value === "member") return "editor";
  return "viewer";
}

export function canManageCoaches(role: TeamMemberRoleValue): boolean {
  return normalizeTeamRole(role) === "owner";
}

export function canEditTraining(role: TeamMemberRoleValue): boolean {
  const normalized = normalizeTeamRole(role);
  return normalized === "owner" || normalized === "editor";
}

export function canPublishTraining(role: TeamMemberRoleValue): boolean {
  return canEditTraining(role);
}

export function canEditMileage(role: TeamMemberRoleValue): boolean {
  const normalized = normalizeTeamRole(role);
  return normalized === "owner" || normalized === "editor";
}

export function canEditRoster(role: TeamMemberRoleValue): boolean {
  const normalized = normalizeTeamRole(role);
  return normalized === "owner" || normalized === "editor";
}

export function canEditSettings(role: TeamMemberRoleValue): boolean {
  return normalizeTeamRole(role) === "owner";
}

export function canApplyPlanBuilder(role: TeamMemberRoleValue): boolean {
  const normalized = normalizeTeamRole(role);
  return normalized === "owner" || normalized === "editor";
}

export function canExport(role: TeamMemberRoleValue): boolean {
  return normalizeTeamRole(role) === "owner" || normalizeTeamRole(role) === "editor" || normalizeTeamRole(role) === "viewer";
}

export function hasTeamPermission(role: TeamMemberRoleValue, permission: TeamPermission): boolean {
  const normalized = normalizeTeamRole(role);
  if (permission === "team.view" || permission === "logs.view" || permission === "exports.create") return true;
  if (permission === "coaches.manage" || permission === "team.manage_settings") return normalized === "owner";
  if (permission === "training.edit" || permission === "training.publish" || permission === "catalog.edit") {
    return normalized === "owner" || normalized === "editor";
  }
  if (permission === "mileage.edit" || permission === "roster.edit" || permission === "plan_builder.apply") {
    return normalized === "owner" || normalized === "editor";
  }
  return false;
}

async function getSessionUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user?.id ?? null;
}

async function getProfileTeamId(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("current_team_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.current_team_id as string) ?? null;
}

export async function getCurrentTeamRole(teamId?: string | null): Promise<TeamRole | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const resolvedTeamId = teamId ?? await getProfileTeamId(userId);
  if (!resolvedTeamId) return null;

  const { data: team, error: teamError } = await supabase
    .from("teams")
    .select("owner_id")
    .eq("id", resolvedTeamId)
    .maybeSingle();
  if (teamError) throw teamError;
  if (String(team?.owner_id ?? "") === userId) return "owner";

  const { data: member, error: memberError } = await supabase
    .from("team_members")
    .select("role")
    .eq("team_id", resolvedTeamId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) return null;
  return normalizeTeamRole(member.role as string | null);
}

export async function requireTeamPermission(permission: TeamPermission, teamId?: string | null): Promise<TeamRole> {
  const role = await getCurrentTeamRole(teamId);
  if (!role || !hasTeamPermission(role, permission)) {
    throw new Error(permission === "team.view" ? "You do not have access to this team." : VIEWER_EDITING_DISABLED_MESSAGE);
  }
  return role;
}

