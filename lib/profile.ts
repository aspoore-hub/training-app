import { supabase } from "./supabase";

export type UserRole = "coach" | "athlete";

export async function getMyProfile(): Promise<{ role: UserRole } | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return { role: data.role as UserRole };
}

export async function getMyProfileFull(): Promise<{ role: UserRole; current_team_id: string | null } | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("role,current_team_id")
    .eq("id", user.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return { role: data.role as UserRole, current_team_id: (data.current_team_id as string) ?? null };
}

export async function ensureProfile(roleIfMissing?: UserRole): Promise<UserRole | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return null;

  const existing = await getMyProfile();
  if (existing) return existing.role;

  if (!roleIfMissing) return null;

  const now = new Date().toISOString();
  const { error } = await supabase.from("profiles").insert({
    id: user.id,
    role: roleIfMissing,
    created_at: now,
    updated_at: now,
  });

  if (error) throw error;
  return roleIfMissing;
}

export async function setMyRole(role: UserRole): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) throw new Error("Not signed in");

  const { error } = await supabase
    .from("profiles")
    .upsert({ id: user.id, role, updated_at: new Date().toISOString() }, { onConflict: "id" });

  if (error) throw error;
}
