import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';

const SUPABASE_URL = 'https://rerhdlfuiemsuzygjzqx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_e-BT7oYj2e5sl07riD-kgQ_MLRUiaT6';
const APP_VERSION = '2.0.0';
const APP_VERSION_CODE = 2;
const ONLINE_WINDOW_MS = 120_000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const $ = (selector) => document.querySelector(selector);
const state = {
  authMode: 'signin',
  session: null,
  devices: [],
  memberships: new Map(),
  activeDevice: null,
  members: [],
  rows: [],
  signedUrls: new Map(),
  signedVideoUrls: new Map(),
  filter: 'all',
  unread: 0,
  channel: null,
  streamActive: false,
  pairingTimer: null,
  toastTimer: null,
  currentEvent: null,
  pushListenersReady: false,
  latestRelease: null,
};

const statusLabels = {
  pergerakan_kamera: 'Gerakan dikesan oleh kamera',
  pergerakan_dikesan: 'Pergerakan dikesan',
  manual_snapshot: 'Gambar diambil secara manual',
  gambar_dan_video: 'Gambar dan video tersedia',
  gambar_sahaja: 'Gambar tersedia',
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

function formatDate(value, compact = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Masa tidak diketahui';
  return new Intl.DateTimeFormat('ms-MY', compact
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function labelFor(row) {
  return statusLabels[row.status] || String(row.status || 'Aktiviti kamera').replaceAll('_', ' ');
}

function isDeviceOnline(device) {
  return Boolean(device?.last_seen_at) && Date.now() - new Date(device.last_seen_at).getTime() < ONLINE_WINDOW_MS;
}

function roleFor(deviceId) {
  return state.memberships.get(deviceId)?.role || 'viewer';
}

function canEditMedia() {
  return ['owner', 'editor'].includes(roleFor(state.activeDevice?.id));
}

function setConnection(status) {
  const online = status === 'SUBSCRIBED';
  const failed = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status);
  $('#connectionBadge').className = `status-pill ${online ? 'online' : failed ? 'offline' : 'connecting'}`;
  $('#connectionBadge').innerHTML = `<i></i>${online ? 'Realtime aktif' : failed ? 'Sambungan gagal' : 'Menyambung'}`;
  $('#realtimeDetail').textContent = online ? 'Aktiviti baharu diterima secara masa nyata.' : 'Mencuba sambungan ke Supabase.';
  $('#realtimeDot').classList.toggle('online', online);
}

async function invokeFaceGuard(action, body = {}) {
  const { data, error } = await supabase.functions.invoke('faceguard-device', {
    body: { action, ...body },
    headers: { 'X-FaceGuard-Action': action },
  });
  if (error) throw new Error(data?.error || error.message || 'Permintaan FaceGuard gagal.');
  if (data?.error) throw new Error(data.error);
  return data;
}

function renderAuth() {
  const signedIn = Boolean(state.session?.user);
  $('#authScreen').hidden = signedIn;
  $('#appShell').hidden = !signedIn;
  if (signedIn) $('#accountEmail').textContent = state.session.user.email || 'Akaun FaceGuard';
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  $('#authSubmit').disabled = true;
  $('#authMessage').textContent = 'Sila tunggu…';
  try {
    if (state.authMode === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      $('#authMessage').textContent = data.session
        ? 'Akaun berjaya dicipta.'
        : 'Akaun dicipta. Semak e-mel pengesahan sebelum log masuk.';
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      $('#authMessage').textContent = '';
    }
  } catch (error) {
    $('#authMessage').textContent = error.message;
  } finally {
    $('#authSubmit').disabled = false;
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((button) => button.classList.toggle('active', button.dataset.authMode === mode));
  $('#authSubmit').textContent = mode === 'signup' ? 'Daftar akaun' : 'Log masuk';
  $('#authPassword').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#authMessage').textContent = '';
}

async function signedMediaUrl(row) {
  if (!row) return '';
  if (state.signedUrls.has(row.id)) return state.signedUrls.get(row.id);
  if (row.storage_path) {
    const { data, error } = await supabase.storage.from('faceguard-storage').createSignedUrl(row.storage_path, 3600);
    if (!error && data?.signedUrl) {
      state.signedUrls.set(row.id, data.signedUrl);
      return data.signedUrl;
    }
  }
  try {
    const url = new URL(row.image_url || '');
    if (url.protocol === 'https:' && url.hostname === 'rerhdlfuiemsuzygjzqx.supabase.co') {
      state.signedUrls.set(row.id, url.href);
      return url.href;
    }
  } catch { /* URL tidak sah */ }
  return '';
}

function storagePathFromPublicUrl(value = '') {
  try {
    const url = new URL(value);
    const marker = '/storage/v1/object/public/faceguard-storage/';
    const index = url.pathname.indexOf(marker);
    return index >= 0 ? decodeURIComponent(url.pathname.slice(index + marker.length)) : '';
  } catch {
    return '';
  }
}

async function signedVideoUrl(row) {
  if (!row || state.signedVideoUrls.has(row.id)) return state.signedVideoUrls.get(row?.id) || '';
  const clipPath = Array.isArray(row.clip_paths) ? row.clip_paths[0] : '';
  const storagePath = clipPath || storagePathFromPublicUrl(row.video_url);
  if (storagePath) {
    const { data, error } = await supabase.storage.from('faceguard-storage').createSignedUrl(storagePath, 3600);
    if (!error && data?.signedUrl) {
      state.signedVideoUrls.set(row.id, data.signedUrl);
      return data.signedUrl;
    }
  }
  try {
    const url = new URL(row.video_url || '');
    if (url.protocol === 'https:' && url.hostname !== 'rerhdlfuiemsuzygjzqx.supabase.co') {
      state.signedVideoUrls.set(row.id, url.href);
      return url.href;
    }
  } catch { /* URL tidak sah */ }
  return '';
}

async function hydrateMedia(rows) {
  await Promise.all(rows.flatMap((row) => [signedMediaUrl(row), signedVideoUrl(row)]));
  return rows;
}

async function loadDevices(preferredDeviceId = null) {
  const userId = state.session?.user?.id;
  if (!userId) return;
  const [devicesResult, membershipsResult] = await Promise.all([
    supabase.from('faceguard_devices').select('id,device_code,name,local_ip,stream_token,last_seen_at,firmware_version,owner_id,created_at').order('created_at'),
    supabase.from('faceguard_device_members').select('device_id,user_id,role,created_at').eq('user_id', userId),
  ]);
  if (devicesResult.error) throw devicesResult.error;
  state.devices = devicesResult.data || [];
  state.memberships = new Map((membershipsResult.data || []).map((membership) => [membership.device_id, membership]));

  const saved = preferredDeviceId || localStorage.getItem('faceguard-active-device');
  state.activeDevice = state.devices.find((device) => device.id === saved) || state.devices[0] || null;
  if (state.activeDevice) localStorage.setItem('faceguard-active-device', state.activeDevice.id);
  renderDeviceChooser();
  renderDeviceList();
  await selectActiveDevice();
}

function renderDeviceChooser() {
  $('#deviceSelect').innerHTML = state.devices.length
    ? state.devices.map((device) => `<option value="${device.id}" ${device.id === state.activeDevice?.id ? 'selected' : ''}>${escapeHtml(device.name)}</option>`).join('')
    : '<option value="">Tiada kamera</option>';
  $('#deviceTotal').textContent = `${state.devices.length} kamera`;
}

function renderDeviceList() {
  $('#deviceList').innerHTML = state.devices.length ? state.devices.map((device) => {
    const online = isDeviceOnline(device);
    return `<button class="device-item ${device.id === state.activeDevice?.id ? 'selected' : ''}" data-device-id="${device.id}">
      <span class="device-icon">◉</span>
      <span><b>${escapeHtml(device.name)}</b><small>${escapeHtml(device.device_code)} · ${escapeHtml(roleFor(device.id))}</small></span>
      <i class="${online ? 'online' : ''}"></i><em>${online ? 'Online' : 'Offline'}</em>
    </button>`;
  }).join('') : '<div class="empty-state">Belum ada kamera. Tekan butang setup untuk bermula.</div>';
}

async function selectActiveDevice() {
  stopStream();
  state.rows = [];
  state.signedUrls.clear();
  state.signedVideoUrls.clear();
  renderCamera();
  renderEvents();
  if (!state.activeDevice) {
    state.members = [];
    renderMembers();
    if (state.channel) await supabase.removeChannel(state.channel);
    return;
  }
  await Promise.all([loadActivities(), loadMembers()]);
  subscribeRealtime();
  renderCamera();
  renderDeviceList();
}

async function loadActivities(showToast = false) {
  if (!state.activeDevice) return;
  const { data, error } = await supabase
    .from('aktiviti_log')
    .select('id,created_at,device_id,image_url,storage_path,status,video_url,clip_paths,event_kind')
    .eq('device_id', state.activeDevice.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    $('#eventList').innerHTML = `<div class="empty-state error">Aktiviti gagal dimuatkan.<br>${escapeHtml(error.message)}</div>`;
    return;
  }
  state.rows = await hydrateMedia(data || []);
  renderCamera();
  renderEvents();
  if (showToast) toast('Data kamera dikemas kini');
}

async function loadMembers() {
  if (!state.activeDevice) return;
  try {
    const data = await invokeFaceGuard('list_members', { device_id: state.activeDevice.id });
    state.members = data.members || [];
  } catch (error) {
    state.members = [];
    toast(error.message);
  }
  renderMembers();
}

function renderCamera() {
  const device = state.activeDevice;
  const latest = state.rows.find((row) => state.signedUrls.get(row.id));
  $('#cameraHeading').textContent = device?.name || 'Tambah kamera dahulu';
  $('#deviceCode').textContent = device?.device_code || 'ESP32-CAM';
  $('#networkMetric').textContent = device?.local_ip || '—';
  $('#eventTotal').textContent = String(state.rows.length);
  $('#memberMetric').textContent = `${state.members.length} / 5`;
  $('#liveBadge').className = `live-badge ${isDeviceOnline(device) ? 'online' : 'offline'}`;
  $('#liveBadge').textContent = state.streamActive ? 'LIVE' : isDeviceOnline(device) ? 'ONLINE' : 'OFFLINE';

  const latestImage = $('#latestImage');
  const empty = $('#cameraEmpty');
  if (!state.streamActive && latest) {
    latestImage.src = state.signedUrls.get(latest.id);
    latestImage.hidden = false;
    empty.hidden = true;
    $('#latestStatus').textContent = labelFor(latest);
    $('#latestTime').textContent = formatDate(latest.created_at);
  } else if (!state.streamActive) {
    latestImage.hidden = true;
    empty.hidden = false;
    empty.querySelector('b').textContent = device ? 'Belum ada rakaman gerakan' : 'Belum ada kamera';
    empty.querySelector('span').textContent = device ? 'Mulakan live atau lalu di hadapan kamera.' : 'Tekan “＋ Kamera” untuk setup Wi‑Fi.';
    $('#latestStatus').textContent = device ? 'Menunggu aktiviti' : 'Menunggu kamera';
    $('#latestTime').textContent = '—';
  }
  $('#lastSync').textContent = `Dikemas kini ${new Intl.DateTimeFormat('ms-MY', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`;
}

function filteredRows() {
  if (state.filter === 'video') return state.rows.filter((row) => row.video_url || (Array.isArray(row.clip_paths) && row.clip_paths.length));
  if (state.filter === 'image') return state.rows.filter((row) => state.signedUrls.get(row.id));
  return state.rows;
}

function renderEvents() {
  const rows = filteredRows();
  $('#unreadBadge').textContent = `${state.unread} baharu`;
  $('#navBadge').textContent = String(state.unread);
  $('#navBadge').hidden = state.unread === 0;
  if (!state.activeDevice) {
    $('#eventList').innerHTML = '<div class="empty-state">Pilih atau tambah kamera dahulu.</div>';
    return;
  }
  $('#eventList').innerHTML = rows.length ? rows.map((row) => {
    const image = state.signedUrls.get(row.id) || '';
    const hasVideo = Boolean(state.signedVideoUrls.get(row.id));
    return `<article class="event-item" data-row-id="${row.id}">
      <button class="event-open" aria-label="Buka aktiviti">
        <span class="event-thumb">${image ? `<img src="${escapeHtml(image)}" alt="">` : '<i>◉</i>'}</span>
        <span class="event-copy"><b>${escapeHtml(labelFor(row))}</b><small>${escapeHtml(formatDate(row.created_at))}</small><em>${hasVideo ? 'Klip + gambar' : 'Gambar ESP32-CAM'}</em></span>
        <span class="event-chevron">›</span>
      </button>
      ${canEditMedia() ? `<button class="event-delete" data-delete-row="${row.id}" aria-label="Padam aktiviti">Padam</button>` : ''}
    </article>`;
  }).join('') : `<div class="empty-state">${state.filter === 'video' ? 'Tiada klip video. Live stream masih boleh digunakan.' : 'Belum ada aktiviti gerakan.'}</div>`;
}

function renderMembers() {
  $('#memberMetric').textContent = `${state.members.length} / 5`;
  if (!state.activeDevice) {
    $('#memberList').innerHTML = '<div class="empty-state compact">Pilih kamera dahulu.</div>';
    $('#createInviteBtn').disabled = true;
    return;
  }
  const isOwner = roleFor(state.activeDevice.id) === 'owner';
  $('#createInviteBtn').disabled = !isOwner || state.members.length >= 5;
  $('#memberList').innerHTML = state.members.length ? state.members.map((member) => `<article class="member-item">
    <span>${escapeHtml((member.email || '?').slice(0, 1).toUpperCase())}</span>
    <div><b>${escapeHtml(member.email || 'Pengguna FaceGuard')}</b><small>${escapeHtml(member.role)}</small></div>
    ${isOwner && member.role !== 'owner' ? `<button data-remove-member="${member.user_id}">Buang</button>` : '<i>✓</i>'}
  </article>`).join('') : '<div class="empty-state compact">Maklumat pengguna tidak tersedia.</div>';
}

async function subscribeRealtime() {
  if (state.channel) await supabase.removeChannel(state.channel);
  if (!state.activeDevice) return;
  const deviceId = state.activeDevice.id;
  state.channel = supabase
    .channel(`faceguard-${deviceId}-${Date.now()}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'aktiviti_log', filter: `device_id=eq.${deviceId}`,
    }, async ({ new: row }) => {
      if (state.rows.some((item) => item.id === row.id)) return;
      await signedMediaUrl(row);
      await signedVideoUrl(row);
      state.rows.unshift(row);
      state.rows = state.rows.slice(0, 100);
      state.unread += 1;
      renderCamera();
      renderEvents();
      await showMotionNotification(row);
      toast('Gerakan baharu dikesan');
    })
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'faceguard_devices', filter: `id=eq.${deviceId}`,
    }, ({ new: device }) => {
      const index = state.devices.findIndex((item) => item.id === device.id);
      if (index >= 0) state.devices[index] = { ...state.devices[index], ...device };
      state.activeDevice = state.devices[index];
      renderCamera();
      renderDeviceList();
    })
    .subscribe((status) => setConnection(status));
}

function streamUrl(path = '/stream') {
  const device = state.activeDevice;
  if (!device?.local_ip || !device?.stream_token) return '';
  const port = path === '/stream' ? ':81' : '';
  return `http://${device.local_ip}${port}${path}?token=${encodeURIComponent(device.stream_token)}`;
}

function startStream() {
  const url = streamUrl();
  if (!url) return toast('Kamera belum online atau belum selesai setup.');
  const image = $('#liveStream');
  image.onload = () => {
    state.streamActive = true;
    image.hidden = false;
    $('#latestImage').hidden = true;
    $('#cameraEmpty').hidden = true;
    $('#toggleStreamBtn').textContent = 'Hentikan live';
    $('#liveBadge').className = 'live-badge online';
    $('#liveBadge').textContent = 'LIVE';
    $('#latestStatus').textContent = 'Siaran langsung Wi‑Fi tempatan';
    $('#latestTime').textContent = 'LIVE';
  };
  image.onerror = () => {
    stopStream();
    toast('Live stream gagal. Pastikan telefon menggunakan Wi‑Fi yang sama.');
  };
  image.src = `${url}&t=${Date.now()}`;
}

function stopStream() {
  state.streamActive = false;
  const image = $('#liveStream');
  image.onload = null;
  image.onerror = null;
  image.src = '';
  image.hidden = true;
  $('#toggleStreamBtn').textContent = 'Mulakan live';
  renderCamera();
}

async function requestSnapshot() {
  const url = streamUrl('/api/snapshot');
  if (!url) return toast('Kamera belum online.');
  $('#snapshotBtn').disabled = true;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    toast('Kamera sedang mengambil dan menyimpan gambar.');
  } catch {
    toast('Gagal menghubungi kamera. Semak Wi‑Fi yang sama.');
  } finally {
    $('#snapshotBtn').disabled = false;
  }
}

async function requestNotifications() {
  if (Capacitor.isNativePlatform()) {
    try {
      let localPermission = await LocalNotifications.checkPermissions();
      if (localPermission.display === 'prompt') localPermission = await LocalNotifications.requestPermissions();
      if (localPermission.display !== 'granted') throw new Error('Kebenaran notifikasi ditolak.');
      await LocalNotifications.createChannel({
        id: 'faceguard_alerts', name: 'Amaran FaceGuard', description: 'Amaran gerakan kamera',
        importance: 5, visibility: 1, vibration: true, lights: true,
      });
      await setupPushNotifications();
      $('#notificationStatus').textContent = 'Alert tempatan aktif; push memerlukan Firebase';
      toast('Notifikasi FaceGuard diaktifkan');
    } catch (error) {
      $('#notificationStatus').textContent = error.message;
      toast(error.message);
    }
    return;
  }
  if (!('Notification' in window)) return toast('Notifikasi tidak disokong pada pelayar ini.');
  const permission = await Notification.requestPermission();
  $('#notificationStatus').textContent = permission === 'granted' ? 'Notifikasi web aktif' : 'Kebenaran ditolak';
  toast(permission === 'granted' ? 'Notifikasi web diaktifkan' : 'Kebenaran notifikasi tidak diberikan');
}

async function setupPushNotifications() {
  if (!Capacitor.isNativePlatform()) return;
  if (!state.pushListenersReady) {
    state.pushListenersReady = true;
    await PushNotifications.addListener('registration', async ({ value }) => {
      const userId = state.session?.user?.id;
      if (!userId) return;
      const result = await supabase.from('faceguard_push_tokens').upsert({
        user_id: userId, token: value, platform: Capacitor.getPlatform(), device_instance_id: value.slice(-16), updated_at: new Date().toISOString(),
      }, { onConflict: 'token' });
      $('#notificationStatus').textContent = result.error ? `Token gagal: ${result.error.message}` : 'Push notification aktif';
    });
    await PushNotifications.addListener('registrationError', ({ error }) => {
      $('#notificationStatus').textContent = 'Firebase belum disambungkan';
      console.warn('Push registration failed', error);
    });
    await PushNotifications.addListener('pushNotificationActionPerformed', () => showPage('eventsPage', 'Aktiviti'));
  }
  let permission = await PushNotifications.checkPermissions();
  if (permission.receive === 'prompt') permission = await PushNotifications.requestPermissions();
  if (permission.receive === 'granted') await PushNotifications.register();
}

async function showMotionNotification(row) {
  const title = 'FaceGuard: gerakan dikesan';
  const body = `${state.activeDevice?.name || 'Kamera'} · ${labelFor(row)}`;
  if (Capacitor.isNativePlatform()) {
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display === 'granted') {
      await LocalNotifications.schedule({ notifications: [{
        id: Number(row.id) % 2_000_000_000, title, body,
        channelId: 'faceguard_alerts', schedule: { at: new Date(Date.now() + 200) },
        extra: { event_id: row.id, device_id: row.device_id },
      }] });
    }
  } else if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/icon.svg', tag: `faceguard-${row.id}` });
  }
}

function openProvisioning() {
  if (!state.session) return;
  stopPairingPoll();
  $('#wifiStep').hidden = false;
  $('#qrStep').hidden = true;
  $('#pairingMessage').textContent = 'Menunggu kamera mengimbas QR…';
  $('#provisionModal').showModal();
}

async function createProvisionQr(event) {
  event.preventDefault();
  const ssid = $('#wifiSsid').value.trim();
  const password = $('#wifiPassword').value;
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const setup = await invokeFaceGuard('create_setup');
    const payload = `FG1\n${setup.setup_token}\n${ssid}\n${password}`;
    await QRCode.toCanvas($('#wifiQrCanvas'), payload, {
      width: 290, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#101418', light: '#ffffff' },
    });
    $('#wifiStep').hidden = true;
    $('#qrStep').hidden = false;
    startPairingPoll(setup.session_id);
  } catch (error) {
    toast(error.message);
  } finally {
    submit.disabled = false;
  }
}

