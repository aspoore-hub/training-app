import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { getCurrentTeamId } from "./team";
import { requireTeamPermission } from "./teamPermissions";

export type TeamWorkoutBatchHeaderRow = {
  id: string;
  team_id: string;
  batch_id: string;
  date_iso: string;
  session: "AM" | "PM";
  header_notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

function normalizeSession(value: string | undefined): "AM" | "PM" {
  return String(value ?? "PM").toUpperCase() === "AM" ? "AM" : "PM";
}

function normalizeDateISO(value: unknown): string {
  const raw = String(value ?? "").trim();
  const match = raw.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? raw;
}

function isMissingRelationOrFunction(error: PostgrestError | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? "").trim();
  const message = String(error.message ?? "").toLowerCase();
  return (
    code === "42P01" || // relation does not exist
    code === "42883" || // function does not exist
    code === "PGRST202" || // function not found in schema cache
    message.includes("does not exist") ||
    message.includes("could not find the function")
  );
}

export async function listTeamWorkoutBatchHeadersForDate(
  dateISO: string
): Promise<TeamWorkoutBatchHeaderRow[]> {
  const teamId = await getCurrentTeamId();
  const { data, error } = await supabase
    .from("team_workout_batch_headers")
    .select("id,team_id,batch_id,date_iso,session,header_notes,created_by,created_at,updated_at")
    .eq("team_id", teamId)
    .eq("date_iso", normalizeDateISO(dateISO));

  if (error) {
    // Fail-open so daily workouts still load even if batch-header table/RLS
    // is not yet aligned in a given environment.
    console.warn("[batch-headers] list failed; falling back to no header rows", {
      code: error.code,
      message: error.message,
    });
    return [];
  }
  return (data ?? []) as TeamWorkoutBatchHeaderRow[];
}

export async function listTeamWorkoutBatchHeadersInRange(
  dateStartISO: string,
  dateEndISO: string
): Promise<TeamWorkoutBatchHeaderRow[]> {
  const teamId = await getCurrentTeamId();
  const { data, error } = await supabase
    .from("team_workout_batch_headers")
    .select("id,team_id,batch_id,date_iso,session,header_notes,created_by,created_at,updated_at")
    .eq("team_id", teamId)
    .gte("date_iso", normalizeDateISO(dateStartISO))
    .lte("date_iso", normalizeDateISO(dateEndISO))
    .order("date_iso", { ascending: true });

  if (error) {
    console.warn("[batch-headers] list range failed; falling back to no header rows", {
      code: error.code,
      message: error.message,
      dateStartISO,
      dateEndISO,
    });
    return [];
  }
  return (data ?? []) as TeamWorkoutBatchHeaderRow[];
}

export async function saveTeamWorkoutBatchHeaderNotes(input: {
  batch_id: string;
  date_iso: string;
  session: "AM" | "PM";
  header_notes: string | null;
}): Promise<{ handledRowPropagation: boolean }> {
  const teamId = await getCurrentTeamId();
  await requireTeamPermission("training.edit", teamId);
  const batchId = String(input.batch_id ?? "").trim();
  const dateISO = String(input.date_iso ?? "").trim();
  const session = normalizeSession(input.session);
  const headerNotes = String(input.header_notes ?? "").trim() || null;

  if (!batchId || !dateISO) return { handledRowPropagation: false };

  const rpcResult = await supabase.rpc("save_batch_header_notes", {
    p_team_id: teamId,
    p_batch_id: batchId,
    p_date_iso: dateISO,
    p_session: session,
    p_header_notes: headerNotes,
    p_propagate_to_rows: true,
  });

  if (!rpcResult.error) {
    return { handledRowPropagation: true };
  }

  if (!isMissingRelationOrFunction(rpcResult.error)) {
    throw rpcResult.error;
  }

  const upsertResult = await supabase
    .from("team_workout_batch_headers")
    .upsert(
      {
        team_id: teamId,
        batch_id: batchId,
        date_iso: dateISO,
        session,
        header_notes: headerNotes,
      },
      { onConflict: "team_id,batch_id,date_iso,session" }
    );
  if (upsertResult.error) {
    if (isMissingRelationOrFunction(upsertResult.error)) return { handledRowPropagation: false };
    throw upsertResult.error;
  }

  return { handledRowPropagation: false };
}
