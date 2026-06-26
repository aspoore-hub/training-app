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

    insert into public.profiles (id, role, current_team_id, created_at, updated_at)
    values (v_user_id, 'coach', v_invite.team_id, now(), now())
    on conflict (id)
    do update set role = 'coach', current_team_id = excluded.current_team_id, updated_at = now();

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
