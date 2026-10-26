alter table public.team_athletes
  add column if not exists preferred_distance_unit text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'team_athletes_preferred_distance_unit_check'
      and conrelid = 'public.team_athletes'::regclass
  ) then
    alter table public.team_athletes
      add constraint team_athletes_preferred_distance_unit_check
      check (preferred_distance_unit is null or preferred_distance_unit in ('mi', 'km'));
  end if;
end
$$;

comment on column public.team_athletes.preferred_distance_unit is
  'Athlete display and entry unit. Null inherits the team distance unit.';
