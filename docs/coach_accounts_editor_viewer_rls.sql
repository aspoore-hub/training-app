-- Additional coach accounts: owner/editor/viewer roles and RLS.
-- Run in Supabase SQL editor after reviewing table names against production.

create or replace function public.current_team_role(p_team_id uuid, p_user_id uuid default auth.uid())
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.teams t
      where t.id = p_team_id and t.owner_id = p_user_id
    ) then 'owner'
    else coalesce((
      select case
        when lower(tm.role) in ('owner') then 'owner'
        when lower(tm.role) in ('viewer') then 'viewer'
        when lower(tm.role) in ('editor', 'coach', 'admin', 'member') then 'editor'
        else null
      end
      from public.team_members tm
      where tm.team_id = p_team_id and tm.user_id = p_user_id
      limit 1
    ), 'none')
  end
$$;

create or replace function public.can_view_team(p_team_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_team_role(p_team_id, p_user_id) in ('owner', 'editor', 'viewer')
$$;

create or replace function public.can_write_team(p_team_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_team_role(p_team_id, p_user_id) in ('owner', 'editor')
$$;

create or replace function public.can_manage_team_coaches(p_team_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_team_role(p_team_id, p_user_id) = 'owner'
$$;

create or replace function public.is_claimed_team_athlete(
  p_team_id uuid,
  p_athlete_profile_id uuid,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.team_athletes ta
    where ta.team_id = p_team_id
      and ta.id = p_athlete_profile_id
      and ta.claimed_user_id = p_user_id
  )
$$;

create or replace function public.can_discover_team(p_team_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.teams t
    where t.id = p_team_id
      and t.owner_id = p_user_id
  )
  or exists (
    select 1
    from public.team_members tm
    where tm.team_id = p_team_id
      and tm.user_id = p_user_id
  )
  or exists (
    select 1
    from public.team_athletes ta
    where ta.team_id = p_team_id
      and ta.claimed_user_id = p_user_id
  )
$$;

create or replace function public.accept_team_invite(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.team_invites%rowtype;
  v_user_id uuid := auth.uid();
  v_role text;
begin
  if v_user_id is null then
    raise exception 'Not signed in';
  end if;

  select *
  into v_invite
  from public.team_invites
  where token = p_token
    and (expires_at is null or expires_at > now())
  limit 1;

  if not found then
    raise exception 'Invalid or expired invite';
  end if;

  v_role := lower(coalesce(v_invite.role, 'athlete'));

  if v_role in ('editor', 'viewer', 'coach') then
    v_role := case when v_role = 'viewer' then 'viewer' else 'editor' end;

    insert into public.team_members (team_id, user_id, role)
    values (v_invite.team_id, v_user_id, v_role)
    on conflict (team_id, user_id)
    do update set role = excluded.role;

    insert into public.profiles (id, role, current_team_id, created_at, updated_at)
    values (v_user_id, 'coach', v_invite.team_id, now(), now())
    on conflict (id)
    do update set role = 'coach', current_team_id = excluded.current_team_id, updated_at = now();

    return jsonb_build_object(
      'team_id', v_invite.team_id,
      'athlete_profile_id', null,
      'role', v_role
    );
  end if;

  if v_invite.athlete_profile_id is null then
    raise exception 'Athlete invite is missing an athlete profile';
  end if;

  update public.team_athletes
  set claimed_user_id = v_user_id,
      updated_at = now()
  where id = v_invite.athlete_profile_id
    and team_id = v_invite.team_id;

  insert into public.profiles (id, role, current_team_id, created_at, updated_at)
  values (v_user_id, 'athlete', v_invite.team_id, now(), now())
  on conflict (id)
  do update set role = 'athlete', current_team_id = excluded.current_team_id, updated_at = now();

  return jsonb_build_object(
    'team_id', v_invite.team_id,
    'athlete_profile_id', v_invite.athlete_profile_id,
    'role', 'athlete'
  );
end;
$$;

alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.team_workouts enable row level security;
alter table public.team_workout_batch_headers enable row level security;
alter table public.team_mileage_cells enable row level security;
alter table public.team_mileage_day_flags enable row level security;
alter table public.team_mileage_week_visibility enable row level security;
alter table public.team_athletes enable row level security;
alter table public.team_training_groups enable row level security;
alter table public.team_training_group_memberships enable row level security;
alter table public.team_seasons enable row level security;
alter table public.team_athlete_season_overrides enable row level security;
alter table public.team_kv_blobs enable row level security;
alter table public.teams enable row level security;

drop policy if exists "teams_select_owner_member_or_claimed_athlete" on public.teams;
create policy "teams_select_owner_member_or_claimed_athlete"
on public.teams for select
using (public.can_discover_team(id));

do $$
declare
  r record;
  tables text[] := array[
    'team_members',
    'team_invites',
    'team_workouts',
    'team_workout_batch_headers',
    'team_mileage_cells',
    'team_mileage_day_flags',
    'team_mileage_week_visibility',
    'team_athletes',
    'team_training_groups',
    'team_training_group_memberships',
    'team_seasons',
    'team_athlete_season_overrides',
    'team_kv_blobs'
  ];
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any(tables)
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

create policy "team_members_select_team_staff"
on public.team_members for select
using (public.can_view_team(team_id));

create policy "team_members_owner_insert"
on public.team_members for insert
with check (public.can_manage_team_coaches(team_id));

create policy "team_members_owner_update_non_owner"
on public.team_members for update
using (public.can_manage_team_coaches(team_id) and public.current_team_role(team_id, user_id) <> 'owner')
with check (public.can_manage_team_coaches(team_id) and lower(role) in ('editor', 'viewer'));

create policy "team_members_owner_delete_non_owner"
on public.team_members for delete
using (public.can_manage_team_coaches(team_id) and public.current_team_role(team_id, user_id) <> 'owner');

create policy "team_invites_owner_select"
on public.team_invites for select
using (public.can_manage_team_coaches(team_id) or public.can_write_team(team_id));

create policy "team_invites_owner_or_editor_insert"
on public.team_invites for insert
with check (
  (lower(role) = 'athlete' and public.can_write_team(team_id))
  or (lower(role) in ('editor', 'viewer') and public.can_manage_team_coaches(team_id))
);

create policy "team_invites_owner_update"
on public.team_invites for update
using (public.can_manage_team_coaches(team_id))
with check (public.can_manage_team_coaches(team_id));

create policy "team_invites_owner_delete"
on public.team_invites for delete
using (public.can_manage_team_coaches(team_id));

create policy "team_workouts_select_staff_or_visible_athlete"
on public.team_workouts for select
using (
  public.can_view_team(team_id)
  or (
    athlete_visible = true
    and public.is_claimed_team_athlete(team_id, athlete_profile_id)
  )
);

create policy "team_workouts_write_owner_editor"
on public.team_workouts for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create policy "team_workout_batch_headers_select_staff"
on public.team_workout_batch_headers for select
using (public.can_view_team(team_id));

create policy "team_workout_batch_headers_write_owner_editor"
on public.team_workout_batch_headers for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create policy "team_mileage_cells_select_staff_or_visible_athlete"
on public.team_mileage_cells for select
using (
  public.can_view_team(team_id)
  or (
    public.is_claimed_team_athlete(team_id, athlete_profile_id)
    and exists (
      select 1
      from public.team_mileage_week_visibility v
      where v.team_id = team_mileage_cells.team_id
        and v.athlete_profile_id = team_mileage_cells.athlete_profile_id
        and v.week_start_iso = team_mileage_cells.week_start_iso
        and v.athlete_visible = true
    )
  )
);

create policy "team_mileage_cells_write_owner_editor"
on public.team_mileage_cells for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create policy "team_mileage_day_flags_select_staff_or_visible_athlete"
on public.team_mileage_day_flags for select
using (
  public.can_view_team(team_id)
  or (
    public.is_claimed_team_athlete(team_id, athlete_profile_id)
    and exists (
      select 1
      from public.team_mileage_week_visibility v
      where v.team_id = team_mileage_day_flags.team_id
        and v.athlete_profile_id = team_mileage_day_flags.athlete_profile_id
        and v.week_start_iso = team_mileage_day_flags.week_start_iso
        and v.athlete_visible = true
    )
  )
);

create policy "team_mileage_day_flags_write_owner_editor"
on public.team_mileage_day_flags for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create policy "team_mileage_week_visibility_select_staff_or_visible_athlete"
on public.team_mileage_week_visibility for select
using (
  public.can_view_team(team_id)
  or (
    athlete_visible = true
    and public.is_claimed_team_athlete(team_id, athlete_profile_id)
  )
);

create policy "team_mileage_week_visibility_write_owner_editor"
on public.team_mileage_week_visibility for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create policy "team_athletes_select_staff_or_self"
on public.team_athletes for select
using (public.can_view_team(team_id) or claimed_user_id = auth.uid());

create policy "team_athletes_write_owner_editor"
on public.team_athletes for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create policy "team_training_groups_select_staff"
on public.team_training_groups for select
using (public.can_view_team(team_id));

create policy "team_training_groups_write_owner_editor"
on public.team_training_groups for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create policy "team_training_group_memberships_select_staff"
on public.team_training_group_memberships for select
using (public.can_view_team(team_id));

create policy "team_training_group_memberships_write_owner_editor"
on public.team_training_group_memberships for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create policy "team_seasons_select_staff"
on public.team_seasons for select
using (public.can_view_team(team_id));

create policy "team_seasons_write_owner_editor"
on public.team_seasons for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create policy "team_athlete_season_overrides_select_staff"
on public.team_athlete_season_overrides for select
using (public.can_view_team(team_id));

create policy "team_athlete_season_overrides_write_owner_editor"
on public.team_athlete_season_overrides for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create policy "team_kv_blobs_select_staff"
on public.team_kv_blobs for select
using (public.can_view_team(team_id));

create policy "team_kv_blobs_write_owner_editor"
on public.team_kv_blobs for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create index if not exists team_members_team_role_idx
on public.team_members (team_id, role);

create index if not exists team_invites_team_role_email_idx
on public.team_invites (team_id, role, email);

create index if not exists team_workouts_team_visibility_idx
on public.team_workouts (team_id, athlete_profile_id, date_iso, athlete_visible);

create index if not exists team_mileage_week_visibility_lookup_idx
on public.team_mileage_week_visibility (team_id, athlete_profile_id, week_start_iso, athlete_visible);
