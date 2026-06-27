alter table public.team_invites
  add column if not exists first_name text,
  add column if not exists last_name text;

alter table public.profiles
  add column if not exists first_name text,
  add column if not exists last_name text;

create or replace function public.list_team_staff_identity(p_team_id uuid)
returns table (
  team_id uuid,
  user_id uuid,
  role text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  profile_first_name text,
  profile_last_name text,
  profile_display_name text,
  email text
)
language sql
stable
security definer
set search_path = public
as $$
  with owner_row as (
    select
      t.id as team_id,
      t.owner_id as user_id,
      coalesce(tm.role, 'owner') as role,
      coalesce(tm.created_at, t.created_at) as created_at,
      tm.updated_at as updated_at,
      true as is_owner
    from public.teams t
    left join public.team_members tm
      on tm.team_id = t.id
      and tm.user_id = t.owner_id
    where t.id = p_team_id
      and public.can_view_team(p_team_id, auth.uid())
  ),
  member_rows as (
    select
      tm.team_id,
      tm.user_id,
      tm.role,
      tm.created_at,
      tm.updated_at,
      false as is_owner
    from public.team_members tm
    join public.teams t on t.id = tm.team_id
    where tm.team_id = p_team_id
      and tm.user_id <> t.owner_id
      and public.can_view_team(p_team_id, auth.uid())
  ),
  staff_rows as (
    select * from owner_row
    union all
    select * from member_rows
  )
  select
    sr.team_id,
    sr.user_id,
    sr.role,
    sr.created_at,
    sr.updated_at,
    sr.is_owner,
    p.first_name as profile_first_name,
    p.last_name as profile_last_name,
    p.display_name as profile_display_name,
    lower(u.email) as email
  from staff_rows sr
  left join public.profiles p on p.id = sr.user_id
  left join auth.users u on u.id = sr.user_id
  order by
    sr.is_owner desc,
    lower(coalesce(nullif(p.last_name, ''), nullif(p.display_name, ''), u.email, sr.user_id::text)),
    lower(coalesce(nullif(p.first_name, ''), ''));
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
  v_user_email text;
  v_role text;
  v_existing_role text;
  v_final_role text;
  v_is_owner boolean := false;
  v_invite_first_name text;
  v_invite_last_name text;
  v_invite_display_name text;
begin
  if v_user_id is null then
    raise exception 'Not signed in';
  end if;

  select lower(trim(u.email))
  into v_user_email
  from auth.users u
  where u.id = v_user_id;

  select *
  into v_invite
  from public.team_invites
  where token = p_token
  limit 1;

  if not found then
    raise exception 'Invalid invite';
  end if;

  if v_invite.accepted_at is not null then
    raise exception 'Invite already accepted';
  end if;

  if v_invite.expires_at is not null and v_invite.expires_at <= now() then
    raise exception 'Invite expired';
  end if;

  v_role := lower(coalesce(v_invite.role, 'athlete'));

  if v_role not in ('editor', 'viewer', 'coach')
    and nullif(lower(trim(coalesce(v_invite.email, ''))), '') is null then
    raise exception 'Athlete invite is missing an email address';
  end if;

  if nullif(lower(trim(coalesce(v_invite.email, ''))), '') is not null
    and lower(trim(coalesce(v_invite.email, ''))) <> coalesce(v_user_email, '') then
    raise exception 'Invite email does not match signed-in account';
  end if;

  if v_role in ('editor', 'viewer', 'coach') then
    v_role := case when v_role = 'viewer' then 'viewer' else 'editor' end;
    v_invite_first_name := nullif(trim(coalesce(v_invite.first_name, '')), '');
    v_invite_last_name := nullif(trim(coalesce(v_invite.last_name, '')), '');
    v_invite_display_name := nullif(trim(concat_ws(' ', v_invite_first_name, v_invite_last_name)), '');

    select exists (
      select 1
      from public.teams t
      where t.id = v_invite.team_id
        and t.owner_id = v_user_id
    )
    into v_is_owner;

    select lower(coalesce(tm.role, ''))
    into v_existing_role
    from public.team_members tm
    where tm.team_id = v_invite.team_id
      and tm.user_id = v_user_id;

    v_final_role := v_role;
    if v_is_owner then
      v_final_role := case
        when v_existing_role in ('editor', 'viewer', 'coach', 'admin', 'member') then v_existing_role
        else 'editor'
      end;
    elsif v_existing_role in ('editor', 'coach', 'admin', 'member') and v_role = 'viewer' then
      v_final_role := v_existing_role;
    end if;

    insert into public.team_members (team_id, user_id, role)
    values (v_invite.team_id, v_user_id, v_final_role)
    on conflict (team_id, user_id)
    do update set role = excluded.role;

    insert into public.profiles (
      id,
      role,
      current_team_id,
      first_name,
      last_name,
      display_name,
      created_at,
      updated_at
    )
    values (
      v_user_id,
      'coach',
      v_invite.team_id,
      v_invite_first_name,
      v_invite_last_name,
      v_invite_display_name,
      now(),
      now()
    )
    on conflict (id)
    do update set
      role = 'coach',
      current_team_id = excluded.current_team_id,
      first_name = case
        when nullif(trim(coalesce(profiles.first_name, '')), '') is null then excluded.first_name
        else profiles.first_name
      end,
      last_name = case
        when nullif(trim(coalesce(profiles.last_name, '')), '') is null then excluded.last_name
        else profiles.last_name
      end,
      display_name = case
        when nullif(trim(coalesce(profiles.display_name, '')), '') is null then excluded.display_name
        else profiles.display_name
      end,
      updated_at = now();

    update public.team_invites
    set accepted_at = now()
    where token = p_token
      and accepted_at is null;

    return jsonb_build_object(
      'team_id', v_invite.team_id,
      'athlete_profile_id', null,
      'role', case when v_is_owner then 'owner' else v_final_role end
    );
  end if;

  if v_invite.athlete_profile_id is null then
    raise exception 'Athlete invite is missing an athlete profile';
  end if;

  update public.team_athletes
  set claimed_user_id = v_user_id,
      updated_at = now()
  where id = v_invite.athlete_profile_id
    and team_id = v_invite.team_id
    and (claimed_user_id is null or claimed_user_id = v_user_id);

  if not found then
    raise exception 'Athlete invite has already been claimed';
  end if;

  insert into public.profiles (id, role, current_team_id, created_at, updated_at)
  values (v_user_id, 'athlete', v_invite.team_id, now(), now())
  on conflict (id)
  do update set role = 'athlete', current_team_id = excluded.current_team_id, updated_at = now();

  update public.team_invites
  set accepted_at = now()
  where token = p_token
    and accepted_at is null;

  return jsonb_build_object(
    'team_id', v_invite.team_id,
    'athlete_profile_id', v_invite.athlete_profile_id,
    'role', 'athlete'
  );
end;
$$;
