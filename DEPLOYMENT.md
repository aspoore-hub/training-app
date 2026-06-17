# Production Web Deployment

This Expo app exports a static web build into `dist` and is ready for Vercel hosting.

## Required Vercel Settings

- Framework preset: Other
- Build command: `npm run build:web`
- Output directory: `dist`
- Install command: `npm ci`

Set these Vercel environment variables for Production, Preview, and Development as needed:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

Do not put service-role keys or database passwords in Vercel public environment variables. The Supabase anon key is expected in client apps, with access controlled by Row Level Security policies.

## Supabase Auth URL Settings

In Supabase, open Authentication > URL Configuration.

Use the current production app root as the Site URL. When you move to a custom domain, replace `https://training.example.com` with that domain.

- Site URL: `https://training-app-kappa.vercel.app`
- Additional Redirect URLs:
  - `https://training-app-kappa.vercel.app`
  - `https://training-app-kappa.vercel.app/*`
  - `https://training-app-kappa.vercel.app/update-password`
  - `https://training-app-kappa.vercel.app/update-password/*`
  - `https://training.example.com`
  - `https://training.example.com/*`
  - `https://training.example.com/update-password`
  - `https://training.example.com/update-password/*`
  - `http://localhost:8081`
  - `http://localhost:8081/*`

Keep the Site URL pointed at the production app root, not the reset screen. Password reset emails use the `/update-password` redirect URL above.

If you use Vercel preview deployments for auth testing, add your preview URL pattern too, for example:

- `https://training-app-git-*-your-vercel-team.vercel.app/*`

## DNS

In Vercel, add the custom domain to the project and follow the DNS record instructions Vercel gives for your registrar. After DNS verifies, use that exact `https://...` domain in Supabase.

## Local Verification

Run:

```sh
npm run build:web
```

The static web output should be written to `dist`.

The `postbuild:web` script copies PWA assets from `public` and ensures the exported HTML references `/manifest.json`.

## Athlete Invite Email

Athlete invite rows are created in `public.team_invites`, then the app calls the Supabase Edge Function `send-athlete-invite`. SMTP credentials must stay in Supabase secrets only; do not put them in Expo, Vercel, or GitHub.

Set the required Supabase secrets:

```sh
supabase secrets set ZOHO_SMTP_HOST=smtp.zoho.com
supabase secrets set ZOHO_SMTP_PORT=465
supabase secrets set ZOHO_SMTP_USER=coach@gettracksideapp.com
supabase secrets set INVITE_EMAIL_FROM='Trackside Coach <coach@gettracksideapp.com>'
supabase secrets set PUBLIC_SITE_URL=https://www.tracksidecoach.com
supabase secrets set ZOHO_SMTP_PASS='your-zoho-app-password'
```

Deploy the Edge Function:

```sh
supabase functions deploy send-athlete-invite --no-verify-jwt
supabase functions deploy get-athlete-invite --no-verify-jwt
```

The function verifies the user from the `Authorization` header itself, checks the invite's team permissions with `public.can_write_team`/`public.can_manage_team_coaches`, builds this URL format, and sends it through Zoho SMTP:

```text
https://www.tracksidecoach.com/join?token=<token>
```

To test:

1. In production, open a real athlete roster profile with a test email you can receive.
2. Click `Create and send invite`.
3. Confirm the UI says `Invite email sent.`
4. Confirm the email arrives from `coach@gettracksideapp.com`.
5. Open the link and verify it lands on `/join?token=<token>` with the token filled in.
6. If delivery fails, the app still creates and copies the invite link so it can be sent manually.

When switching senders later, update `ZOHO_SMTP_USER`, `INVITE_EMAIL_FROM`, and `ZOHO_SMTP_PASS` in Supabase secrets, then redeploy or restart the function if needed.

The join page also calls `get-athlete-invite` to preview invite details before authentication. For the strongest invite-claim security, keep `public.accept_team_invite` updated with the version in `docs/coach_accounts_editor_viewer_rls.sql`; it checks that the signed-in email matches the invite email and sets `team_invites.accepted_at`.

Apply the hardening migration before testing invite claims in production:

```sh
supabase db push
```

Or run `supabase/migrations/20260617000100_harden_accept_team_invite_email_match.sql` in the Supabase SQL editor.