function startPairingPoll(sessionId) {
  stopPairingPoll();
  let attempts = 0;
  state.pairingTimer = setInterval(async () => {
    attempts += 1;
    const { data } = await supabase
      .from('faceguard_setup_sessions')
      .select('claimed_device_id,expires_at')
      .eq('id', sessionId)
      .maybeSingle();
    if (data?.claimed_device_id) {
      stopPairingPoll();
      $('#pairingMessage').textContent = 'Kamera berjaya disambungkan!';
      $('#wifiPassword').value = '';
      setTimeout(() => $('#provisionModal').close(), 900);
      await loadDevices(data.claimed_device_id);
      toast('Kamera FaceGuard berjaya ditambah');
    } else if (!data || new Date(data.expires_at).getTime() < Date.now() || attempts > 150) {
      stopPairingPoll();
      $('#pairingMessage').textContent = 'Sesi tamat. Jana QR baharu dan cuba lagi.';
    }
  }, 2000);
}

function stopPairingPoll() {
  if (state.pairingTimer) clearInterval(state.pairingTimer);
  state.pairingTimer = null;
}

async function deleteEvent(row) {
  if (!row || !canEditMedia()) return toast('Akaun ini tidak dibenarkan memadam media.');
  if (!window.confirm('Padam gambar/klip ini daripada FaceGuard? Tindakan ini tidak boleh dibatalkan.')) return;
  try {
    await invokeFaceGuard('delete_event', { event_id: row.id });
    state.rows = state.rows.filter((item) => item.id !== row.id);
    state.signedUrls.delete(row.id);
    state.signedVideoUrls.delete(row.id);
    $('#mediaModal').close();
    renderCamera();
    renderEvents();
    toast('Media berjaya dipadam');
  } catch (error) {
    toast(error.message);
  }
}

