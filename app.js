import { createClient } from '@supabase/supabase-js';
import { Capacitor, CapacitorHttp } from '@capacitor/core';

const SUPABASE_URL = 'https://nscqzfkuanfgxzfwukty.supabase.co';
const SUPABASE_KEY = 'sb_publishable_GFljHorRTltHpWAEfz_PMg_oNa0YmF5';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const DEFAULT_LIVE_CONFIG = {
  serverUrl: import.meta.env.VITE_INFERENCE_SERVER_URL || 'https://faceguard-inference.onrender.com',
  deviceId: import.meta.env.VITE_DEVICE_ID || 'kamera-hadapan',
};

const $ = (selector) => document.querySelector(selector);
const state = {
  rows: [], filter: 'all', unread: 0, installPrompt: null, channel: null,
  user: null, device: null, authBusy: false,
  live: {
    socket: null, frameUrl: '', metadata: null, reconnectTimer: null,
    heartbeat: null, staleTimer: null, generation: 0, frameCount: 0,
    fpsWindowStartedAt: 0, connectedAt: 0, lastFrameAt: 0, lastFallState: '',
    connectionStatus: 'idle', connectionDetail: 'Menunggu tetapan kamera.',
  },
};
const statusLabels = {
  orang_jatuh: 'AMARAN: Orang jatuh dikesan',
  pergerakan_kamera: 'Gerakan dikesan oleh kamera',
  pergerakan_dikesan: 'Pergerakan dikesan',
  gambar_dan_video: 'Gambar dan video tersedia',
  gambar_sahaja: 'Gambar tersedia',
  microsd_tidak_tersedia: 'Gambar tersedia',
  video_upload_gagal: 'Gambar tersedia · video gagal',
  video_rakaman_gagal: 'Gambar tersedia · rakaman gagal',
};

const fallStateLabels = {
  dimatikan: 'Fall detection dimatikan',
  tiada_orang: 'Tiada orang dikesan',
  berdiri: 'Pose normal · berdiri',
  bergerak: 'Pergerakan dikesan',
  disyaki_jatuh: 'Mengesahkan kemungkinan jatuh…',
  baring: 'Orang dalam posisi mendatar',
  orang_jatuh: 'AMARAN · ORANG JATUH',
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function safeMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'nscqzfkuanfgxzfwukty.supabase.co' ? url.href : '';
  } catch { return ''; }
}

function safeServerUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    return url.href.replace(/\/$/, '');
  } catch { return ''; }
}

function getLiveConfig() {
  const cloud = state.device
    ? { serverUrl: state.device.server_url || '', deviceId: state.device.id }
    : {};
  return { ...DEFAULT_LIVE_CONFIG, ...cloud };
}

function renderAuth() {
  const signedIn = Boolean(state.user);
  $('#authFields').hidden = signedIn;
  $('#signOutBtn').hidden = !signedIn;
  $('#cameraSetupForm').hidden = !signedIn;
  $('#authStatus').textContent = signedIn
    ? `Log masuk sebagai ${state.user.email || 'pengguna FaceGuard'}.`
    : 'Log masuk untuk melindungi kamera, aktiviti dan media anda.';
}

async function signMediaUrl(path) {
  if (!path || typeof path !== 'string') return '';
  const { data, error } = await supabase.storage.from('faceguard-storage').createSignedUrl(path, 3600);
  return error ? '' : safeMediaUrl(data.signedUrl);
}

async function hydrateMedia(row) {
  const [signedImage, signedVideo] = await Promise.all([
    signMediaUrl(row.image_path),
    signMediaUrl(row.video_path),
  ]);
  return {
    ...row,
    image_url: signedImage || safeMediaUrl(row.image_url),
    video_url: signedVideo || safeMediaUrl(row.video_url),
  };
}

async function loadOwnedDevice() {
  state.device = null;
  if (!state.user) return;
  const { data, error } = await supabase.from('devices')
    .select('id,name,location,server_url,detection_enabled,target_fps,inference_fps,fall_confirm_seconds,online,stream_fps,last_seen')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) return toast(`Tetapan kamera gagal dimuatkan: ${error.message}`);
  state.device = data || null;
  const config = getLiveConfig();
  $('#serverUrlInput').value = config.serverUrl || '';
  $('#deviceIdInput').value = config.deviceId || DEFAULT_LIVE_CONFIG.deviceId;
  $('#cameraNameInput').value = data?.name || 'Kamera pintu hadapan';
  $('#cameraLocationInput').value = data?.location || 'Pintu hadapan';
  $('#targetFpsInput').value = data?.target_fps || 25;
  $('#inferenceFpsInput').value = data?.inference_fps || 5;
  $('#fallConfirmInput').value = data?.fall_confirm_seconds || 1.5;
  $('#detectionEnabledInput').checked = data?.detection_enabled ?? true;
}

