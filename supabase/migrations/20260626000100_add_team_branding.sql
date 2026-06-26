alter table public.teams
  add column if not exists logo_path text,
  add column if not exists logo_updated_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'team-logos',
  'team-logos',
  false,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = 2097152,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

drop policy if exists "team_logos_select_team_access" on storage.objects;
create policy "team_logos_select_team_access"
on storage.objects for select
to authenticated
using (
  bucket_id = 'team-logos'
  and (
    exists (
      select 1
      from public.teams t
      where t.id::text = (storage.foldername(name))[1]
        and t.owner_id = auth.uid()
    )
    or exists (
      select 1
      from public.team_members tm
      where tm.team_id::text = (storage.foldername(name))[1]
        and tm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.team_athletes ta
      where ta.team_id::text = (storage.foldername(name))[1]
        and ta.claimed_user_id = auth.uid()
    )
  )
);

drop policy if exists "team_logos_insert_owner_editor" on storage.objects;
create policy "team_logos_insert_owner_editor"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'team-logos'
  and (
    exists (
      select 1
      from public.teams t
      where t.id::text = (storage.foldername(name))[1]
        and t.owner_id = auth.uid()
    )
    or exists (
      select 1
      from public.team_members tm
      where tm.team_id::text = (storage.foldername(name))[1]
        and tm.user_id = auth.uid()
        and lower(coalesce(tm.role, '')) in ('owner', 'editor', 'coach', 'admin', 'member')
    )
  )
);

drop policy if exists "team_logos_update_owner_editor" on storage.objects;
create policy "team_logos_update_owner_editor"
on storage.objects for update
to authenticated
using (
  bucket_id = 'team-logos'
  and (
    exists (
      select 1
      from public.teams t
      where t.id::text = (storage.foldername(name))[1]
        and t.owner_id = auth.uid()
    )
    or exists (
      select 1
      from public.team_members tm
      where tm.team_id::text = (storage.foldername(name))[1]
        and tm.user_id = auth.uid()
        and lower(coalesce(tm.role, '')) in ('owner', 'editor', 'coach', 'admin', 'member')
    )
  )
)
with check (
  bucket_id = 'team-logos'
  and (
    exists (
      select 1
      from public.teams t
      where t.id::text = (storage.foldername(name))[1]
        and t.owner_id = auth.uid()
    )
    or exists (
      select 1
      from public.team_members tm
      where tm.team_id::text = (storage.foldername(name))[1]
        and tm.user_id = auth.uid()
        and lower(coalesce(tm.role, '')) in ('owner', 'editor', 'coach', 'admin', 'member')
    )
  )
);

drop policy if exists "team_logos_delete_owner_editor" on storage.objects;
create policy "team_logos_delete_owner_editor"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'team-logos'
  and (
    exists (
      select 1
      from public.teams t
      where t.id::text = (storage.foldername(name))[1]
        and t.owner_id = auth.uid()
    )
    or exists (
      select 1
      from public.team_members tm
      where tm.team_id::text = (storage.foldername(name))[1]
        and tm.user_id = auth.uid()
        and lower(coalesce(tm.role, '')) in ('owner', 'editor', 'coach', 'admin', 'member')
    )
  )
);

create or replace function public.update_team_branding(
  p_team_id uuid,
  p_name text default null,
  p_logo_path text default null,
  p_update_logo boolean default false
)
returns table (
  id uuid,
  name text,
  logo_path text,
  logo_updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_can_edit boolean := false;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_logo_path text := nullif(trim(coalesce(p_logo_path, '')), '');
begin
  if v_user_id is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select exists (
    select 1
    from public.teams t
    where t.id = p_team_id
      and t.owner_id = v_user_id
  )
  or exists (
    select 1
    from public.team_members tm
    where tm.team_id = p_team_id
      and tm.user_id = v_user_id
      and lower(coalesce(tm.role, '')) in ('owner', 'editor', 'coach', 'admin', 'member')
  )
  into v_can_edit;

  if not v_can_edit then
    raise exception 'You do not have permission to edit team branding.' using errcode = '42501';
  end if;

  if v_name is null then
    select t.name into v_name
    from public.teams t
    where t.id = p_team_id;
  end if;

  if v_name is null then
    raise exception 'Team not found.' using errcode = 'P0002';
  end if;

  return query
  update public.teams t
  set
    name = v_name,
    logo_path = case when p_update_logo then v_logo_path else t.logo_path end,
    logo_updated_at = case when p_update_logo then now() else t.logo_updated_at end
  where t.id = p_team_id
  returning t.id, t.name, t.logo_path, t.logo_updated_at;
end;
$$;

grant execute on function public.update_team_branding(uuid, text, text, boolean) to authenticated;
