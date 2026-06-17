drop policy if exists "team_workout_batch_headers_select_visible_athlete" on public.team_workout_batch_headers;

create policy "team_workout_batch_headers_select_visible_athlete"
on public.team_workout_batch_headers for select
using (
  exists (
    select 1
    from public.team_workouts tw
    join public.team_athletes ta
      on ta.team_id = tw.team_id
     and ta.id = tw.athlete_profile_id
    where tw.team_id = team_workout_batch_headers.team_id
      and tw.batch_id = team_workout_batch_headers.batch_id
      and tw.date_iso::text = team_workout_batch_headers.date_iso::text
      and upper(tw.session::text) = upper(team_workout_batch_headers.session::text)
      and tw.athlete_visible = true
      and ta.claimed_user_id = auth.uid()
  )
);

drop policy if exists "team_kv_blobs_select_aux_routines_claimed_athlete" on public.team_kv_blobs;

create policy "team_kv_blobs_select_aux_routines_claimed_athlete"
on public.team_kv_blobs for select
using (
  key = 'training_app_auxiliary_routines_v1'
  and exists (
    select 1
    from public.team_athletes ta
    where ta.team_id = team_kv_blobs.team_id
      and ta.claimed_user_id = auth.uid()
  )
);