function setCameraConnection(status, detail) {
  const dot = $('#cameraDot');
  state.live.connectionStatus = status;
  state.live.connectionDetail = detail;
  $('#cameraConnectionDetail').textContent = detail;
  dot.classList.toggle('online', status === 'online');
  if (status === 'offline') dot.style.background = '#ff7b7b';
  else dot.style.removeProperty('background');

  if (!state.live.frameUrl) {
    const emptyMessages = {
      idle: ['Tetapan CCTV belum lengkap', detail],
      connecting: ['Menyambung CCTV', detail],
      online: ['Server sudah tersambung', 'Menunggu frame pertama daripada ESP32-CAM.'],
      offline: ['ESP32-CAM tidak aktif', detail],
    };
    const [title, message] = emptyMessages[status] || ['Menunggu CCTV', detail];
    $('#cameraEmptyTitle').textContent = title;
    $('#cameraEmptyDetail').textContent = message;
    $('#latestStatus').textContent = status === 'offline' ? 'Kamera luar talian' : title;
    $('#latestTime').textContent = '—';
  }
}

function showLiveFrame(blob) {
  const image = $('#latestImage');
  const empty = $('#cameraEmpty');
  const nextUrl = URL.createObjectURL(blob);
  const previousUrl = state.live.frameUrl;
  state.live.frameUrl = nextUrl;
  state.live.lastFrameAt = Date.now();
  image.src = nextUrl;
  image.hidden = false;
  empty.hidden = true;
  if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 500);

  const now = performance.now();
  if (!state.live.fpsWindowStartedAt) state.live.fpsWindowStartedAt = now;
  state.live.frameCount += 1;
  const elapsed = now - state.live.fpsWindowStartedAt;
  if (elapsed >= 1000) {
    const fps = state.live.frameCount * 1000 / elapsed;
    $('#liveFps').textContent = `${fps.toFixed(1)} FPS`;
    $('#latestTime').textContent = formatDate(new Date(), true);
    const deviceId = getLiveConfig().deviceId;
    setCameraConnection('online', `CCTV ${deviceId} · ${fps.toFixed(1)} FPS`);
    state.live.frameCount = 0;
    state.live.fpsWindowStartedAt = now;
  }
}

function formatDate(value, compact = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Masa tidak diketahui';
  return new Intl.DateTimeFormat('ms-MY', compact
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function labelFor(row) { return statusLabels[row.status] || String(row.status || 'Aktiviti kamera').replaceAll('_', ' '); }

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove('show'), 2800);
}

function setConnection(status) {
  const badge = $('#connectionBadge');
  const detail = $('#realtimeDetail');
  const dot = $('#realtimeDot');
  const online = status === 'SUBSCRIBED';
  badge.className = `status-pill ${online ? 'online' : status === 'CHANNEL_ERROR' ? 'offline' : 'connecting'}`;
  badge.innerHTML = `<i></i>${online ? 'Realtime aktif' : status === 'CHANNEL_ERROR' ? 'Sambungan gagal' : 'Menyambung'}`;
  detail.textContent = online ? 'Supabase Realtime sedang menerima aktiviti.' : 'Mencuba sambungan ke Supabase.';
  dot.classList.toggle('online', online);
}

function renderLatest() {
  const image = $('#latestImage');
  const empty = $('#cameraEmpty');
  if (state.live.frameUrl) {
    image.src = state.live.frameUrl;
    image.hidden = false;
    empty.hidden = true;
    const metadata = state.live.metadata || {};
    $('#latestStatus').textContent = fallStateLabels[metadata.fall_state] || 'CCTV langsung aktif';
    $('#latestTime').textContent = formatDate(metadata.captured_at || new Date(), true);
    return;
  }

  const row = state.rows.find((item) => safeMediaUrl(item.image_url));
  if (!row) {
    image.hidden = true;
    empty.hidden = false;
    setCameraConnection(state.live.connectionStatus, state.live.connectionDetail);
    return;
  }
  image.src = safeMediaUrl(row.image_url);
  image.hidden = false;
  empty.hidden = true;
  $('#latestStatus').textContent = labelFor(row);
  $('#latestTime').textContent = formatDate(row.created_at);
}