function openEvent(row) {
  const image = state.signedUrls.get(row?.id);
  const video = state.signedVideoUrls.get(row?.id);
  if (!row || (!image && !video)) return toast('Media aktiviti tidak tersedia.');
  state.currentEvent = row;
  $('#modalImage').hidden = !image;
  $('#modalImage').src = image || '';
  $('#modalVideo').hidden = !video;
  $('#modalVideo').src = video || '';
  $('#modalTitle').textContent = labelFor(row);
  $('#modalTime').textContent = formatDate(row.created_at);
  $('#modalDownload').href = video || image;
  $('#deleteEventBtn').hidden = !canEditMedia();
  $('#mediaModal').showModal();
}

async function createInvite() {
  if (!state.activeDevice) return;
  try {
    const result = await invokeFaceGuard('create_invite', { device_id: state.activeDevice.id, role: $('#inviteRole').value });
    $('#generatedInviteCode').textContent = result.invite_code;
    $('#inviteResult').hidden = false;
  } catch (error) {
    toast(error.message);
  }
}

async function acceptInvite(event) {
  event.preventDefault();
  const code = $('#inviteCodeInput').value.trim();
  if (!code) return;
  try {
    const result = await invokeFaceGuard('accept_invite', { invite_code: code });
    $('#inviteCodeInput').value = '';
    await loadDevices(result.device_id);
    toast('Kamera perkongsian berjaya ditambah');
  } catch (error) {
    toast(error.message);
  }
}

