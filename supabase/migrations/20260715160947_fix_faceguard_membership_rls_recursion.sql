-- The device SELECT policy checks this membership table. Keep this policy
-- independent from faceguard_devices so Postgres does not recurse between
-- the two RLS policies. Owners and members only need their own membership
-- row in the client; owner-managed member lists are returned by the
-- service-role Edge Function.
drop policy if exists "FaceGuard members read memberships"
on public.faceguard_device_members;

create policy "FaceGuard members read memberships"
on public.faceguard_device_members
for select
to authenticated
using (user_id = (select auth.uid()));