function filteredRows() {
  if (state.filter === 'video') return state.rows.filter((row) => safeMediaUrl(row.video_url));
  if (state.filter === 'image') return state.rows.filter((row) => safeMediaUrl(row.image_url));
  return state.rows;
}

function renderEvents() {
  const rows = filteredRows();
  $('#eventTotal').textContent = `${state.rows.length} event`;
  $('#eventList').innerHTML = rows.length ? rows.map((row) => {
    const image = safeMediaUrl(row.image_url);
    const video = safeMediaUrl(row.video_url);
    return `<article class="event-item" data-row-id="${Number(row.id)}">
      <div class="event-thumb">${image ? `<img src="${image}" alt="">` : '<span>◉</span>'}</div>
      <div class="event-copy"><b>${escapeHtml(labelFor(row))}</b><small>${escapeHtml(formatDate(row.created_at))}</small><span>${video ? 'Gambar + video AVI' : 'Gambar ESP32-CAM'}</span></div>
      <button aria-label="Buka aktiviti">›</button>
    </article>`;
  }).join('') : '<div class="empty-state">Tiada aktiviti untuk penapis ini.</div>';
}

function mediaItems() {
  return state.rows.flatMap((row) => {
    const items = [];
    const image = safeMediaUrl(row.image_url);
    const video = safeMediaUrl(row.video_url);
    if (image) items.push({ row, url: image, type: 'image' });
    if (video) items.push({ row, url: video, type: 'video' });
    return items;
  });
}

function renderGallery() {
  const items = mediaItems();
  $('#mediaTotal').textContent = `${items.length} media`;
  $('#galleryGrid').innerHTML = items.length ? items.map((item, index) => `<article class="gallery-item">
    <button data-media-index="${index}">${item.type === 'image' ? `<img src="${item.url}" alt="Bukti gerakan">` : '<div class="avi-tile"><span>▶</span><b>AVI</b></div>'}<i>${item.type === 'image' ? 'GAMBAR' : 'VIDEO'}</i></button>
    <div><b>${escapeHtml(labelFor(item.row))}</b><small>${escapeHtml(formatDate(item.row.created_at, true))}</small></div>
  </article>`).join('') : '<div class="empty-state">Belum ada media.</div>';
}

function updateUnread() {
  $('#unreadBadge').textContent = `${state.unread} baharu`;
  $('#navBadge').textContent = state.unread;
  $('#navBadge').hidden = state.unread === 0;
}

function renderAll() {
  renderLatest(); renderEvents(); renderGallery(); updateUnread();
  $('#lastSync').textContent = `Dikemas kini ${new Intl.DateTimeFormat('ms-MY', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`;
}

async function loadActivities(showToast = false) {
  if (!state.user) {
    state.rows = [];
    renderAll();
    $('#eventList').innerHTML = '<div class="empty-state">Log masuk di Tetapan untuk melihat aktiviti.</div>';
    return;
  }
  const { data, error } = await supabase.from('aktiviti_log')
    .select('id,created_at,device_id,image_path,video_path,image_url,status,video_url,confidence,metadata')
    .order('created_at', { ascending: false }).limit(100);
  if (error) {
    $('#eventList').innerHTML = `<div class="empty-state error">Data gagal dimuatkan.<br>${escapeHtml(error.message)}</div>`;
    setConnection('CHANNEL_ERROR');
    return;
  }
  state.rows = await Promise.all((data || []).map(hydrateMedia));
  renderAll();
  if (showToast) toast('Data FaceGuard dikemas kini');
}

function showNotification(row) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  const title = row.status === 'orang_jatuh' ? 'FaceGuard: ORANG JATUH' : 'FaceGuard: aktiviti dikesan';
  new Notification(title, { body: labelFor(row), icon: '/icon.svg', tag: `faceguard-${row.id}` });
}