async function removeMember(userId) {
  if (!window.confirm('Buang akses pengguna ini daripada kamera?')) return;
  try {
    await invokeFaceGuard('remove_member', { device_id: state.activeDevice.id, user_id: userId });
    await loadMembers();
    toast('Akses pengguna dibuang');
  } catch (error) {
    toast(error.message);
  }
}

async function checkForUpdate(showResult = true) {
  try {
    const { data, error } = await supabase
      .from('faceguard_app_releases')
      .select('version_code,version_name,apk_url,release_notes,published_at')
      .order('version_code', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      $('#updateStatus').textContent = `Versi ${APP_VERSION} · belum ada release awam`;
      return;
    }
    state.latestRelease = data;
    let installedCode = APP_VERSION_CODE;
    if (Capacitor.isNativePlatform()) {
      const info = await App.getInfo();
      installedCode = Number(info.build) || APP_VERSION_CODE;
    }
    const updateAvailable = data.version_code > installedCode;
    $('#updateStatus').textContent = updateAvailable
      ? `Versi ${data.version_name} tersedia`
      : `Versi ${APP_VERSION} adalah terkini`;
    $('#checkUpdateBtn').textContent = updateAvailable ? 'Muat turun' : 'Semak';
    $('#checkUpdateBtn').dataset.downloadUrl = updateAvailable ? data.apk_url : '';
    if (showResult) toast(updateAvailable ? `Update ${data.version_name} tersedia` : 'Aplikasi sudah versi terkini');
    else if (updateAvailable) toast(`Kemas kini FaceGuard ${data.version_name} tersedia`);
  } catch (error) {
    $('#updateStatus').textContent = 'Semakan update gagal';
    if (showResult) toast(error.message);
  }
}

