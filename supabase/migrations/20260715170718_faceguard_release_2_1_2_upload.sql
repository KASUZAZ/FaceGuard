drop policy if exists "FaceGuard temporary release upload" on storage.objects;
create policy "FaceGuard temporary release upload"
on storage.objects
for insert
to anon
with check (
  bucket_id = 'faceguard-releases'
  and name = 'FaceGuard-2.1.2.apk'
);
