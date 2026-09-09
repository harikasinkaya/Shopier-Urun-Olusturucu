'use strict';
/* Shopier toplu urun botu — tek dosya. Resmi Shopier API kullanir.
 * Calistir: node index.js  (sonra http://localhost:3000 ac)
 * Gerekenler:
 *  1) Shopier PAT: Hesabim > Personal Access Token (once 2FA acilmali).
 *  2) Herkese acik bir urun gorseli URL'si (mevcut urun gorseline sag tik > URL kopyala).
 */
const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const API_BASE = 'https://api.shopier.com/v1';

const FLOOR_MS = 500;      // hard floor: altina inilmez
const DANGER_UNDER = 800;  // alti tehlikeli, onay ister
const MAX_ITEMS = 5000;
const MAX_LOGS = 200;

const state = {
  running: false,
  paused: false,
  params: null,
  queue: [],
  idx: 0,
  ok: 0,
  fail: 0,
  timer: null,
  startedAt: null,
  nextAt: null,
  note: '',
  consecFail: 0,
  logs: [],
  lastResponse: null,
};

function log(kind, price, title, detail) {
  state.logs.unshift({
    t: new Date().toLocaleTimeString('tr-TR', { hour12: false }),
    kind, // ok | err | info
    price: price === undefined || price === null ? '' : String(price),
    title: title || '',
    detail: String(detail || '').slice(0, 160),
  });
  if (state.logs.length > MAX_LOGS) state.logs.length = MAX_LOGS;
}

function isIntStr(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function parseIntStrict(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (!isIntStr(v)) return null;
  const n = Number(String(v).trim());
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

function classify(ms) {
  if (ms < FLOOR_MS) return { key: 'blocked', text: 'Engellendi: 500ms altina inilemez.' };
  if (ms < DANGER_UNDER) return { key: 'danger', text: 'Tehlikeli bolge: devam etmek icin onay gerekir.' };
  return { key: 'safe', text: 'Resmi limit (200/dk) altinda. Guvenli.' };
}

function buildPreview(template, min, max, step) {
  const items = [];
  for (let p = min; p <= max; p += step) items.push(p);
  return items;
}

async function apiCall(path, pat, method, payload) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: 'Bearer ' + pat,
    'user-agent': 'shopier-bulk-bot/1.0',
  };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: res.status, retryAfter: res.headers.get('retry-after'), text, json };
  } finally {
    clearTimeout(to);
  }
}

async function postOne(item, p) {
  const payload = {
    title: item.title,
    description: p.description || '',
    type: 'digital',
    media: [{ type: 'image', url: p.imageUrl, placement: 1 }],
    priceData: { currency: 'TRY', price: String(item.price) },
    shippingPayer: 'sellerPays',
    stockQuantity: parseIntStrict(p.stock) || 1000,
  };
  return apiCall('/products', p.pat, 'POST', payload);
}

function scheduleNext(delayMs) {
  clearTimeout(state.timer);
  state.nextAt = Date.now() + delayMs;
  state.timer = setTimeout(tick, delayMs);
}