function subscribeRealtime() {
  if (state.channel) supabase.removeChannel(state.channel);
  state.channel = null;
  if (!state.user) return setConnection('CHANNEL_ERROR');
  state.channel = supabase.channel('faceguard-activity')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'aktiviti_log' }, async ({ new: rawRow }) => {
      const row = await hydrateMedia(rawRow);
      if (state.rows.some((item) => item.id === row.id)) return;
      state.rows.unshift(row);
      state.rows = state.rows.slice(0, 100);
      state.unread += 1;
      renderAll();
      showNotification(row);
      toast(row.status === 'orang_jatuh' ? 'AMARAN: Orang jatuh dikesan' : 'Aktiviti baharu dikesan');
    })
    .subscribe((status) => setConnection(status));
}

function stopLiveStream() {
  state.live.generation += 1;
  clearTimeout(state.live.reconnectTimer);
  clearInterval(state.live.heartbeat);
  clearInterval(state.live.staleTimer);
  state.live.reconnectTimer = null;
  state.live.heartbeat = null;
  state.live.staleTimer = null;
  state.live.frameCount = 0;
  state.live.fpsWindowStartedAt = 0;
  state.live.connectedAt = 0;
  state.live.lastFrameAt = 0;
  $('#liveFps').textContent = '0 FPS';
  if (state.live.socket) {
    state.live.socket.onclose = null;
    state.live.socket.close();
    state.live.socket = null;
  }
}