async function handleUpdateButton() {
  const url = $('#checkUpdateBtn').dataset.downloadUrl;
  if (!url) return checkForUpdate(true);
  if (Capacitor.isNativePlatform()) await Browser.open({ url });
  else window.open(url, '_blank', 'noopener');
}

function showPage(id, title) {
  document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === id));
  document.querySelectorAll('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.page === id));
  $('#pageTitle').textContent = title;
  if (id === 'eventsPage') {
    state.unread = 0;
    renderEvents();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function initializeSignedInApp() {
  renderAuth();
  try {
    await loadDevices();
    await setupPushNotifications();
    await checkForUpdate(false);
  } catch (error) {
    toast(error.message);
  }
}

document.querySelectorAll('.auth-tab').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
$('#authForm').addEventListener('submit', handleAuthSubmit);
document.querySelectorAll('.nav-btn').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page, button.dataset.title)));
document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
  renderEvents();
}));

$('#refreshBtn').addEventListener('click', async () => {
  await loadDevices(state.activeDevice?.id);
  toast('FaceGuard dikemas kini');
});
$('#deviceSelect').addEventListener('change', async (event) => {
  state.activeDevice = state.devices.find((device) => device.id === event.target.value) || null;
  if (state.activeDevice) localStorage.setItem('faceguard-active-device', state.activeDevice.id);
  await selectActiveDevice();
});
$('#deviceList').addEventListener('click', async (event) => {
  const item = event.target.closest('[data-device-id]');
  if (!item) return;
  state.activeDevice = state.devices.find((device) => device.id === item.dataset.deviceId) || null;
  if (state.activeDevice) localStorage.setItem('faceguard-active-device', state.activeDevice.id);
  renderDeviceChooser();
  await selectActiveDevice();
  showPage('homePage', 'Live');
});