async function tick() {
  if (!state.running || state.paused || !state.params) return;
  const p = state.params;
  if (state.idx >= state.queue.length) {
    state.running = false;
    state.note = 'Tamamlandi: ' + state.ok + ' basarili, ' + state.fail + ' hatali.';
    log('info', null, 'Bitti', state.note);
    return;
  }
  const item = state.queue[state.idx];
  let outcome;
  try {
    outcome = await postOne(item, p);
  } catch (e) {
    outcome = { status: 0, retryAfter: null, text: 'fetch hatasi: ' + (e && e.message ? e.message : e), json: null };
  }

  const { status, text, json } = outcome;
  state.lastResponse = {
    t: new Date().toLocaleTimeString('tr-TR', { hour12: false }),
    price: item.price,
    title: item.title,
    status,
    body: String(text || '').slice(0, 3000),
  };

  if (status === 429) {
    const waitSec = parseIntStrict(outcome.retryAfter) || 30;
    state.consecFail += 1;
    state.fail += 1;
    log('err', item.price, item.title, '429 rate limit — ' + waitSec + 'sn bekleyip otomatik devam edilecek.');
    state.paused = true;
    state.note = '429 alindi, ' + waitSec + 'sn bekleniyor (otomatik devam edecek).';
    clearTimeout(state.timer);
    state.nextAt = Date.now() + waitSec * 1000;
    state.timer = setTimeout(() => {
      state.paused = false;
      state.note = '';
      log('info', null, 'Devam', 'Bekleme bitti, kuyruga devam ediliyor.');
      tick();
    }, waitSec * 1000);
    return;
  }

  if (status === 401) {
    state.running = false;
    state.fail += 1;
    state.note = 'PAT gecersiz (401). Tokeni kontrol edip yeniden baslatin.';
    log('err', item.price, item.title, 'HTTP 401 — PAT kabul edilmedi. Durduruldu.');
    return;
  }

  if (status === 403) {
    state.running = false;
    state.fail += 1;
    state.note = 'Erisim reddedildi (403). PAT yetkisini kontrol edin.';
    log('err', item.price, item.title, 'HTTP 403 — ' + String(text || '').slice(0, 120));
    return;
  }

  if (status >= 200 && status < 300) {
    const pid = json ? (json.id || (json.product && json.product.id)) : null;
    const purl = json ? (json.url || (json.product && json.product.url)) : null;
    if (pid) {
      state.consecFail = 0;
      state.ok += 1;
      state.idx += 1;
      log('ok', item.price, item.title, 'id ' + pid + (purl ? ' ' + purl : ''));
      if (state.idx < state.queue.length) {
        const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±%20
        scheduleNext(Math.max(FLOOR_MS, Math.round(p.cooldownMs * jitter)));
        return;
      }
      state.running = false;
      state.note = 'Tamamlandi: ' + state.ok + ' basarili, ' + state.fail + ' hatali.';
      log('info', null, 'Bitti', state.note);
      return;
    }
    state.consecFail += 1;
    state.fail += 1;
    log('err', item.price, item.title, 'HTTP ' + status + ' ama yanit urun icermiyor: ' + String(text || '').slice(0, 120));
  } else {
    state.consecFail += 1;
    state.fail += 1;
    log('err', item.price, item.title, 'HTTP ' + status + ' — ' + String(text || '').slice(0, 120));
  }

  if (state.consecFail >= 3) {
    state.running = false;
    state.note = 'Art arda 3 hata — durduruldu. Logu kontrol edip kalinan fiyattan devam edin.';
    log('info', null, 'Durduruldu', state.note);
    return;
  }
  // Tekil hata: ayni urunu atlamadan, biraz daha uzun bekleyip tekrar dene.
  const jitter = 1 + (Math.random() * 0.4 - 0.2);
  scheduleNext(Math.max(FLOOR_MS, Math.round(p.cooldownMs * jitter)) + 2000);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
}

