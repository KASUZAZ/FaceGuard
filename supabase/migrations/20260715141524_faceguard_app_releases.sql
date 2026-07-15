create table if not exists public.faceguard_app_releases (
  version_code integer primary key,
  version_name text not null unique,
  apk_url text not null,
  release_notes text not null default '',
  minimum_android integer not null default 24,
  published_at timestamptz not null default now()
);

alter table public.faceguard_app_releases enable row level security;
grant select on public.faceguard_app_releases to anon, authenticated;

drop policy if exists "FaceGuard releases are public" on public.faceguard_app_releases;
create policy "FaceGuard releases are public"
on public.faceguard_app_releases for select to anon, authenticated
using (true);
