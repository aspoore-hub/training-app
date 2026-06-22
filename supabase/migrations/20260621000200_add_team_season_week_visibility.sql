create table if not exists public.team_season_week_visibility (
  team_id uuid not null references public.teams(id) on delete cascade,
  season_id uuid not null references public.team_seasons(id) on delete cascade,
  week_start_iso text not null,
  athlete_visible boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users(id) on delete set null,
  primary key (team_id, season_id, week_start_iso),
  constraint team_season_week_visibility_week_iso_check
    check (week_start_iso ~ '^\d{4}-\d{2}-\d{2}$')
);

alter table public.team_season_week_visibility enable row level security;

drop policy if exists "team_season_week_visibility_select_staff_or_claimed_athlete" on public.team_season_week_visibility;
create policy "team_season_week_visibility_select_staff_or_claimed_athlete"
on public.team_season_week_visibility for select
using (
  public.can_view_team(team_id)
  or (
    athlete_visible = true
    and exists (
      select 1
      from public.team_athletes ta
      left join public.team_athlete_season_overrides aso
        on aso.team_id = team_season_week_visibility.team_id
       and aso.season_id = team_season_week_visibility.season_id
       and aso.athlete_profile_id = ta.id
      join public.team_seasons s
        on s.team_id = team_season_week_visibility.team_id
       and s.id = team_season_week_visibility.season_id
      where ta.team_id = team_season_week_visibility.team_id
        and ta.claimed_user_id = auth.uid()
        and coalesce(ta.roster_status, 'active') <> 'archived'
        and coalesce(aso.is_excluded, false) = false
        and coalesce(aso.start_date::date, s.start_date::date) <= (team_season_week_visibility.week_start_iso::date + interval '6 days')::date
        and coalesce(aso.end_date::date, s.end_date::date) >= team_season_week_visibility.week_start_iso::date
        and (ta.team_start_date is null or ta.team_start_date::date <= (team_season_week_visibility.week_start_iso::date + interval '6 days')::date)
        and (ta.team_end_date is null or ta.team_end_date::date >= team_season_week_visibility.week_start_iso::date)
    )
  )
);

drop policy if exists "team_season_week_visibility_write_owner_editor" on public.team_season_week_visibility;
create policy "team_season_week_visibility_write_owner_editor"
on public.team_season_week_visibility for all
using (public.can_write_team(team_id))
with check (public.can_write_team(team_id));

create index if not exists team_season_week_visibility_lookup_idx
on public.team_season_week_visibility (team_id, season_id, week_start_iso, athlete_visible);

insert into public.team_season_week_visibility (
  team_id,
  season_id,
  week_start_iso,
  athlete_visible,
  updated_at,
  updated_by
)
select
  inferred.team_id,
  inferred.season_id,
  inferred.week_start_iso,
  bool_and(inferred.athlete_visible) as athlete_visible,
  max(inferred.updated_at) as updated_at,
  null::uuid as updated_by
from (
  select
    v.team_id,
    s.id as season_id,
    v.week_start_iso,
    v.athlete_visible,
    coalesce(v.updated_at, now()) as updated_at
  from public.team_mileage_week_visibility v
  join public.team_seasons s
    on s.team_id = v.team_id
    and s.start_date::date <= (v.week_start_iso::date + interval '6 days')::date
    and s.end_date::date >= v.week_start_iso::date
  join public.team_athletes ta
    on ta.team_id = v.team_id
   and ta.id = v.athlete_profile_id
  left join public.team_athlete_season_overrides aso
    on aso.team_id = v.team_id
   and aso.season_id = s.id
   and aso.athlete_profile_id = v.athlete_profile_id
  where coalesce(ta.roster_status, 'active') <> 'archived'
    and coalesce(aso.is_excluded, false) = false
    and coalesce(aso.start_date::date, s.start_date::date) <= (v.week_start_iso::date + interval '6 days')::date
    and coalesce(aso.end_date::date, s.end_date::date) >= v.week_start_iso::date
    and (ta.team_start_date is null or ta.team_start_date::date <= (v.week_start_iso::date + interval '6 days')::date)
    and (ta.team_end_date is null or ta.team_end_date::date >= v.week_start_iso::date)
) inferred
group by inferred.team_id, inferred.season_id, inferred.week_start_iso
on conflict (team_id, season_id, week_start_iso) do nothing;