function validateCommon(b) {
  const template = String(b.template || '');
  if (!template.includes('%para%')) return { err: 'Urun adinda %para% olmali. Ornek: Apicloud Bakiyesi %para% TL' };
  const min = parseIntStrict(b.min);
  const max = parseIntStrict(b.max);
  let step = b.step === undefined || b.step === '' ? 1 : parseIntStrict(b.step);
  if (min === null || max === null || step === null) return { err: 'Min, max ve artis sadece tam sayi olabilir (ornek: 100). 102.50 gibi deger girilemez.' };
  if (step < 1) return { err: 'Artis en az 1 olabilir.' };
  if (min > max) return { err: 'Min degeri max degerden buyuk olamaz.' };
  const total = Math.floor((max - min) / step) + 1;
  if (total < 1) return { err: 'Urun listesi bos.' };
  if (total > MAX_ITEMS) return { err: 'Tek seferde en fazla ' + MAX_ITEMS + ' urun (su an ' + total + '). Araligi daraltin.' };
  let cooldownMs = parseIntStrict(b.cooldownMs);
  if (cooldownMs === null) return { err: 'Cooldown sadece tam sayi (ms) olabilir.' };
  if (cooldownMs < FLOOR_MS) return { err: 'Cooldown en az ' + FLOOR_MS + 'ms olabilir.' };
  return { template, min, max, step, total, cooldownMs };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/status') {
    const p = state.params;
    send(res, 200, {
      running: state.running,
      paused: state.paused,
      total: state.queue.length,
      done: state.idx,
      ok: state.ok,
      fail: state.fail,
      note: state.note,
      nextAt: state.nextAt,
      nextPrice: state.queue[state.idx] ? state.queue[state.idx].price : null,
      cooldownMs: p ? p.cooldownMs : null,
      logs: state.logs.slice(0, 60),
      lastResponse: state.lastResponse,
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/preview') {
    try {
      const b = await readJson(req);
      const v = validateCommon(b);
      if (v.err) return send(res, 400, { error: v.err });
      const all = buildPreview(v.template, v.min, v.max, v.step);
      const sample = all.slice(0, 8).map((p) => ({ price: p, title: v.template.split('%para%').join(String(p)) }));
      const secs = Math.round((all.length * v.cooldownMs) / 1000);
      send(res, 200, {
        total: all.length,
        sample,
        lastTitle: v.template.split('%para%').join(String(all[all.length - 1])),
        estSeconds: secs,
        estText: secs >= 3600 ? Math.floor(secs / 3600) + ' sa ' + Math.round((secs % 3600) / 60) + ' dk'
          : secs >= 60 ? Math.floor(secs / 60) + ' dk ' + (secs % 60) + ' sn'
          : secs + ' sn',
        classify: classify(v.cooldownMs),
      });
    } catch (e) { send(res, 400, { error: 'Gecersiz JSON.' }); }
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/test') {
    try {
      const b = await readJson(req);
      const pat = String(b.pat || '').trim();
      if (!pat) return send(res, 200, { ok: false, message: 'PAT bos.', probes: [] });
      const paths = ['/shop/settings', '/products?limit=1'];
      const probes = [];
      for (let i = 0; i < paths.length; i++) {
        try {
          const r = await apiCall(paths[i], pat, 'GET');
          probes.push({ path: paths[i], status: r.status, snippet: String(r.text || '').slice(0, 200) });
        } catch (e) {
          probes.push({ path: paths[i], status: 0, snippet: 'Ag hatasi: ' + (e && e.message ? e.message : e) });
        }
      }
      const okOne = probes.some((x) => x.status >= 200 && x.status < 300);
      const all403 = probes.length > 0 && probes.every((x) => x.status === 403);
      let message;
      if (okOne) message = 'Baglanti calisiyor.';
      else if (probes.some((x) => x.status === 401)) message = 'PAT gecersiz (401). Tokeni kontrol edin.';
      else if (all403) message = 'Token gecerli ama hesap genelinde erisim reddediliyor (403). Asagidaki adimlara bakin.';
      else message = 'Baglanti kurulamadi.';
      return send(res, 200, { ok: okOne, message, probes });
    } catch (e) { send(res, 400, { error: 'Gecersiz JSON.' }); }
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/start') {
    try {
      const b = await readJson(req);
      if (state.running) return send(res, 409, { error: 'Zaten calisan bir kuyruk var. Once durdurun.' });
      const v = validateCommon(b);
      if (v.err) return send(res, 400, { error: v.err });
      const pat = String(b.pat || '').trim();
      const imageUrl = String(b.imageUrl || '').trim();
      if (pat.length < 10) return send(res, 400, { error: 'PAT bos veya cok kisa. Shopier panelinden aldiginiz tokeni yapistirin.' });
      if (imageUrl.slice(0, 7) !== 'http://' && imageUrl.slice(0, 8) !== 'https://') {
        return send(res, 400, { error: 'Gorsel URL http(s) ile baslamali. Mevcut urun gorseline sag tiklayip URL kopyalayin.' });
      }
      if (v.cooldownMs < DANGER_UNDER && !b.acceptRisk) {
        return send(res, 400, { error: 'Tehlikeli bolge: ' + v.cooldownMs + 'ms. Devam etmek icin riski onaylayin.', needAccept: true });
      }
      const prices = buildPreview(v.template, v.min, v.max, v.step);
      state.params = {
        pat,
        imageUrl,
        description: String(b.description || ''),
        stock: String(b.stock || '1000'),
        cooldownMs: v.cooldownMs,
      };
      state.queue = prices.map((p) => ({ price: p, title: v.template.split('%para%').join(String(p)) }));
      state.idx = 0; state.ok = 0; state.fail = 0;
      state.consecFail = 0; state.note = '';
      state.lastResponse = null;
      state.running = true; state.paused = false;
      state.startedAt = Date.now();
      log('info', null, 'Basladi', state.queue.length + ' urun, ' + v.min + '→' + v.max + ', ' + v.cooldownMs + 'ms aralik.');
      scheduleNext(300);
      send(res, 200, { started: true, total: state.queue.length });
    } catch (e) { send(res, 400, { error: 'Gecersiz JSON.' }); }
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/stop') {
    clearTimeout(state.timer);
    state.running = false;
    state.paused = false;
    state.note = 'Kullanici durdurdu. Kalinan fiyat: ' + (state.queue[state.idx] ? state.queue[state.idx].price : '-');
    log('info', null, 'Durduruldu', state.note);
    send(res, 200, { stopped: true, nextPrice: state.queue[state.idx] ? state.queue[state.idx].price : null });
    return;
  }

  send(res, 404, { error: 'Bulunamadi.' });
});

