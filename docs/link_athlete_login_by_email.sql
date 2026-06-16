-- Link roster athlete login access to an existing Supabase auth user by email.
-- Email is lookup-only; team_athletes.claimed_user_id remains the access identifier.

create or replace function public.link_team_athlete_to_existing_user_email(
  p_team_id uuid,
  p_athlete_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_caller uuid := auth.uid();
  v_email text := lower(trim(coalesce(p_email, '')));
  v_found_user_id uuid;
  v_existing_same_team_athlete_id uuid;
  v_athlete_exists boolean;
begin
  if v_caller is null then
    return jsonb_build_object(
      'status', 'unauthorized',
      'athlete_id', p_athlete_id,
      'linked_user_id', null,
      'linked_email', v_email,
      'message', 'You must be signed in to link athlete login access.'
    );
  end if;

  if not public.can_write_team(p_team_id, v_caller) then
    return jsonb_build_object(
      'status', 'unauthorized',
      'athlete_id', p_athlete_id,
      'linked_user_id', null,
      'linked_email', v_email,
      'message', 'You do not have permission to link athlete login access.'
    );
  end if;

  select exists (
    select 1
    from public.team_athletes ta
    where ta.id = p_athlete_id
      and ta.team_id = p_team_id
  )
  into v_athlete_exists;

  if not v_athlete_exists then
    return jsonb_build_object(
      'status', 'unauthorized',
      'athlete_id', p_athlete_id,
      'linked_user_id', null,
      'linked_email', v_email,
      'message', 'Athlete profile was not found on this team.'
    );
  end if;

  if v_email = '' then
    return jsonb_build_object(
      'status', 'no_user_found',
      'athlete_id', p_athlete_id,
      'linked_user_id', null,
      'linked_email', v_email,
      'message', 'No login email was provided.'
    );
  end if;

  select u.id
  into v_found_user_id
  from auth.users u
  where lower(u.email) = v_email
  order by u.created_at asc
  limit 1;

  if v_found_user_id is null then
    update public.team_athletes
    set email = v_email,
        updated_at = now()
    where id = p_athlete_id
      and team_id = p_team_id;

    return jsonb_build_object(
      'status', 'no_user_found',
      'athlete_id', p_athlete_id,
      'linked_user_id', null,
      'linked_email', v_email,
      'message', 'Email saved, but no login account exists for this email yet.'
    );
  end if;

  select ta.id
  into v_existing_same_team_athlete_id
  from public.team_athletes ta
  where ta.team_id = p_team_id
    and ta.claimed_user_id = v_found_user_id
    and ta.id <> p_athlete_id
  limit 1;

  if v_existing_same_team_athlete_id is not null then
    return jsonb_build_object(
      'status', 'duplicate_claim',
      'athlete_id', p_athlete_id,
      'linked_user_id', v_found_user_id,
      'linked_email', v_email,
      'message', 'That login is already linked to another athlete on this team.'
    );
  end if;

  update public.team_athletes
  set claimed_user_id = v_found_user_id,
      email = v_email,
      updated_at = now()
  where id = p_athlete_id
    and team_id = p_team_id;

  return jsonb_build_object(
    'status', 'linked',
    'athlete_id', p_athlete_id,
    'linked_user_id', v_found_user_id,
    'linked_email', v_email,
    'message', 'Login linked to this athlete profile.'
  );
end;
$$;

create or replace function public.unlink_team_athlete_login(
  p_team_id uuid,
  p_athlete_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_athlete_exists boolean;
begin
  if v_caller is null or not public.can_write_team(p_team_id, v_caller) then
    return jsonb_build_object(
      'status', 'unauthorized',
      'athlete_id', p_athlete_id,
      'linked_user_id', null,
      'linked_email', null,
      'message', 'You do not have permission to unlink athlete login access.'
    );
  end if;

  select exists (
    select 1
    from public.team_athletes ta
    where ta.id = p_athlete_id
      and ta.team_id = p_team_id
  )
  into v_athlete_exists;

  if not v_athlete_exists then
    return jsonb_build_object(
      'status', 'unauthorized',
      'athlete_id', p_athlete_id,
      'linked_user_id', null,
      'linked_email', null,
      'message', 'Athlete profile was not found on this team.'
    );
  end if;

  update public.team_athletes
  set claimed_user_id = null,
      updated_at = now()
  where id = p_athlete_id
    and team_id = p_team_id;

  return jsonb_build_object(
    'status', 'unlinked',
    'athlete_id', p_athlete_id,
    'linked_user_id', null,
    'linked_email', null,
    'message', 'Login access was unlinked from this athlete profile.'
  );
end;
$$;
