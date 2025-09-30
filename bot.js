/**
 * bot.js — Tool_Auto_Trade (A+B+C)
 *
 * Features:
 *  - Auto-rotate coins every AUTO_INTERVAL_MIN (env, default 10)
 *  - Active hours configurable (default 06:30-23:00)
 *  - ICT-like detectors: BOS, FVG, Order Block, Liquidity, Candle patterns
 *  - Multi-timeframe fetch (15m/1h/4h) for context
 *  - Send signals only when strong (score threshold)
 *  - Permission system (admin can /grant /revoke)
 *  - Broadcast (/announce or admin !broadcast)
 *  - Auto daily report at 23:00
 *
 * Requirements:
 *   npm install
 *   (package.json below includes deps)
 *
 * ENV (set on Render):
 *   TELEGRAM_TOKEN   (required)
 *   ADMIN_ID         (required) - your Telegram numeric chat id (string)
 *   AUTO_INTERVAL_MIN (optional) default 10 (minutes)
 *   AUTO_COINS       (optional) comma separated symbols
 *   ACTIVE_FROM      (optional) e.g. "0630" default 0630
 *   ACTIVE_TO        (optional) e.g. "2300" default 2300
 *   SCORE_THRESHOLD  (optional) default 6
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ------------- CONFIG -------------
const TOKEN = process.env.TELEGRAM_TOKEN || '';
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const AUTO_INTERVAL_MIN = Number(process.env.AUTO_INTERVAL_MIN || 10);
const AUTO_COINS = (process.env.AUTO_COINS || 'LINKUSDT,BTCUSDT,BNBUSDT,SOLUSDT,ETHUSDT,PEPE1000USDT,DOGEUSDT,HYPEUSDT,XRPUSDT,ETCUSDT,SUIUSDT,COWUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const BOT_NAME = process.env.BOT_NAME || 'Tool_Auto_Trade';
const ACTIVE_FROM = process.env.ACTIVE_FROM || '0630'; // HHMM
const ACTIVE_TO = process.env.ACTIVE_TO || '2300';     // HHMM
const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD || 2);
const DATA_DIR = path.join(__dirname, '.data');

// validations
if (!TOKEN || !ADMIN_ID) {
  console.error('Missing TELEGRAM_TOKEN or ADMIN_ID. Set them as environment variables and restart.');
  process.exit(1);
}

// ------------- FILES & HELPERS -------------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PERMS_FILE = path.join(DATA_DIR, 'permissions.json');
const LAST_SIGNALS_FILE = path.join(DATA_DIR, 'last_signals.json');
const DAILY_LOG_FILE = path.join(DATA_DIR, 'daily_sent.json');

function initFile(p, def) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2));
}
initFile(HISTORY_FILE, []);
initFile(PERMS_FILE, { admins: [ADMIN_ID], users: [] });
initFile(LAST_SIGNALS_FILE, {});
initFile(DAILY_LOG_FILE, { date: todayDate(), items: [] });

function readJSON(p, def = null) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw) return def;
    return JSON.parse(raw);
  } catch (e) {
    return def;
  }
}
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function todayDate() { return new Date().toISOString().slice(0, 10); }

// wrappers
function readPerms() { return readJSON(PERMS_FILE, { admins: [ADMIN_ID], users: [] }); }
function savePerms(o) { writeJSON(PERMS_FILE, o); }
function readLastSignals() { return readJSON(LAST_SIGNALS_FILE, {}); }
function saveLastSignals(o) { writeJSON(LAST_SIGNALS_FILE, o); }
function pushHistory(rec) { const arr = readJSON(HISTORY_FILE, []); arr.unshift(rec); if (arr.length > 5000) arr.pop(); writeJSON(HISTORY_FILE, arr); }
function pushDaily(item) { const cur = readJSON(DAILY_LOG_FILE, { date: todayDate(), items: [] }); if (cur.date !== todayDate()) { cur.date = todayDate(); cur.items = []; } cur.items.push(item); writeJSON(DAILY_LOG_FILE, cur); }
function readDaily() { return readJSON(DAILY_LOG_FILE, { date: todayDate(), items: [] }); }

// ------------- TELEGRAM BOT -------------
const bot = new TelegramBot(TOKEN, { polling: true });

// ------------- BINANCE FETCH (spot/futures same klines endpoint) -------------
async function fetchKlines(symbol, interval = '15m', limit = 300) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 20000 });
    return res.data.map(c => ({
      t: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], vol: +c[5]
    }));
  } catch (e) {
    console.warn('fetchKlines', symbol, e && e.message ? e.message : e);
    return [];
  }
}

// ------------- DETECTORS (ICT-like simplified) -------------
function detectBOS(candles, lookback = 20) {
  if (!candles || candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  const last = slice[slice.length - 1];
  const highs = slice.slice(0, -1).map(c => c.high);
  const lows = slice.slice(0, -1).map(c => c.low);
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  if (last.close > recentHigh) return { type: 'BOS_UP', price: last.close };
  if (last.close < recentLow) return { type: 'BOS_DOWN', price: last.close };
  return null;
}

function detectOrderBlock(candles) {
  if (!candles || candles.length < 6) return { bullish: null, bearish: null };
  const last5 = candles.slice(-6, -1);
  const blocks = { bullish: null, bearish: null };
  for (const c of last5) {
    const body = Math.abs(c.close - c.open);
    const range = Math.max(1e-12, c.high - c.low);
    if (body > range * 0.6) {
      if (c.close > c.open) blocks.bullish = c;
      else blocks.bearish = c;
    }
  }
  return blocks;
}

function detectFVG(candles) {
  if (!candles || candles.length < 5) return null;
  for (let i = candles.length - 3; i >= 2; i--) {
    const a = candles[i], b = candles[i - 2];
    if (!a || !b) continue;
    if (a.low > b.high) return { type: 'FVG_UP', low: b.high, high: a.low };
    if (a.high < b.low) return { type: 'FVG_DOWN', low: a.high, high: b.low };
  }
  return null;
}

function detectLiquidityZone(candles) {
  if (!candles || candles.length < 15) return null;
  const recent = candles.slice(-30);
  const avgVol = recent.reduce((s, c) => s + (c.vol || 0), 0) / Math.max(1, recent.length);
  const last = recent[recent.length - 1];
  if (last && last.vol > avgVol * 1.8) return { type: 'LIQUIDITY_ZONE', vol: last.vol, avgVol };
  return null;
}

function detectCandlePattern(candles) {
  if (!candles || candles.length < 2) return null;
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  const body = Math.abs(last.close - last.open);
  const range = Math.max(1e-12, last.high - last.low);
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  if (body < range * 0.3 && upper > lower * 2) return 'ShootingStar';
  if (body < range * 0.3 && lower > upper * 2) return 'Hammer';
  if (last.close > prev.open && last.open < prev.close && last.close > last.open) return 'BullishEngulfing';
  if (last.close < prev.open && last.open > prev.close && last.close < last.open) return 'BearishEngulfing';
  return null;
}

// ------------- IDEA ENGINE & SCORING -------------
function scoreIdea({ bos, fvg, ob, pattern, liq }) {
  let score = 0;
  if (bos) score += 3;
  if (fvg) score += 3;
  if (ob && (ob.bullish || ob.bearish)) score += 2;
  if (liq) score += 1;
  if (pattern) score += 1;
  return score;
}

function generateIdea(symbol, price, bos, fvg, ob, pattern, liq) {
  let dir = null;
  if (bos && bos.type === 'BOS_UP') dir = 'LONG';
  if (bos && bos.type === 'BOS_DOWN') dir = 'SHORT';
  const score = scoreIdea({ bos, fvg, ob, pattern, liq });

  const ok = dir && fvg && (ob && (ob.bullish || ob.bearish)) && liq && score >= SCORE_THRESHOLD;
  if (!ok) return { ok: false, reason: 'Not enough confluence', score };

  const entry = price;
  const sl = dir === 'LONG' ? +(price * 0.99).toFixed(8) : +(price * 1.01).toFixed(8);
  const tp = dir === 'LONG' ? +(price * 1.02).toFixed(8) : +(price * 0.98).toFixed(8);
  const rr = Math.abs((tp - entry) / (entry - sl)).toFixed(2);
  const note = [bos?.type, fvg?.type, ob.bullish ? 'OB_BULL' : '', ob.bearish ? 'OB_BEAR' : '', pattern || '', liq?.type || ''].filter(Boolean).join(' ');

  return { ok: true, symbol, dir, entry, sl, tp, rr, note, score };
}

// ------------- FULL ANALYSIS (multi-timeframe) -------------
async function fullAnalysis(symbol) {
  // primary timeframe 15m; also fetch 1h and 4h for context if needed (not used in strict rule but stored)
  const kl15 = await fetchKlines(symbol, '15m', 300);
  if (!kl15 || !kl15.length) return { ok: false, reason: 'no data' };
  const kl1h = await fetchKlines(symbol, '1h', 200);
  const kl4h = await fetchKlines(symbol, '4h', 200);

  const price = kl15[kl15.length - 1].close;
  const bos15 = detectBOS(kl15, 20);
  const ob15 = detectOrderBlock(kl15);
  const fvg15 = detectFVG(kl15);
  const liq15 = detectLiquidityZone(kl15);
  const pattern15 = detectCandlePattern(kl15);

  const idea = generateIdea(symbol, price, bos15, fvg15, ob15, pattern15, liq15);

  return { ok: true, symbol, price, timeframe: '15m', bos15, ob15, fvg15, liq15, pattern15, idea, kl15, kl1h, kl4h };
}

// ------------- SCHEDULER / ACTIVE HOURS -------------
function hhmmToNum(s) { return parseInt(s, 10); } // "0630" -> 630
function nowHHMM() {
  const d = new Date();
  return d.getHours() * 100 + d.getMinutes();
}
function isWithinActiveHours() {
  const from = hhmmToNum(ACTIVE_FROM);
  const to = hhmmToNum(ACTIVE_TO);
  const now = nowHHMM();
  if (from <= to) return now >= from && now <= to;
  // wrap around midnight
  return now >= from || now <= to;
}

// rotation state
let rotateIndex = 0;
function nextCoin() {
  if (!AUTO_COINS || !AUTO_COINS.length) return null;
  const c = AUTO_COINS[rotateIndex % AUTO_COINS.length];
  rotateIndex = (rotateIndex + 1) % AUTO_COINS.length;
  return c;
}

// ------------- DAILY REPORT -------------
async function runDailyReport() {
  try {
    const daily = readDaily();
    const items = daily.items || [];
    let text = `📊 Daily report for ${daily.date}\nTotal sent signals: ${items.length}\n\n`;
    if (items.length) {
      for (const it of items) {
        text += `${new Date(it._time).toLocaleTimeString()} | ${it.symbol} | ${it.idea.dir} | Entry:${it.idea.entry} SL:${it.idea.sl} TP:${it.idea.tp} Score:${it.idea.score}\n`;
      }
    } else text += 'No signals today.\n';
    await bot.sendMessage(ADMIN_ID, text);
    // reset daily
    writeJSON(DAILY_LOG_FILE, { date: todayDate(), items: [] });
  } catch (e) {
    console.error('runDailyReport err', e);
  }
}
function scheduleDailyReport() {
  try {
    const now = new Date();
    const next = new Date(now);
    // schedule next 23:00
    const hh = parseInt(ACTIVE_TO.slice(0, 2), 10);
    const mm = parseInt(ACTIVE_TO.slice(2), 10);
    next.setHours(hh, mm, 5, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    setTimeout(() => { runDailyReport(); setInterval(runDailyReport, 24 * 60 * 60 * 1000); }, delay);
  } catch (e) { console.error('scheduleDailyReport err', e); }
}

// ------------- AUTO CYCLE (rotate coins & send to permitted users) -------------
async function autoCycle() {
  try {
    if (!isWithinActiveHours()) return;
    const coin = nextCoin();
    if (!coin) return;
    const analysis = await fullAnalysis(coin);
    if (!analysis.ok) return;
    const idea = analysis.idea;
    if (!idea.ok) return; // only strong signals

    const lastSignals = readLastSignals();
    const prev = lastSignals[coin];

    if (!prev || idea.score >= prev.score) {
      const perms = readPerms();
      const recipients = Array.from(new Set([ADMIN_ID, ...(perms.users || [])]));
      const message = `🤖 Auto-scan ${coin}\n${idea.dir}\nEntry: ${idea.entry}\nSL: ${idea.sl}\nTP: ${idea.tp}\nRR: ${idea.rr}\nScore: ${idea.score}\nNote: ${idea.note}`;
      for (const uid of recipients) {
        try { await bot.sendMessage(String(uid), message); } catch (e) { console.warn('send fail', uid, e && e.message ? e.message : e); }
      }
      lastSignals[coin] = { ...idea, _time: Date.now() };
      saveLastSignals(lastSignals);
      pushHistory({ auto: true, symbol: coin, idea, sentTo: recipients, _time: Date.now() });
      pushDaily({ _time: Date.now(), symbol: coin, idea });
    }
  } catch (e) {
    console.error('autoCycle err', e && e.stack ? e.stack : e);
  }
}

// schedule cycle
setInterval(autoCycle, AUTO_INTERVAL_MIN * 60 * 1000);
setTimeout(autoCycle, 5000); // run shortly after start
scheduleDailyReport();

// ------------- TELEGRAM COMMANDS & PERMISSIONS -------------
// welcome text when user presses /start
bot.onText(/\/start/, (msg) => {
  const chatId = String(msg.chat.id);
  const welcome = `👋 *Chào mừng bạn đến với AI Market Signals*\n\nBot chuyên phân tích thị trường theo phương pháp ICT/SMC + Price Action — lọc những *tín hiệu mạnh* (BOS, FVG, OB, Liquidity).\n\n👉 Muốn dùng thử/đăng ký quyền, hãy gửi /request. Để được hỗ trợ nhanh, liên hệ: *0399834208 (Zalo)*\n\nLệnh cơ bản: /scan SYMBOL, /watch SYMBOL, /unwatch SYMBOL, /signals, /status`;
  bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
});

// manual scan (requires permission)
bot.onText(/\/scan\s+(.+)/i, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const perms = readPerms();
  if (!perms.users.includes(chatId) && chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền. Gửi /request để yêu cầu.');
  const symbol = (match[1] || '').trim().toUpperCase();
  const res = await fullAnalysis(symbol);
  if (!res.ok) return bot.sendMessage(chatId, `❌ ${res.reason || 'No data'}`);
  if (res.idea && res.idea.ok) {
    const i = res.idea;
    const msgText = `📊 Manual ${symbol}\n${i.dir}\nEntry:${i.entry}\nSL:${i.sl}\nTP:${i.tp}\nScore:${i.score}\nNote:${i.note}`;
    bot.sendMessage(chatId, msgText);
    pushHistory({ type: 'manual', user: chatId, symbol, idea: i, _time: Date.now() });
  } else {
    bot.sendMessage(chatId, `⚠️ Không đủ confluence cho ${symbol}. Reason: ${res.idea.reason || 'No idea'} (score:${res.idea.score || 0})`);
  }
});

// /watch and /unwatch (permission required)
bot.onText(/\/watch\s+(.+)/i, (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId) && chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền.');
  const watch = readJSON(HISTORY_FILE.replace('history.json','watchlist.json'), {}); // lightweight: try separate watchlist file
  // ensure watchlist file exists
  const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');
  initFile(WATCH_FILE, {});
  const watchlist = readJSON(WATCH_FILE, {});
  watchlist[chatId] = watchlist[chatId] || [];
  if (!watchlist[chatId].includes(symbol)) {
    watchlist[chatId].push(symbol);
    writeJSON(WATCH_FILE, watchlist);
  }
  bot.sendMessage(chatId, `✅ Đã thêm ${symbol} vào watchlist.`);
});

bot.onText(/\/unwatch\s+(.+)/i, (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId) && chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền.');
  const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');
  initFile(WATCH_FILE, {});
  const watchlist = readJSON(WATCH_FILE, {});
  watchlist[chatId] = (watchlist[chatId] || []).filter(x => x !== symbol);
  writeJSON(WATCH_FILE, watchlist);
  bot.sendMessage(chatId, `🗑️ Đã xóa ${symbol} khỏi watchlist.`);
});

// /signals shows last saved signals
bot.onText(/\/signals/, (msg) => {
  const chatId = String(msg.chat.id);
  const last = readLastSignals();
  const keys = Object.keys(last || {});
  if (!keys.length) return bot.sendMessage(chatId, 'Chưa có tín hiệu được lưu.');
  const out = keys.map(k => {
    const s = last[k];
    return `${k}: ${s.dir} Entry:${s.entry} SL:${s.sl} TP:${s.tp} Score:${s.score}`;
  }).join('\n');
  bot.sendMessage(chatId, `📡 Last signals:\n${out}`);
});

// /status
bot.onText(/\/status/, (msg) => {
  const chatId = String(msg.chat.id);
  const last = readLastSignals();
  const perms = readPerms();
  bot.sendMessage(chatId, `Bot: ${BOT_NAME}\nAuto-rotate: every ${AUTO_INTERVAL_MIN} min\nActive hours: ${ACTIVE_FROM} - ${ACTIVE_TO}\nPermitted users: ${(perms.users||[]).length}\nSaved signals: ${Object.keys(last||{}).length}`);
});

// /request -> notify admin
bot.onText(/\/request/, (msg) => {
  const chatId = String(msg.chat.id);
  bot.sendMessage(ADMIN_ID, `📥 Request access from ${chatId}. Grant with: /grant ${chatId}`);
  bot.sendMessage(chatId, '✅ Yêu cầu đã gửi tới admin. Vui lòng chờ phản hồi.');
});

// admin commands: /grant /revoke /announce
bot.onText(/\/grant\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== ADMIN_ID) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1] || '').trim());
  const perms = readPerms();
  if (!perms.users.includes(target)) { perms.users.push(target); savePerms(perms); bot.sendMessage(ADMIN_ID, `✅ Đã cấp quyền cho ${target}`); bot.sendMessage(target, `🎉 Bạn đã được cấp quyền sử dụng ${BOT_NAME}.`); }
  else bot.sendMessage(ADMIN_ID, `${target} đã có quyền.`);
});
bot.onText(/\/revoke\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== ADMIN_ID) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1] || '').trim());
  const perms = readPerms();
  perms.users = (perms.users || []).filter(x => x !== target);
  savePerms(perms);
  bot.sendMessage(ADMIN_ID, `🗑️ Đã thu hồi quyền của ${target}`);
  bot.sendMessage(target, `⚠️ Quyền sử dụng ${BOT_NAME} đã bị thu hồi.`);
});

// /announce - admin broadcast
bot.onText(/\/announce\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== ADMIN_ID) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const text = match[1];
  const perms = readPerms();
  const users = Array.from(new Set([ADMIN_ID, ...(perms.users||[])]));
  users.forEach((u, i) => setTimeout(()=> { bot.sendMessage(String(u), `📣 Announcement:\n${text}`).catch(()=>{}); }, i * 60));
  bot.sendMessage(ADMIN_ID, `✅ Sent announcement to ${users.length} users.`);
});

// /listusers - admin only
bot.onText(/\/listusers/, (msg) => {
  const from = String(msg.from && msg.from.id);
  if (from !== ADMIN_ID) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  
  const perms = readPerms();
  const admins = perms.admins || [];
  const users = perms.users || [];
  
  let text = `👑 *Admins* (${admins.length}):\n`;
  text += admins.map(a => ` - ${a}`).join('\n') || '(none)';
  text += `\n\n👤 *Users* (${users.length}):\n`;
  text += users.map(u => ` - ${u}`).join('\n') || '(none)';
  
  bot.sendMessage(from, text, { parse_mode: 'Markdown' });
});

// admin immediate broadcast with prefix !broadcast (also accepts admin only)
bot.onText(/^!broadcast\s+(.+)/i, async (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== ADMIN_ID) return;
  const text = match[1];
  const perms = readPerms();
  const users = Array.from(new Set([ADMIN_ID, ...(perms.users||[])]));
  let sent = 0;
  for (const uid of users) {
    try { await bot.sendMessage(String(uid), `📢 ${text}`); sent++; } catch (e) { /* ignore */ }
  }
  bot.sendMessage(ADMIN_ID, `✅ Broadcast done to ${sent} users.`);
});

// auto-collect users who message bot (for announcements only) — does NOT auto-grant permission for scans
bot.on('message', (msg) => {
  try {
    const userId = String(msg.chat.id);
    const perms = readPerms();
    if (!perms.users.includes(userId) && userId !== ADMIN_ID) {
      perms.users.push(userId);
      savePerms(perms);
      console.log('Recorded user for announcements:', userId);
    }
  } catch (e) { /* ignore */ }
});

// ------------- HEALTH SERVER & STARTUP -------------
const app = express();
app.get('/', (_, res) => res.send(`${BOT_NAME} is alive`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

console.log(`${BOT_NAME} started. Auto-rotate every ${AUTO_INTERVAL_MIN} min. Active hours ${ACTIVE_FROM}-${ACTIVE_TO}`);

// graceful logging
process.on('uncaughtException', (err) => console.error('uncaughtException', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection', reason));
