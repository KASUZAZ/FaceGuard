alter table public.faceguard_devices
  add column if not exists stream_token text;

create index if not exists faceguard_device_members_added_by_idx
  on public.faceguard_device_members(added_by);
create index if not exists faceguard_invites_device_idx
  on public.faceguard_invites(device_id);
create index if not exists faceguard_invites_created_by_idx
  on public.faceguard_invites(created_by);
create index if not exists faceguard_invites_accepted_by_idx
  on public.faceguard_invites(accepted_by);
create index if not exists faceguard_setup_sessions_claimed_device_idx
  on public.faceguard_setup_sessions(claimed_device_id);
