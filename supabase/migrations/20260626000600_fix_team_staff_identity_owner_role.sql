drop function if exists public.list_team_staff_identity(uuid);

create or replace function public.list_team_staff_identity(p_team_id uuid)
returns table (
  team_id uuid,
  user_id uuid,
  role text,
  first_name text,
  last_name text,
  display_name text,
  email text,
  is_owner boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with authorized_team as (
    select t.id, t.owner_id, t.created_at
    from public.teams t
    where t.id = p_team_id
      and (
        t.owner_id = auth.uid()
        or exists (
          select 1
          from public.team_members viewer_tm
          where viewer_tm.team_id = t.id
            and viewer_tm.user_id = auth.uid()
        )
      )
  ),
  owner_row as (
    select
      at.id as team_id,
      at.owner_id as user_id,
      'owner'::text as role,
      coalesce(owner_tm.created_at, at.created_at) as created_at,
      owner_tm.updated_at as updated_at,
      true as is_owner
    from authorized_team at
    left join public.team_members owner_tm
      on owner_tm.team_id = at.id
      and owner_tm.user_id = at.owner_id
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
    join authorized_team at on at.id = tm.team_id
    where tm.user_id <> at.owner_id
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
    p.first_name,
    p.last_name,
    p.display_name,
    lower(u.email) as email,
    sr.is_owner,
    sr.created_at,
    sr.updated_at
  from staff_rows sr
  left join public.profiles p on p.id = sr.user_id
  left join auth.users u on u.id = sr.user_id
  order by
    sr.is_owner desc,
    lower(coalesce(nullif(p.last_name, ''), nullif(p.display_name, ''), u.email, sr.user_id::text)),
    lower(coalesce(nullif(p.first_name, ''), ''));
$$;
