import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://rerhdlfuiemsuzygjzqx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_e-BT7oYj2e5sl07riD-kgQ_MLRUiaT6';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const $ = (selector) => document.querySelector(selector);
const state = { rows: [], filter: 'all', unread: 0, installPrompt: null, channel: null };
const statusLabels = {
  pergerakan_kamera: 'Gerakan dikesan oleh kamera',
  pergerakan_dikesan: 'Pergerakan dikesan',
  gambar_dan_video: 'Gambar dan video tersedia',
  gambar_sahaja: 'Gambar tersedia',
  microsd_tidak_tersedia: 'Gambar tersedia',
  video_upload_gagal: 'Gambar tersedia · video gagal',
  video_rakaman_gagal: 'Gambar tersedia · rakaman gagal',
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function safeMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'rerhdlfuiemsuzygjzqx.supabase.co' ? url.href : '';
  } catch { return ''; }
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
  const row = state.rows.find((item) => safeMediaUrl(item.image_url));
  const image = $('#latestImage');
  const empty = $('#cameraEmpty');
  if (!row) {
    image.hidden = true;
    empty.hidden = false;
    $('#latestStatus').textContent = 'Menunggu kamera';
    $('#latestTime').textContent = '—';
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
  const { data, error } = await supabase.from('aktiviti_log').select('id,created_at,image_url,status,video_url').order('created_at', { ascending: false }).limit(100);
  if (error) {
    $('#eventList').innerHTML = `<div class="empty-state error">Data gagal dimuatkan.<br>${escapeHtml(error.message)}</div>`;
    setConnection('CHANNEL_ERROR');
    return;
  }
  state.rows = data || [];
  renderAll();
  if (showToast) toast('Data FaceGuard dikemas kini');
}

function showNotification(row) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  new Notification('FaceGuard: gerakan dikesan', { body: labelFor(row), icon: '/icon.svg', tag: `faceguard-${row.id}` });
}

function subscribeRealtime() {
  state.channel = supabase.channel('faceguard-activity')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'aktiviti_log' }, ({ new: row }) => {
      if (state.rows.some((item) => item.id === row.id)) return;
      state.rows.unshift(row);
      state.rows = state.rows.slice(0, 100);
      state.unread += 1;
      renderAll();
      showNotification(row);
      toast('Gerakan baharu dikesan');
    })
    .subscribe((status) => setConnection(status));
}

async function requestNotifications() {
  if (!('Notification' in window)) return toast('Notifikasi tidak disokong pada pelayar ini');
  const permission = await Notification.requestPermission();
  toast(permission === 'granted' ? 'Notifikasi FaceGuard diaktifkan' : 'Kebenaran notifikasi tidak diberikan');
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

document.querySelectorAll('.nav-btn').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page, button.dataset.title)));
document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
  renderEvents();
}));
$('#refreshBtn').addEventListener('click', () => loadActivities(true));
$('#notifyBtn').addEventListener('click', requestNotifications);
$('#settingsNotifyBtn').addEventListener('click', requestNotifications);
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

loadActivities();
subscribeRealtime();
