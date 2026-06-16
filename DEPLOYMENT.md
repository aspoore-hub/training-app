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

Replace `https://training.example.com` with the production custom domain.

- Site URL: `https://training.example.com`
- Additional Redirect URLs:
  - `https://training.example.com`
  - `https://training.example.com/*`
  - `http://localhost:8081`
  - `http://localhost:8081/*`

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