$('#quickAddDevice').addEventListener('click', openProvisioning);
$('#addDeviceBtn').addEventListener('click', openProvisioning);
$('#wifiForm').addEventListener('submit', createProvisionQr);
$('#restartSetupBtn').addEventListener('click', () => {
  stopPairingPoll();
  $('#wifiStep').hidden = false;
  $('#qrStep').hidden = true;
});
$('#provisionModal').addEventListener('close', stopPairingPoll);
$('#toggleStreamBtn').addEventListener('click', () => state.streamActive ? stopStream() : startStream());
$('#snapshotBtn').addEventListener('click', requestSnapshot);
$('#notifyBtn').addEventListener('click', requestNotifications);
$('#settingsNotifyBtn').addEventListener('click', requestNotifications);
$('#acceptInviteForm').addEventListener('submit', acceptInvite);

$('#eventList').addEventListener('click', (event) => {
  const deleteButton = event.target.closest('[data-delete-row]');
  if (deleteButton) return deleteEvent(state.rows.find((row) => row.id === Number(deleteButton.dataset.deleteRow)));
  const item = event.target.closest('[data-row-id]');
  if (item) openEvent(state.rows.find((row) => row.id === Number(item.dataset.rowId)));
});
$('#deleteEventBtn').addEventListener('click', () => deleteEvent(state.currentEvent));
$('#mediaModal').addEventListener('close', () => {
  $('#modalVideo').pause();
  $('#modalVideo').src = '';
});

