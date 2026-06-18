create or replace function public.update_own_workout_feedback(
  p_team_id uuid,
  p_workout_id uuid,
  p_athlete_profile_id uuid,
  p_completed_miles numeric,
  p_completed_time_text text,
  p_splits_or_pace text,
  p_additional_feedback text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to submit workout feedback.';
  end if;

  if not exists (
    select 1
    from public.team_workouts tw
    join public.team_athletes ta
      on ta.team_id = tw.team_id
     and ta.id = tw.athlete_profile_id
    where tw.id = p_workout_id
      and tw.team_id = p_team_id
      and tw.athlete_profile_id = p_athlete_profile_id
      and tw.athlete_visible = true
      and ta.claimed_user_id = auth.uid()
  ) then
    raise exception 'You can only submit logs for your own visible workouts.';
  end if;

  update public.team_workouts
  set
    completed_miles = p_completed_miles,
    completed_time_text = nullif(btrim(coalesce(p_completed_time_text, '')), ''),
    splits_or_pace = nullif(btrim(coalesce(p_splits_or_pace, '')), ''),
    additional_feedback = nullif(btrim(coalesce(p_additional_feedback, '')), ''),
    updated_at = now()
  where id = p_workout_id
    and team_id = p_team_id
    and athlete_profile_id = p_athlete_profile_id;
end;
$$;

create or replace function public.upsert_own_mileage_feedback(
  p_team_id uuid,
  p_entry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key constant text := 'training_app_mileage_feedback_v1';
  v_athlete_id uuid;
  v_entry_id text;
  v_existing jsonb := '[]'::jsonb;
  v_next jsonb := '[]'::jsonb;
  v_saved jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to submit mileage feedback.';
  end if;

  v_entry_id := btrim(coalesce(p_entry->>'id', ''));
  if v_entry_id = '' then
    raise exception 'Mileage feedback entry is missing an id.';
  end if;

  v_athlete_id := nullif(btrim(coalesce(p_entry->>'athleteId', '')), '')::uuid;
  if v_athlete_id is null then
    raise exception 'Mileage feedback entry is missing an athlete id.';
  end if;

  if not exists (
    select 1
    from public.team_athletes ta
    where ta.team_id = p_team_id
      and ta.id = v_athlete_id
      and ta.claimed_user_id = auth.uid()
  ) then
    raise exception 'You can only submit mileage feedback for your own athlete profile.';
  end if;

  select coalesce(data, '[]'::jsonb)
  into v_existing
  from public.team_kv_blobs
  where team_id = p_team_id
    and key = v_key
  for update;

  if v_existing is null or jsonb_typeof(v_existing) <> 'array' then
    v_existing := '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(entry), '[]'::jsonb)
  into v_next
  from jsonb_array_elements(v_existing) as entry
  where entry->>'id' <> v_entry_id;

  v_next := v_next || jsonb_build_array(p_entry);

  insert into public.team_kv_blobs (team_id, key, data, version, updated_at)
  values (p_team_id, v_key, v_next, 1, now())
  on conflict (team_id, key)
  do update set
    data = excluded.data,
    version = coalesce(public.team_kv_blobs.version, 0) + 1,
    updated_at = excluded.updated_at
  returning data into v_saved;

  return coalesce(v_saved, v_next);
end;
$$;

create or replace function public.upsert_own_athlete_daily_log_entry(
  p_team_id uuid,
  p_entry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key constant text := 'training_app_athlete_daily_log_entries_v1';
  v_athlete_id uuid;
  v_entry_id text;
  v_existing jsonb := '[]'::jsonb;
  v_next jsonb := '[]'::jsonb;
  v_saved jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to submit daily log entries.';
  end if;

  v_entry_id := btrim(coalesce(p_entry->>'id', ''));
  if v_entry_id = '' then
    raise exception 'Daily log entry is missing an id.';
  end if;

  v_athlete_id := nullif(btrim(coalesce(p_entry->>'athleteId', '')), '')::uuid;
  if v_athlete_id is null then
    raise exception 'Daily log entry is missing an athlete id.';
  end if;

  if not exists (
    select 1
    from public.team_athletes ta
    where ta.team_id = p_team_id
      and ta.id = v_athlete_id
      and ta.claimed_user_id = auth.uid()
  ) then
    raise exception 'You can only submit daily log entries for your own athlete profile.';
  end if;

  select coalesce(data, '[]'::jsonb)
  into v_existing
  from public.team_kv_blobs
  where team_id = p_team_id
    and key = v_key
  for update;

  if v_existing is null or jsonb_typeof(v_existing) <> 'array' then
    v_existing := '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(entry), '[]'::jsonb)
  into v_next
  from jsonb_array_elements(v_existing) as entry
  where entry->>'id' <> v_entry_id;

  v_next := v_next || jsonb_build_array(p_entry);

  insert into public.team_kv_blobs (team_id, key, data, version, updated_at)
  values (p_team_id, v_key, v_next, 1, now())
  on conflict (team_id, key)
  do update set
    data = excluded.data,
    version = coalesce(public.team_kv_blobs.version, 0) + 1,
    updated_at = excluded.updated_at
  returning data into v_saved;

  return coalesce(v_saved, v_next);
end;
$$;

create or replace function public.delete_own_athlete_daily_log_entry(
  p_team_id uuid,
  p_entry_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key constant text := 'training_app_athlete_daily_log_entries_v1';
  v_entry_id text := btrim(coalesce(p_entry_id, ''));
  v_existing jsonb := '[]'::jsonb;
  v_target jsonb;
  v_athlete_id uuid;
  v_next jsonb := '[]'::jsonb;
  v_saved jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to delete daily log entries.';
  end if;

  if v_entry_id = '' then
    raise exception 'Daily log entry is missing an id.';
  end if;

  select coalesce(data, '[]'::jsonb)
  into v_existing
  from public.team_kv_blobs
  where team_id = p_team_id
    and key = v_key
  for update;

  if v_existing is null or jsonb_typeof(v_existing) <> 'array' then
    v_existing := '[]'::jsonb;
  end if;

  select entry
  into v_target
  from jsonb_array_elements(v_existing) as entry
  where entry->>'id' = v_entry_id
  limit 1;

  if v_target is null then
    return v_existing;
  end if;

  v_athlete_id := nullif(btrim(coalesce(v_target->>'athleteId', '')), '')::uuid;
  if v_athlete_id is null or not exists (
    select 1
    from public.team_athletes ta
    where ta.team_id = p_team_id
      and ta.id = v_athlete_id
      and ta.claimed_user_id = auth.uid()
  ) then
    raise exception 'You can only delete daily log entries for your own athlete profile.';
  end if;

  select coalesce(jsonb_agg(entry), '[]'::jsonb)
  into v_next
  from jsonb_array_elements(v_existing) as entry
  where entry->>'id' <> v_entry_id;

  insert into public.team_kv_blobs (team_id, key, data, version, updated_at)
  values (p_team_id, v_key, v_next, 1, now())
  on conflict (team_id, key)
  do update set
    data = excluded.data,
    version = coalesce(public.team_kv_blobs.version, 0) + 1,
    updated_at = excluded.updated_at
  returning data into v_saved;

  return coalesce(v_saved, v_next);
end;
$$;

revoke all on function public.update_own_workout_feedback(uuid, uuid, uuid, numeric, text, text, text) from public;
revoke all on function public.upsert_own_mileage_feedback(uuid, jsonb) from public;
revoke all on function public.upsert_own_athlete_daily_log_entry(uuid, jsonb) from public;
revoke all on function public.delete_own_athlete_daily_log_entry(uuid, text) from public;

grant execute on function public.update_own_workout_feedback(uuid, uuid, uuid, numeric, text, text, text) to authenticated;
grant execute on function public.upsert_own_mileage_feedback(uuid, jsonb) to authenticated;
grant execute on function public.upsert_own_athlete_daily_log_entry(uuid, jsonb) to authenticated;
grant execute on function public.delete_own_athlete_daily_log_entry(uuid, text) to authenticated;
