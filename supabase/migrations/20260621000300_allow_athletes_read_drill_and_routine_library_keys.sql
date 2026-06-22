drop policy if exists "team_kv_blobs_select_routine_drill_library_claimed_athlete" on public.team_kv_blobs;

create policy "team_kv_blobs_select_routine_drill_library_claimed_athlete"
on public.team_kv_blobs for select
using (
  key in (
    'training_app_auxiliary_routines_v1',
    'training_app_routine_folders_v1',
    'training_app_drill_library_v1',
    'training_app_drill_folders_v1'
  )
  and exists (
    select 1
    from public.team_athletes ta
    where ta.team_id = team_kv_blobs.team_id
      and ta.claimed_user_id = auth.uid()
  )
);
