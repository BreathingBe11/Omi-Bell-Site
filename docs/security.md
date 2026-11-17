# Security notes (omibell.com and Smooth Operators)

Reviewed November 2026. Keep these rules when changing the site.

## How data is protected

- **Database:** row-level security is on for every table. The public (anon) key, which is visible in page source, can read only published blog posts (`supabase/site_security.sql`). All other reads and writes go through server code with the service-role key, which lives only in Vercel.
- **Smooth Operators:** every member route checks the signed-in Supabase user on the server and only returns that member's own data. Journals are never included in admin views or exports. Admin routes need the site admin token or a staff role (owner/admin/support), checked per action.
- **Audio and files:** stored in a private Supabase bucket. Members get a signed link only after signing in with active access and only once the day has unlocked. Links expire after 1 hour (audio streaming) or 5 minutes (downloads). Nothing is public.
- **Payments:** Stripe Checkout (card details never touch the site), restricted API key, webhook signatures verified, prices set by the server.
- **Logins:** admin, writer and other password logins are limited to 5 tries per 15 minutes per visitor and 200 per hour overall, stored in Postgres so the limit holds across Vercel's server instances. Passwords are hashed with scrypt.
- **Blog content:** writers' HTML is cleaned with DOMPurify (`/vendor/purify-3.1.7.min.js`) before it is shown on the blog, article, homepage, admin and writer pages. Never assign post fields to `innerHTML` without `clean()`.
- **Third-party scripts:** pinned versions served from this site (`/smoothoperators/assets/vendor/`, `/vendor/`). Don't load unpinned `@latest`/`@2` URLs.
- **Headers:** HSTS, CSP, X-Frame-Options DENY, nosniff, strict referrer policy (`vercel.json`).
- **Exports:** CSV cells are protected against spreadsheet formula injection.

## Owner checklist

- Run `supabase/site_security.sql` in the Supabase SQL editor after creating any new table.
- Turn on two-factor sign-in for Supabase, Vercel, Stripe, GitHub, Resend and GoDaddy.
- Use a long, unique admin password. Only give writer access to people you trust.
- Keep secret keys only in Vercel environment variables; never paste them into chat, email or code.
