alter table public.team_invites
  drop constraint if exists team_invites_role_check;

alter table public.team_invites
  add constraint team_invites_role_check
  check (role = any (array['athlete'::text, 'coach'::text, 'viewer'::text, 'editor'::text]));
