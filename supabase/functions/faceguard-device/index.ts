import { createClient } from 'npm:@supabase/supabase-js@2.110.5';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': [
    'authorization', 'apikey', 'content-type', 'x-faceguard-action',
    'x-device-code', 'x-device-secret', 'x-event-kind', 'x-local-ip',
    'x-firmware-version', 'x-setup-token',
  ].join(', '),
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type JsonRecord = Record<string, unknown>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function randomToken(size = 24) {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requestUser(req: Request) {
  const authorization = req.headers.get('Authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

async function parseJson(req: Request): Promise<JsonRecord> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function requireDevice(deviceCode: string, deviceSecret: string) {
  if (!deviceCode || !deviceSecret) return null;
  const { data } = await admin
    .from('faceguard_devices')
    .select('id,device_code,device_secret_hash,owner_id,name,local_ip,stream_token')
    .eq('device_code', deviceCode)
    .maybeSingle();
  if (!data || data.device_secret_hash !== await sha256(deviceSecret)) return null;
  return data;
}

async function requireEditor(userId: string, deviceId: string) {
  const { data } = await admin
    .from('faceguard_device_members')
    .select('role')
    .eq('device_id', deviceId)
    .eq('user_id', userId)
    .maybeSingle();
  return data && ['owner', 'editor'].includes(data.role) ? data : null;
}

async function handleCreateSetup(req: Request) {
  const user = await requestUser(req);
  if (!user) return json({ error: 'Sila log masuk dahulu.' }, 401);

  await admin
    .from('faceguard_setup_sessions')
    .delete()
    .eq('owner_id', user.id)
    .lt('expires_at', new Date().toISOString());

  const setupToken = randomToken(24);
  const { data, error } = await admin
    .from('faceguard_setup_sessions')
    .insert({ owner_id: user.id, setup_token_hash: await sha256(setupToken) })
    .select('id,expires_at')
    .single();
  if (error) return json({ error: error.message }, 400);
  return json({ setup_token: setupToken, session_id: data.id, expires_at: data.expires_at });
}

async function handleProvision(body: JsonRecord) {
  const setupToken = String(body.setup_token ?? '');
  const deviceCode = String(body.device_code ?? '').toUpperCase();
  const deviceSecret = String(body.device_secret ?? '');
  const localIp = String(body.local_ip ?? '');
  const firmwareVersion = String(body.firmware_version ?? '');
  const streamToken = String(body.stream_token ?? '');
  if (!setupToken || !deviceCode || !deviceSecret || !localIp || !streamToken) {
    return json({ error: 'Maklumat provisioning tidak lengkap.' }, 400);
  }

  const { data: setup } = await admin
    .from('faceguard_setup_sessions')
    .select('id,owner_id,expires_at,claimed_device_id')
    .eq('setup_token_hash', await sha256(setupToken))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!setup) return json({ error: 'Kod setup tidak sah atau telah tamat.' }, 401);

  const secretHash = await sha256(deviceSecret);
  const { data: existing } = await admin
    .from('faceguard_devices')
    .select('id,owner_id,device_secret_hash')
    .eq('device_code', deviceCode)
    .maybeSingle();

  if (existing && existing.device_secret_hash !== secretHash) {
    return json({ error: 'Rahsia peranti tidak sepadan.' }, 403);
  }
  if (existing && existing.owner_id !== setup.owner_id) {
    return json({ error: 'Kamera ini telah dipautkan kepada akaun lain.' }, 409);
  }

  let device = existing;
  if (!device) {
    const inserted = await admin
      .from('faceguard_devices')
      .insert({
        device_code: deviceCode,
        device_secret_hash: secretHash,
        owner_id: setup.owner_id,
        local_ip: localIp,
        stream_token: streamToken,
        firmware_version: firmwareVersion,
        last_seen_at: new Date().toISOString(),
      })
      .select('id,owner_id')
      .single();
    if (inserted.error) return json({ error: inserted.error.message }, 400);
    device = inserted.data;
  } else {
    await admin
      .from('faceguard_devices')
      .update({
        local_ip: localIp,
        stream_token: streamToken,
        firmware_version: firmwareVersion,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', device.id);
  }

  const memberResult = await admin
    .from('faceguard_device_members')
    .upsert({
      device_id: device.id,
      user_id: setup.owner_id,
      role: 'owner',
      added_by: setup.owner_id,
    }, { onConflict: 'device_id,user_id' });
  if (memberResult.error) return json({ error: memberResult.error.message }, 400);

  await admin
    .from('faceguard_setup_sessions')
    .update({ claimed_device_id: device.id })
    .eq('id', setup.id);

  return json({ ok: true, device_id: device.id, stream_url: `http://${localIp}/stream` });
}

async function handleHeartbeat(body: JsonRecord) {
  const device = await requireDevice(String(body.device_code ?? '').toUpperCase(), String(body.device_secret ?? ''));
  if (!device) return json({ error: 'Peranti tidak sah.' }, 401);
  const localIp = String(body.local_ip ?? device.local_ip ?? '');
  await admin
    .from('faceguard_devices')
    .update({
      local_ip: localIp,
      stream_token: String(body.stream_token ?? device.stream_token ?? ''),
      firmware_version: String(body.firmware_version ?? ''),
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', device.id);
  return json({ ok: true, device_id: device.id });
}

async function handleUploadEvent(req: Request) {
  const device = await requireDevice(
    (req.headers.get('X-Device-Code') ?? '').toUpperCase(),
    req.headers.get('X-Device-Secret') ?? '',
  );
  if (!device) return json({ error: 'Peranti tidak sah.' }, 401);

  const image = new Uint8Array(await req.arrayBuffer());
  if (image.length < 100 || image.length > 2_000_000) {
    return json({ error: 'Saiz gambar tidak sah.' }, 413);
  }

  const fileName = `${device.id}/images/${Date.now()}-${crypto.randomUUID()}.jpg`;
  const upload = await admin.storage
    .from('faceguard-storage')
    .upload(fileName, image, { contentType: 'image/jpeg', upsert: false });
  if (upload.error) return json({ error: upload.error.message }, 400);

  const publicUrl = admin.storage.from('faceguard-storage').getPublicUrl(fileName).data.publicUrl;
  const inserted = await admin
    .from('aktiviti_log')
    .insert({
      device_id: device.id,
      image_url: publicUrl,
      storage_path: fileName,
      status: req.headers.get('X-Event-Kind') || 'pergerakan_kamera',
      event_kind: 'motion',
    })
    .select('id,created_at')
    .single();
  if (inserted.error) {
    await admin.storage.from('faceguard-storage').remove([fileName]);
    return json({ error: inserted.error.message }, 400);
  }

  await admin
    .from('faceguard_devices')
    .update({ last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', device.id);
  EdgeRuntime.waitUntil(sendMotionPush(device.id, inserted.data.id, device.name));
  return json({ ok: true, event_id: inserted.data.id, storage_path: fileName });
}

function storagePathFromUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const marker = '/storage/v1/object/public/faceguard-storage/';
  const index = value.indexOf(marker);
  return index >= 0 ? decodeURIComponent(value.slice(index + marker.length)) : null;
}

async function handleDeleteEvent(req: Request, body: JsonRecord) {
  const user = await requestUser(req);
  if (!user) return json({ error: 'Sila log masuk dahulu.' }, 401);
  const eventId = Number(body.event_id);
  if (!Number.isSafeInteger(eventId)) return json({ error: 'ID aktiviti tidak sah.' }, 400);

  const { data: event } = await admin
    .from('aktiviti_log')
    .select('id,device_id,storage_path,image_url,video_url,clip_paths')
    .eq('id', eventId)
    .maybeSingle();
  if (!event || !event.device_id) return json({ error: 'Aktiviti tidak ditemui.' }, 404);
  if (!await requireEditor(user.id, event.device_id)) return json({ error: 'Tiada kebenaran memadam.' }, 403);

  const paths = [event.storage_path, storagePathFromUrl(event.image_url), storagePathFromUrl(event.video_url)];
  if (Array.isArray(event.clip_paths)) paths.push(...event.clip_paths);
  const uniquePaths = [...new Set(paths.filter((path): path is string => typeof path === 'string' && path.length > 0))];
  if (uniquePaths.length) await admin.storage.from('faceguard-storage').remove(uniquePaths);
  const deleted = await admin.from('aktiviti_log').delete().eq('id', eventId);
  if (deleted.error) return json({ error: deleted.error.message }, 400);
  return json({ ok: true });
}

async function handleCreateInvite(req: Request, body: JsonRecord) {
  const user = await requestUser(req);
  if (!user) return json({ error: 'Sila log masuk dahulu.' }, 401);
  const deviceId = String(body.device_id ?? '');
  const role = body.role === 'editor' ? 'editor' : 'viewer';
  const { data: membership } = await admin
    .from('faceguard_device_members')
    .select('role')
    .eq('device_id', deviceId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (membership?.role !== 'owner') return json({ error: 'Hanya pemilik boleh menambah pengguna.' }, 403);

  const { count } = await admin
    .from('faceguard_device_members')
    .select('*', { count: 'exact', head: true })
    .eq('device_id', deviceId);
  if ((count ?? 0) >= 5) return json({ error: 'Kamera ini sudah mencapai maksimum 5 pengguna.' }, 409);

  const inviteToken = randomToken(9).toUpperCase();
  const inserted = await admin
    .from('faceguard_invites')
    .insert({
      device_id: deviceId,
      invite_token_hash: await sha256(inviteToken),
      role,
      created_by: user.id,
    })
    .select('id,expires_at')
    .single();
  if (inserted.error) return json({ error: inserted.error.message }, 400);
  return json({ invite_code: inviteToken, invite_id: inserted.data.id, expires_at: inserted.data.expires_at });
}

async function handleAcceptInvite(req: Request, body: JsonRecord) {
  const user = await requestUser(req);
  if (!user) return json({ error: 'Sila log masuk dahulu.' }, 401);
  const inviteCode = String(body.invite_code ?? '').trim().toUpperCase();
  const { data: invite } = await admin
    .from('faceguard_invites')
    .select('id,device_id,role,created_by')
    .eq('invite_token_hash', await sha256(inviteCode))
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!invite) return json({ error: 'Kod jemputan tidak sah atau telah tamat.' }, 404);

  const member = await admin
    .from('faceguard_device_members')
    .insert({
      device_id: invite.device_id,
      user_id: user.id,
      role: invite.role,
      added_by: invite.created_by,
    });
  if (member.error && member.error.code !== '23505') return json({ error: member.error.message }, 409);
  await admin
    .from('faceguard_invites')
    .update({ accepted_by: user.id, accepted_at: new Date().toISOString() })
    .eq('id', invite.id);
  return json({ ok: true, device_id: invite.device_id });
}

async function handleRemoveMember(req: Request, body: JsonRecord) {
  const user = await requestUser(req);
  if (!user) return json({ error: 'Sila log masuk dahulu.' }, 401);
  const deviceId = String(body.device_id ?? '');
  const memberId = String(body.user_id ?? '');
  const { data: owner } = await admin
    .from('faceguard_device_members')
    .select('role')
    .eq('device_id', deviceId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (owner?.role !== 'owner') return json({ error: 'Hanya pemilik boleh membuang pengguna.' }, 403);
  const { data: target } = await admin
    .from('faceguard_device_members')
    .select('role')
    .eq('device_id', deviceId)
    .eq('user_id', memberId)
    .maybeSingle();
  if (!target || target.role === 'owner') return json({ error: 'Pemilik kamera tidak boleh dibuang.' }, 400);
  await admin.from('faceguard_device_members').delete().eq('device_id', deviceId).eq('user_id', memberId);
  return json({ ok: true });
}

async function handleRenameDevice(req: Request, body: JsonRecord) {
  const user = await requestUser(req);
  if (!user) return json({ error: 'Sila log masuk dahulu.' }, 401);
  const deviceId = String(body.device_id ?? '');
  const name = String(body.name ?? '').trim().slice(0, 60);
  const { data: member } = await admin
    .from('faceguard_device_members')
    .select('role')
    .eq('device_id', deviceId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (member?.role !== 'owner' || !name) return json({ error: 'Nama atau kebenaran tidak sah.' }, 403);
  await admin.from('faceguard_devices').update({ name, updated_at: new Date().toISOString() }).eq('id', deviceId);
  return json({ ok: true, name });
}

async function handleListMembers(req: Request, body: JsonRecord) {
  const user = await requestUser(req);
  if (!user) return json({ error: 'Sila log masuk dahulu.' }, 401);
  const deviceId = String(body.device_id ?? '');
  const { data: requester } = await admin
    .from('faceguard_device_members')
    .select('role')
    .eq('device_id', deviceId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!requester) return json({ error: 'Tiada akses kepada kamera ini.' }, 403);

  const { data: memberships, error } = await admin
    .from('faceguard_device_members')
    .select('user_id,role,created_at')
    .eq('device_id', deviceId)
    .order('created_at');
  if (error) return json({ error: error.message }, 400);
  const members = await Promise.all((memberships ?? []).map(async (membership) => {
    const result = await admin.auth.admin.getUserById(membership.user_id);
    return {
      ...membership,
      email: result.data.user?.email ?? 'Pengguna FaceGuard',
    };
  }));
  return json({ members, requester_role: requester.role, maximum: 5 });
}

function pemToBytes(pem: string) {
  const base64 = pem.replace(/-----[^-]+-----/g, '').replaceAll(/\s/g, '');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function fcmAccessToken(serviceAccount: JsonRecord) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: JsonRecord) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: String(serviceAccount.client_email),
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBytes(String(serviceAccount.private_key)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!response.ok) throw new Error(`FCM OAuth ${response.status}`);
  return String((await response.json()).access_token);
}

async function sendMotionPush(deviceId: string, eventId: number, deviceName: string) {
  const rawServiceAccount = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON');
  if (!rawServiceAccount) return;
  try {
    const { data: members } = await admin
      .from('faceguard_device_members')
      .select('user_id')
      .eq('device_id', deviceId);
    const userIds = (members ?? []).map((member) => member.user_id);
    if (!userIds.length) return;
    const { data: tokens } = await admin
      .from('faceguard_push_tokens')
      .select('token')
      .in('user_id', userIds);
    if (!tokens?.length) return;

    const serviceAccount = JSON.parse(rawServiceAccount) as JsonRecord;
    const accessToken = await fcmAccessToken(serviceAccount);
    const endpoint = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;
    await Promise.allSettled(tokens.map(({ token }) => fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: 'FaceGuard: gerakan dikesan', body: `${deviceName} mengesan pergerakan.` },
          data: { device_id: deviceId, event_id: String(eventId) },
          android: { priority: 'high', notification: { channel_id: 'faceguard_alerts', sound: 'default' } },
        },
      }),
    })));
  } catch (error) {
    console.error('FCM notification failed', error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method tidak disokong.' }, 405);

  const action = req.headers.get('X-FaceGuard-Action') || new URL(req.url).searchParams.get('action') || '';
  if (action === 'upload_event') return handleUploadEvent(req);
  const body = await parseJson(req);
  switch (action || String(body.action ?? '')) {
    case 'create_setup': return handleCreateSetup(req);
    case 'provision': return handleProvision(body);
    case 'heartbeat': return handleHeartbeat(body);
    case 'delete_event': return handleDeleteEvent(req, body);
    case 'create_invite': return handleCreateInvite(req, body);
    case 'accept_invite': return handleAcceptInvite(req, body);
    case 'remove_member': return handleRemoveMember(req, body);
    case 'rename_device': return handleRenameDevice(req, body);
    case 'list_members': return handleListMembers(req, body);
    default: return json({ error: 'Tindakan FaceGuard tidak dikenali.' }, 400);
  }
});