const PAGE = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shopier Toplu Ürün</title>
<style>
  :root { --bg:#0e0f11; --line:#222326; --fg:#e8e8e9; --mut:#8f9096; --ok:#34d399; --err:#f87171; --warn:#fbbf24; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif; }
  main { max-width:1180px; margin:0 auto; padding:0 24px 80px; }
  .top { display:flex; align-items:baseline; gap:10px; padding:20px 0 12px; border-bottom:1px solid var(--line); }
  .top h1 { font-size:15px; margin:0; font-weight:600; }
  .top span { margin-left:auto; font-size:12px; color:var(--mut); font-family:var(--mono); }
  .progress { height:3px; background:#1c1d20; margin:14px 0 4px; }
  .progress i { display:block; height:100%; background:var(--ok); width:0%; }
  #statusLine { font-size:12px; color:var(--mut); font-family:var(--mono); margin:0 0 6px; }
  h2 { font-size:13px; margin:28px 0 2px; font-weight:600; }
  h2 .n { color:var(--mut); font-weight:400; margin-right:6px; font-family:var(--mono); font-size:12px; }
  .sub { color:var(--mut); font-size:12px; margin:0 0 10px; }
  label { display:block; font-size:12px; color:var(--mut); margin:12px 0 4px; }
  input[type=text], input[type=number], input[type=password], textarea { width:100%; border:1px solid #2b2c30; border-radius:6px; padding:10px 11px; font-size:14px; font-family:inherit; background:#131416; color:var(--fg); }
  textarea { min-height:56px; resize:vertical; font-family:var(--mono); font-size:12px; }
  input:focus, textarea:focus { outline:none; border-color:#5b5c62; }
  .row2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  @media (max-width:560px){ .row2{grid-template-columns:1fr;} }
  .cols { display:grid; grid-template-columns:400px 1fr; gap:0; align-items:start; }
  .col-l { padding-right:28px; }
  .col-r { border-left:1px solid var(--line); padding-left:28px; min-width:0; }
  @media (max-width:900px){ .cols{grid-template-columns:1fr;} .col-l{padding-right:0;} .col-r{border-left:none; padding-left:0; border-top:1px solid var(--line); margin-top:8px;} }
  details { margin-top:14px; border-top:1px dashed var(--line); padding-top:10px; }
  details summary { cursor:pointer; font-size:12px; color:var(--mut); }
  .speeds { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-top:8px; }
  .speeds button { background:#131416; color:var(--mut); border:1px solid #2b2c30; border-radius:6px; padding:9px 4px; font-size:12px; cursor:pointer; text-align:center; line-height:1.4; }
  .speeds button b { display:block; color:var(--fg); font-size:13px; }
  .speeds button.on { border-color:var(--fg); color:var(--fg); }
  .speeds button.on b { color:#fff; }
  #speedLine { font-size:12px; color:var(--mut); margin-top:8px; }
  #speedLine.bad { color:var(--err); }
  #testLine { font-size:12px; color:var(--mut); margin-top:8px; font-family:var(--mono); }
  .check { display:flex; gap:8px; align-items:flex-start; font-size:12px; color:var(--mut); margin-top:8px; }
  #previewBox { display:none; margin-top:14px; border-left:2px solid var(--ok); padding:2px 0 2px 12px; font-size:13px; }
  #previewBox.err { border-color:var(--err); }
  #previewBox .mono { font-family:var(--mono); font-size:12px; color:var(--mut); }
  .actions { display:flex; gap:8px; margin-top:16px; }
  button.act { flex:1; border-radius:6px; font-size:14px; padding:11px; cursor:pointer; font-weight:600; }
  #btnStart { background:#fafafa; color:#09090b; border:1px solid #fafafa; }
  #btnStart:disabled { background:#232428; border-color:#232428; color:#5b5c62; cursor:not-allowed; font-weight:400; }
  #btnStop { flex:0 0 auto; background:transparent; color:var(--fg); border:1px solid #2e2f34; font-weight:400; padding:11px 18px; }
  #btnTest { background:transparent; color:var(--fg); border:1px solid #2e2f34; border-radius:6px; font-size:13px; padding:9px 16px; cursor:pointer; margin-top:10px; }
  #logs { list-style:none; margin:12px 0 0; padding:0; font-family:var(--mono); font-size:12px; }
  @media (min-width:901px){ #logs { max-height:62vh; overflow-y:auto; } }
  #logs li { padding:6px 0; border-bottom:1px solid #17181b; color:#c9cacc; }
  #logs li .t { color:var(--mut); margin-right:8px; }
  #logs li.ok { color:var(--ok); } #logs li.err { color:var(--err); }
  #logs li small { display:block; color:var(--mut); font-family:inherit; }
  #lastResp { font-family:var(--mono); font-size:11px; color:#c9cacc; background:#131416; border:1px solid #2b2c30; border-radius:6px; padding:10px 11px; white-space:pre-wrap; word-break:break-all; max-height:220px; overflow-y:auto; margin:4px 0 0; }
  code { font-family:var(--mono); font-size:11px; background:#1a1b1e; padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
<main>
  <div class="top"><h1>Shopier Toplu Ürün</h1><span id="dot">hazır</span></div>
  <div class="progress"><i id="bar"></i></div>
  <p id="statusLine">Henüz işlem yok.</p>

  <div class="cols">
  <div class="col-l">
  <h2><span class="n">1</span>API erişimi</h2>
  <p class="sub">Resmi Shopier API kullanılır. Shopier hesabınızda 2FA açın, sonra Hesabım > Personal Access Token bölümünden Generate ile token alın (bir kez gösterilir, kopyalayın).</p>
  <label>PAT (token)</label>
  <input type="password" id="pat" autocomplete="off" placeholder="tokeni buraya yapıştırın">
  <button id="btnTest" type="button">Bağlantıyı test et</button>
  <div id="testLine"></div>
  <label>Ürün görseli URL</label>
  <input type="text" id="imageUrl" autocomplete="off" placeholder="https://.../gorsel.jpg">
  <p class="sub">Mevcut bir ürün görseline sağ tıklayıp URL kopyalayın. Tüm ürünlerde aynı görsel kullanılır.</p>

  <h2><span class="n">2</span>Ürünler</h2>
  <p class="sub">Fiyatın yazılacağı yere <code>%para%</code> koyun. Sadece tam sayı açılır, küsurat girilemez.</p>
  <label>Ürün adı</label>
  <input type="text" id="template" value="Apicloud Bakiyesi %para% TL">
  <div class="row2">
    <div><label>Başlangıç (TL)</label><input type="number" id="min" value="100" min="1" step="1"></div>
    <div><label>Bitiş (TL)</label><input type="number" id="max" value="2000" min="1" step="1"></div>
  </div>
  <details>
    <summary>Diğer ayarlar (açıklama, stok, artış)</summary>
    <label>Açıklama</label>
    <input type="text" id="description" value="Apicloud için bakiye paketidir.">
    <div class="row2">
      <div><label>Artış (TL)</label><input type="number" id="step" value="1" min="1" step="1"></div>
      <div><label>Stok (her ürün)</label><input type="number" id="stock" value="1000" min="1" step="1"></div>
    </div>
  </details>

  <h2><span class="n">3</span>Hız</h2>
  <p class="sub">Ürünler arası bekleme. Resmi limit dakikada 200 istek.</p>
  <div class="speeds">
    <button type="button" data-ms="3500" class="on"><b>Yavaş</b>3,5 sn · güvenli</button>
    <button type="button" data-ms="2000"><b>Normal</b>2 sn · güvenli</button>
    <button type="button" data-ms="1000"><b>Hızlı</b>1 sn · güvenli</button>
  </div>
  <div class="row2" style="margin-top:10px">
    <div><label>Özel bekleme (ms, en az 500)</label><input type="number" id="cooldownMs" value="3500" min="500" step="100"></div>
    <div><label>&nbsp;</label><div id="speedLine" style="padding-top:10px">3500ms — güvenli.</div></div>
  </div>
  <label class="check" id="riskWrap" style="display:none"><input type="checkbox" id="acceptRisk"> <span>800ms altının tehlikeli olduğunu anlıyorum.</span></label>
  </div>
  <div class="col-r">
  <h2><span class="n">4</span>Başlat</h2>
  <p class="sub">Önce kontrol edin, sonra başlatın.</p>
  <div class="actions">
    <button class="act" id="btnPreview" type="button">Kontrol et</button>
  </div>
  <div id="previewBox"></div>
  <div class="actions">
    <button class="act" id="btnStart" type="button" disabled>Başlat</button>
    <button class="act" id="btnStop" type="button">Durdur</button>
  </div>
  <label style="margin-top:14px">Son yanıt — Shopier'in döndüğü ham metin</label>
  <pre id="lastResp">Henüz istek yok. Tek ürünle deneyip buraya bakın.</pre>

  <h2><span class="n">5</span>Kayıtlar</h2>
  <ul id="logs"><li><span class="t">—</span>Henüz kayıt yok.</li></ul>
  </div>
  </div>
</main>
<script>
var $ = function(id){ return document.getElementById(id); };
var lastPreview = null;

function speed(ms){
  var el = $('speedLine'), wrap = $('riskWrap');
  var txt, bad = false;
  if (ms < 500) { txt = '500ms altina inilemez.'; bad = true; }
  else if (ms < 800) { txt = ms + 'ms — tehlikeli bolge, onay gerekli.'; bad = true; }
  else if (ms < 2000) { txt = ms + 'ms — resmi limit (200/dk) altinda, guvenli.'; }
  else { txt = ms + 'ms — guvenli.'; }
  el.textContent = txt;
  el.className = bad ? 'bad' : '';
  el.id = 'speedLine';
  wrap.style.display = ms < 800 ? 'flex' : 'none';
  var btns = document.querySelectorAll('.speeds button');
  for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', parseInt(btns[i].getAttribute('data-ms'), 10) === ms);
}
document.querySelectorAll('.speeds button').forEach(function(b){
  b.addEventListener('click', function(){ $('cooldownMs').value = b.getAttribute('data-ms'); speed(parseInt(b.getAttribute('data-ms'), 10)); });
});
$('cooldownMs').addEventListener('input', function(e){ speed(parseInt(e.target.value || '0', 10)); });
speed(3500);

function collect(){
  return {
    template: $('template').value, description: $('description').value,
    min: $('min').value, max: $('max').value, step: $('step').value,
    stock: $('stock').value, cooldownMs: $('cooldownMs').value,
    pat: $('pat').value, imageUrl: $('imageUrl').value,
    acceptRisk: $('acceptRisk').checked
  };
}
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function isIntStr(v){
  v = String(v === undefined || v === null ? '' : v).trim();
  if (!v) return false;
  for (var i = 0; i < v.length; i++) { var c = v.charCodeAt(i); if (c < 48 || c > 57) return false; }
  return true;
}
function previewMsg(html, isErr){
  var box = $('previewBox');
  box.style.display = 'block';
  box.className = isErr ? 'err' : '';
  box.id = 'previewBox';
  box.innerHTML = html;
}

$('btnTest').addEventListener('click', async function(){
  $('testLine').textContent = 'Test ediliyor...';
  var r = await fetch('/api/test', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ pat: $('pat').value }) });
  var j = await r.json();
  var extra = '';
  if (j.probes && j.probes.length) {
    extra = '  |  ' + j.probes.map(function(x){ return x.path + ': HTTP ' + x.status; }).join('  |  ');
  }
  $('testLine').textContent = (j.ok ? 'OK — ' : 'HATA — ') + (j.message || '') + extra;
  $('testLine').style.color = j.ok ? 'var(--ok)' : 'var(--err)';
});

$('btnPreview').addEventListener('click', async function(){
  var b = collect();
  var badInt = !isIntStr(b.min) ? 'Baslangic' : !isIntStr(b.max) ? 'Bitis' : !isIntStr(b.step) ? 'Artis' : null;
  if (badInt) {
    previewMsg(badInt + ' alanina sadece tam sayi yazin. Ornek: 100. Kusurat girilemez.', true);
    $('btnStart').disabled = true; return;
  }
  var r = await fetch('/api/preview', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(b) });
  var j = await r.json();
  if (!r.ok) { previewMsg(esc(j.error), true); $('btnStart').disabled = true; return; }
  lastPreview = j;
  previewMsg('<b>' + j.total + ' urun acilacak</b> (' + esc(String(b.min)) + ' TL den ' + esc(String(b.max)) + ' TL ye) · tahmini ' + esc(j.estText) + '<br><span class="mono">Ilk: ' + esc(j.sample[0].title) + '<br>Son: ' + esc(j.lastTitle) + '</span>', false);
  $('statusLine').textContent = j.total + ' urun hazir — Baslat a basin.';
  $('btnStart').disabled = false;
});

$('btnStart').addEventListener('click', async function(){
  if (!lastPreview) return;
  var r = await fetch('/api/start', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(collect()) });
  var j = await r.json();
  if (!r.ok) { previewMsg(esc(j.error), true); return; }
  $('statusLine').textContent = j.total + ' urun kuyrukta.';
});

$('btnStop').addEventListener('click', async function(){
  await fetch('/api/stop', { method:'POST' });
});

async function poll(){
  try {
    var r = await fetch('/api/status'); var j = await r.json();
    $('dot').textContent = j.running ? (j.paused ? 'bekliyor' : j.done + '/' + j.total) : 'hazır';
    if (j.total) {
      $('bar').style.width = (100 * j.done / j.total).toFixed(1) + '%';
      $('statusLine').textContent = j.running
        ? (j.paused ? 'Bekliyor: ' + j.note : j.done + '/' + j.total + ' · ' + j.ok + ' basarili · ' + j.fail + ' hatali' + (j.nextPrice != null ? ' · siradaki ' + j.nextPrice + ' TL' : ''))
        : ((j.note || 'Bitti.') + ' ' + j.ok + ' basarili · ' + j.fail + ' hatali.');
    }
    if (j.lastResponse) {
      var lr = j.lastResponse;
      var b0 = (lr.body || '').trim();
      var hint = '';
      if (!b0) hint = ' — BOS YANIT: urun olusmamis olabilir.';
      else if (b0.charAt(0) === '<') hint = ' — HTML sayfa dondu: token gecersiz olabilir.';
      $('lastResp').textContent = '[' + lr.t + '] ' + lr.price + ' TL · HTTP ' + lr.status + hint + '  |  ' + (lr.body || '(boş yanıt)');
    }
    if (j.logs && j.logs.length) {
      $('logs').innerHTML = j.logs.slice(0, 30).map(function(l){
        var head = l.kind === 'ok' ? 'acildi' : l.kind === 'err' ? 'hata' : 'bilgi';
        return '<li class="' + l.kind + '"><span class="t">' + esc(l.t) + '</span>' + head + (l.price ? ' · ' + esc(l.price) + ' TL' : '') + (l.title ? ' · ' + esc(l.title) : '') + (l.detail ? '<small>' + esc(l.detail) + '</small>' : '') + '</li>';
      }).join('');
    }
  } catch(e) {}
  setTimeout(poll, 2000);
}
poll();
</script>
</body>
</html>`;

server.listen(PORT, () => {
  console.log('Shopier bot hazir: http://localhost:' + PORT);
});