$('#createInviteBtn').addEventListener('click', () => {
  $('#inviteResult').hidden = true;
  $('#inviteModal').showModal();
});
$('#generateInviteBtn').addEventListener('click', createInvite);
$('#copyInviteBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#generatedInviteCode').textContent);
  toast('Kod jemputan disalin');
});
$('#memberList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-member]');
  if (button) removeMember(button.dataset.removeMember);
});

$('#checkUpdateBtn').addEventListener('click', handleUpdateButton);
$('#signOutBtn').addEventListener('click', () => supabase.auth.signOut());
window.addEventListener('online', () => loadDevices(state.activeDevice?.id));
window.addEventListener('offline', () => setConnection('CHANNEL_ERROR'));
if ('serviceWorker' in navigator && !Capacitor.isNativePlatform()) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
if (/iphone|ipad|ipod/i.test(navigator.userAgent)) $('#iosHelp').hidden = false;

supabase.auth.onAuthStateChange((event, session) => {
  state.session = session;
  renderAuth();
  if (session && ['INITIAL_SESSION', 'SIGNED_IN'].includes(event)) initializeSignedInApp();
  if (!session && event === 'SIGNED_OUT') {
    stopStream();
    stopPairingPoll();
    if (state.channel) supabase.removeChannel(state.channel);
    state.devices = [];
    state.activeDevice = null;
    renderAuth();
  }
});

renderAuth();
