drop function if exists public.upsert_own_mileage_feedback(uuid, jsonb);
drop function if exists public.upsert_own_mileage_feedback(jsonb, uuid);

create or replace function public.upsert_own_mileage_feedback(
  p_entry jsonb,
  p_team_id uuid
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

  if p_team_id is null then
    raise exception 'Mileage feedback is missing a team id.';
  end if;

  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'Mileage feedback entry must be a JSON object.';
  end if;

  v_entry_id := btrim(coalesce(p_entry->>'id', ''));
  if v_entry_id = '' then
    raise exception 'Mileage feedback entry is missing an id.';
  end if;

  v_athlete_id := nullif(btrim(coalesce(p_entry->>'athleteId', '')), '')::uuid;
  if v_athlete_id is null then
    raise exception 'Mileage feedback entry is missing an athlete id.';
  end if;

  if btrim(coalesce(p_entry->>'dateISO', '')) = '' then
    raise exception 'Mileage feedback entry is missing a date.';
  end if;

  if upper(btrim(coalesce(p_entry->>'session', ''))) not in ('AM', 'PM') then
    raise exception 'Mileage feedback entry has an invalid session.';
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

revoke all on function public.upsert_own_mileage_feedback(jsonb, uuid) from public;
grant execute on function public.upsert_own_mileage_feedback(jsonb, uuid) to authenticated;

notify pgrst, 'reload schema';