async function connectLiveStream() {
  stopLiveStream();
  const generation = state.live.generation;
  const config = getLiveConfig();
  const serverUrl = safeServerUrl(config.serverUrl);
  const deviceId = String(config.deviceId || '').trim();
  if (!serverUrl || !/^[a-zA-Z0-9_-]{3,64}$/.test(deviceId)) {
    setCameraConnection('idle', 'Isi URL server dan Device ID di bawah.');
    return;
  }

  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws/live/${encodeURIComponent(deviceId)}`;
  url.search = '';
  const { data: { session } } = await supabase.auth.getSession();
  const protocols = ['faceguard'];
  if (session?.access_token) {
    protocols.push(`supabase-access-token.${session.access_token}`);
  }

  setCameraConnection('connecting', `Menyambung kepada ${deviceId}…`);
  let socket;
  try {
    socket = new WebSocket(url, protocols);
  } catch {
    setCameraConnection('offline', 'URL WebSocket tidak dapat dibuka. Semak URL inference server.');
    state.live.reconnectTimer = setTimeout(() => { void connectLiveStream(); }, 3000);
    return;
  }
  socket.binaryType = 'blob';
  state.live.socket = socket;

  socket.onopen = () => {
    if (generation !== state.live.generation) return socket.close();
    state.live.connectedAt = Date.now();
    setCameraConnection('online', `CCTV ${deviceId} tersambung.`);
    state.live.heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('ping');
    }, 20000);
    state.live.staleTimer = setInterval(() => {
      const referenceTime = state.live.lastFrameAt || state.live.connectedAt;
      if (referenceTime && Date.now() - referenceTime > 8000) {
        $('#liveFps').textContent = '0 FPS';
        setCameraConnection('offline', state.live.lastFrameAt
          ? 'Server aktif, tetapi frame kamera telah terhenti.'
          : 'Server aktif, tetapi ESP32-CAM belum menghantar sebarang frame.');
      }
    }, 1000);
  };
  socket.onmessage = (event) => {
    if (generation !== state.live.generation) return;
    if (typeof event.data === 'string') {
      try {
        state.live.metadata = JSON.parse(event.data);
        const currentFallState = state.live.metadata.fall_state || '';
        $('#latestStatus').textContent = fallStateLabels[currentFallState] || 'CCTV langsung aktif';
        if (currentFallState === 'orang_jatuh' && state.live.lastFallState !== 'orang_jatuh') {
          toast('AMARAN: Orang jatuh dikesan');
        }
        state.live.lastFallState = currentFallState;
        if (state.live.metadata.stream_online === false) {
          $('#liveFps').textContent = '0 FPS';
          setCameraConnection('offline', 'Server aktif, tetapi ESP32-CAM tidak menghantar frame. Semak kuasa dan Wi-Fi 2.4 GHz peranti.');
        }
      } catch { return; }
    } else {
      showLiveFrame(event.data);
      return;
    }
    renderLatest();
  };
  socket.onerror = () => socket.close();
  socket.onclose = (event) => {
    if (generation !== state.live.generation) return;
    clearInterval(state.live.heartbeat);
    clearInterval(state.live.staleTimer);
    state.live.heartbeat = null;
    state.live.staleTimer = null;
    state.live.socket = null;
    const detail = event.code === 4401
      ? 'Sesi kamera ditolak; log keluar dan log masuk semula.'
      : event.code === 4403
        ? 'Aplikasi ini belum dibenarkan oleh inference server.'
        : 'CCTV terputus; cuba semula automatik.';
    setCameraConnection('offline', detail);
    state.live.reconnectTimer = setTimeout(() => { void connectLiveStream(); }, 3000);
  };
}

async function requestNotifications() {
  if (!('Notification' in window)) return toast('Notifikasi tidak disokong pada pelayar ini');
  const permission = await Notification.requestPermission();
  toast(permission === 'granted' ? 'Notifikasi FaceGuard diaktifkan' : 'Kebenaran notifikasi tidak diberikan');
}

async function pairEsp32() {
  if (!Capacitor.isNativePlatform()) {
    return toast('Pairing ESP32 tersedia dalam APK Android');
  }
  const wifiSsid = $('#pairWifiSsidInput').value.trim();
  const wifiPassword = $('#pairWifiPasswordInput').value;
  const serverUrl = safeServerUrl($('#serverUrlInput').value);
  const deviceId = $('#deviceIdInput').value.trim();
  if (!wifiSsid) return toast('Masukkan nama Wi‑Fi 2.4 GHz');
  if (!serverUrl) return toast('Masukkan URL inference server dahulu');
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(deviceId)) return toast('Device ID tidak sah');

  const status = $('#pairingStatus');
  const button = $('#pairEsp32Btn');
  button.disabled = true;
  status.textContent = 'Menghantar konfigurasi ke ESP32-CAM…';
  try {
    const body = new URLSearchParams({
      wifi_ssid: wifiSsid,
      wifi_password: wifiPassword,
      server_url: serverUrl,
      device_id: deviceId,
    }).toString();
    const response = await CapacitorHttp.post({
      url: 'http://192.168.4.1/configure',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body,
      connectTimeout: 7000,
      readTimeout: 10000,
    });
    if (response.status < 200 || response.status >= 300) throw new Error('ESP32 menolak konfigurasi');
    status.textContent = 'Berjaya. ESP32 sedang restart dan auto-connect ke Wi‑Fi.';
    toast('ESP32 berjaya dipair dan sedang restart');
  } catch (error) {
    status.textContent = 'Gagal. Pastikan telefon masih tersambung ke Wi‑Fi FACEGUARD-.';
    toast('Pairing gagal — semak sambungan Wi‑Fi FACEGUARD-');
  } finally {
    button.disabled = false;
  }
}

function showPage(id, title) {
  document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === id));
  document.querySelectorAll('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.page === id));
  $('#pageTitle').textContent = title;
  if (id === 'eventsPage') { state.unread = 0; updateUnread(); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openRow(row) {
  const image = safeMediaUrl(row.image_url);
  if (!image) return toast('Aktiviti ini tidak mempunyai gambar');
  $('#modalImage').src = image;
  $('#modalTitle').textContent = labelFor(row);
  $('#modalTime').textContent = formatDate(row.created_at);
  $('#modalDownload').href = safeMediaUrl(row.video_url) || image;
  $('#modalDownload').textContent = safeMediaUrl(row.video_url) ? 'Buka / muat turun video AVI' : 'Buka gambar asal';
  $('#mediaModal').hidden = false;
}

async function applySession(session) {
  state.user = session?.user || null;
  renderAuth();
  await loadOwnedDevice();
  subscribeRealtime();
  await loadActivities();
  if (state.user) connectLiveStream();
  else stopLiveStream();
}

async function authenticate(mode) {
  if (state.authBusy) return;
  const email = $('#authEmailInput').value.trim();
  const password = $('#authPasswordInput').value;
  if (!email || password.length < 8) return toast('Masukkan e-mel dan kata laluan sekurang-kurangnya 8 aksara');
  state.authBusy = true;
  let result;
  try {
    result = mode === 'signup'
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
  } catch (error) {
    state.authBusy = false;
    return toast('Tidak dapat menghubungi Supabase. Semak internet dan cuba semula.');
  }
  state.authBusy = false;
  if (result.error) {
    const message = /failed to fetch|network|load failed/i.test(result.error.message)
      ? 'Tidak dapat menghubungi Supabase. Semak internet dan cuba semula.'
      : result.error.message;
    return toast(message);
  }
  if (!result.data.session) return toast('Pendaftaran berjaya. Sahkan e-mel sebelum log masuk.');
  toast(mode === 'signup' ? 'Akaun FaceGuard berjaya dibuat' : 'Log masuk berjaya');
}

document.querySelectorAll('.nav-btn').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page, button.dataset.title)));
document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
  renderEvents();
}));
$('#authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await authenticate('login');
});
$('#signUpBtn').addEventListener('click', () => authenticate('signup'));
$('#signOutBtn').addEventListener('click', async () => {
  const { error } = await supabase.auth.signOut();
  if (error) toast(error.message);
  else toast('Anda telah log keluar');
});
$('#cameraSetupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.user) return toast('Log masuk sebelum menyimpan kamera');
  const serverUrl = safeServerUrl($('#serverUrlInput').value);
  const deviceId = $('#deviceIdInput').value.trim();
  if (!serverUrl) return toast('Masukkan URL inference server yang sah');
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(deviceId)) return toast('Device ID hanya boleh menggunakan huruf, nombor, _ atau -');
  if (location.protocol === 'https:' && serverUrl.startsWith('http:')) return toast('Aplikasi HTTPS memerlukan inference server HTTPS');
  const targetFps = Math.min(25, Math.max(1, Number($('#targetFpsInput').value) || 25));
  const inferenceFps = Math.min(10, Math.max(1, Number($('#inferenceFpsInput').value) || 5));
  const fallConfirmSeconds = Math.min(10, Math.max(0.5, Number($('#fallConfirmInput').value) || 1.5));
  const payload = {
    id: deviceId,
    owner_id: state.user.id,
    name: $('#cameraNameInput').value.trim() || 'Kamera FaceGuard',
    location: $('#cameraLocationInput').value.trim() || 'Belum ditetapkan',
    server_url: serverUrl,
    detection_enabled: $('#detectionEnabledInput').checked,
    target_fps: targetFps,
    inference_fps: inferenceFps,
    fall_confirm_seconds: fallConfirmSeconds,
  };
  const { data, error } = await supabase.from('devices').upsert(payload).select().single();
  if (error) return toast(`Tetapan gagal disimpan: ${error.message}`);
  state.device = data;
  toast('Tetapan CCTV disimpan secara private di Supabase');
  connectLiveStream();
});
$('#refreshBtn').addEventListener('click', () => loadActivities(true));
$('#notifyBtn').addEventListener('click', requestNotifications);
$('#settingsNotifyBtn').addEventListener('click', requestNotifications);
$('#pairEsp32Btn').addEventListener('click', pairEsp32);
$('#viewLatestBtn').addEventListener('click', () => { const row = state.rows.find((item) => safeMediaUrl(item.image_url)); row ? openRow(row) : toast('Belum ada gambar'); });
$('#eventList').addEventListener('click', (event) => { const item = event.target.closest('[data-row-id]'); if (item) openRow(state.rows.find((row) => row.id === Number(item.dataset.rowId))); });
$('#galleryGrid').addEventListener('click', (event) => { const button = event.target.closest('[data-media-index]'); if (!button) return; const item = mediaItems()[Number(button.dataset.mediaIndex)]; item.type === 'image' ? openRow(item.row) : window.open(item.url, '_blank', 'noopener'); });
$('#closeModal').addEventListener('click', () => { $('#mediaModal').hidden = true; });
$('#mediaModal').addEventListener('click', (event) => { if (event.target === $('#mediaModal')) $('#mediaModal').hidden = true; });
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.installPrompt = event; $('#installBtn').disabled = false; });
$('#installBtn').addEventListener('click', async () => {
  if (state.installPrompt) { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; }
  else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) $('#iosHelp').hidden = false;
  else toast('Gunakan menu pelayar dan pilih “Install app”');
});

if (/iphone|ipad|ipod/i.test(navigator.userAgent)) $('#iosHelp').hidden = false;
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
window.addEventListener('online', () => loadActivities());
window.addEventListener('offline', () => setConnection('CHANNEL_ERROR'));

const initialLiveConfig = getLiveConfig();
$('#serverUrlInput').value = initialLiveConfig.serverUrl;
$('#deviceIdInput').value = initialLiveConfig.deviceId;
renderAuth();

supabase.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => applySession(session), 0);
});
const { data: { session } } = await supabase.auth.getSession();
await applySession(session);
