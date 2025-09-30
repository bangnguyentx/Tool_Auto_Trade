/**
 * bot.js — Tool_Auto_Trade (CLEAN FINAL)
 *
 * ✅ Auto-scan mỗi X phút
 * ✅ Phân tích ICT primitives: BOS, FVG, OB, Liquidity, Candle patterns
 * ✅ Gửi tín hiệu Telegram nếu có setup tốt
 * ✅ Watchlist, phân quyền, announce, lịch sử
 * ✅ Health server cho Render
 *
 * REQUIREMENTS:
 *   npm install node-telegram-bot-api axios express
 *
 * ENV:
 *   TELEGRAM_TOKEN=xxxx
 *   ADMIN_ID=xxxx
 *   AUTO_INTERVAL_MIN=10
 *   AUTO_COINS=BTCUSDT,ETHUSDT,...
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ---------------- CONFIG ----------------
const TOKEN = process.env.TELEGRAM_TOKEN || '';
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const AUTO_INTERVAL_MIN = Number(process.env.AUTO_INTERVAL_MIN || 10);
const AUTO_COINS = (process.env.AUTO_COINS || 'BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,BNBUSDT')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const BOT_NAME = 'Tool_Auto_Trade';

if (!TOKEN || !ADMIN_ID) {
  console.error('❌ Missing TELEGRAM_TOKEN or ADMIN_ID. Set them before start.');
  process.exit(1);
}

// ---------------- FILES ----------------
const DATA_DIR = path.join(__dirname, '.data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');
const PERMS_FILE = path.join(DATA_DIR, 'permissions.json');
const LAST_SIGNALS_FILE = path.join(DATA_DIR, 'last_signals.json');

function initFile(file, def) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(def));
}
initFile(HISTORY_FILE, []);
initFile(WATCH_FILE, {});
initFile(PERMS_FILE, { admins: [ADMIN_ID], users: [] });
initFile(LAST_SIGNALS_FILE, {});

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return def }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// ---------------- TELEGRAM BOT ----------------
const bot = new TelegramBot(TOKEN, { polling: true });

// ---------------- BINANCE FETCH ----------------
async function fetchKlines(symbol, interval = '15m', limit = 300) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data.map(c => ({
      t: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5])
    }));
  } catch (e) {
    console.warn('fetchKlines error', symbol, e.message);
    return [];
  }
}

// ---------------- ANALYSIS FUNCTIONS ----------------
function detectBOS(candles, lookback = 20) {
  if (candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  const last = slice.at(-1);
  const highs = slice.slice(0, -1).map(c => c.high);
  const lows = slice.slice(0, -1).map(c => c.low);
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  if (last.close > recentHigh) return { type: 'BOS_UP', price: last.close };
  if (last.close < recentLow) return { type: 'BOS_DOWN', price: last.close };
  return null;
}

function detectOrderBlock(candles) {
  const blocks = { bullish: null, bearish: null };
  if (candles.length < 6) return blocks;
  const last5 = candles.slice(-6, -1);
  for (const c of last5) {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 1;
    if (body > range * 0.6) {
      if (c.close > c.open) blocks.bullish = c;
      else blocks.bearish = c;
    }
  }
  return blocks;
}

function detectFVG(candles) {
  for (let i = candles.length - 3; i >= 2; i--) {
    const c = candles[i], c2 = candles[i - 2];
    if (c.low > c2.high) return { type: 'FVG_UP', low: c2.high, high: c.low };
    if (c.high < c2.low) return { type: 'FVG_DOWN', low: c.high, high: c2.low };
  }
  return null;
}

function detectLiquidity(candles) {
  const recent = candles.slice(-30);
  const vols = recent.map(c => c.vol);
  const avg = vols.reduce((s, v) => s + v, 0) / vols.length;
  const last = recent.at(-1);
  if (last.vol > avg * 1.8) return { type: 'LIQUIDITY_ZONE', vol: last.vol };
  return null;
}

function detectCandlePattern(candles) {
  if (candles.length < 2) return null;
  const last = candles.at(-1), prev = candles.at(-2);
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low || 1;
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  if (body < range * 0.3 && upper > lower * 2) return 'ShootingStar';
  if (body < range * 0.3 && lower > upper * 2) return 'Hammer';
  if (last.close > prev.open && last.open < prev.close && last.close > last.open) return 'BullishEngulfing';
  if (last.close < prev.open && last.open > prev.close && last.close < last.open) return 'BearishEngulfing';
  return null;
}

function scoreIdea({ bos, fvg, ob, liq, pattern }) {
  let score = 0;
  if (bos) score += 3;
  if (fvg) score += 3;
  if (ob?.bullish || ob?.bearish) score += 2;
  if (liq) score += 1;
  if (pattern) score += 1;
  return score;
}

function generateIdea(symbol, price, bos, fvg, ob, liq, pattern) {
  let dir = bos?.type === 'BOS_UP' ? 'LONG' : bos?.type === 'BOS_DOWN' ? 'SHORT' : null;
  const score = scoreIdea({ bos, fvg, ob, liq, pattern });
  if (!dir || !fvg || !(ob?.bullish || ob?.bearish) || !liq || score < 6)
    return { ok: false, reason: 'Not enough confluence', score };

  const entry = price;
  const sl = dir === 'LONG' ? +(price * 0.99).toFixed(6) : +(price * 1.01).toFixed(6);
  const tp = dir === 'LONG' ? +(price * 1.02).toFixed(6) : +(price * 0.98).toFixed(6);
  const rr = Math.abs((tp - entry) / (entry - sl)).toFixed(2);
  const note = [bos?.type, fvg?.type, ob.bullish ? 'OB_BULL' : '', ob.bearish ? 'OB_BEAR' : '', pattern, liq?.type]
    .filter(Boolean).join(' ');

  return { ok: true, symbol, dir, entry, sl, tp, rr, note, score };
}

// ---------------- FULL ANALYSIS ----------------
async function fullAnalysis(symbol) {
  const kl15 = await fetchKlines(symbol, '15m', 300);
  if (!kl15.length) return { ok: false, reason: 'no data' };

  const price = kl15.at(-1).close;
  const bos = detectBOS(kl15);
  const ob = detectOrderBlock(kl15);
  const fvg = detectFVG(kl15);
  const liq = detectLiquidity(kl15);
  const pattern = detectCandlePattern(kl15);
  const idea = generateIdea(symbol, price, bos, fvg, ob, liq, pattern);

  return { ok: true, symbol, idea };
}

// ---------------- AUTO SCAN ----------------
function pushHistoryRecord(rec) {
  const arr = readJSON(HISTORY_FILE, []);
  arr.unshift({ ...rec, _time: Date.now() });
  if (arr.length > 2000) arr.splice(2000);
  writeJSON(HISTORY_FILE, arr);
}

async function autoScanAll() {
  try {
    const lastSignals = readJSON(LAST_SIGNALS_FILE, {});
    for (const s of AUTO_COINS) {
      const r = await fullAnalysis(s);
      if (!r.ok) continue;
      const newIdea = r.idea;
      const prev = lastSignals[s];

      if (!newIdea.ok) continue;
      if (!prev || newIdea.score >= prev.score) {
        await bot.sendMessage(ADMIN_ID, `🤖 Auto ${s}\n${newIdea.dir}\nEntry:${newIdea.entry}\nSL:${newIdea.sl}\nTP:${newIdea.tp}\nRR:${newIdea.rr}\nScore:${newIdea.score}\nNote:${newIdea.note}`);
        pushHistoryRecord({ auto: true, symbol: s, idea: newIdea });
        lastSignals[s] = { ...newIdea, _time: Date.now() };
        writeJSON(LAST_SIGNALS_FILE, lastSignals);
      }
    }
  } catch (err) {
    console.error('autoScanAll error', err);
  }
}

// ---------------- TELEGRAM COMMANDS ----------------
bot.onText(/\/start/, (msg) => {
  const chatId = String(msg.chat.id);
  const help = `🤖 *${BOT_NAME}* ready.\nCommands:\n/scan SYMBOL\n/watch SYMBOL\n/unwatch SYMBOL\n/signals\n/stats\n/request\n/status`;
  bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
});

bot.onText(/\/scan (.+)/i, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const r = await fullAnalysis(symbol);
  if (!r.ok) return bot.sendMessage(chatId, `❌ ${r.reason}`);
  if (r.idea.ok) {
    const i = r.idea;
    bot.sendMessage(chatId, `📊 ${symbol}\n${i.dir}\nEntry:${i.entry}\nSL:${i.sl}\nTP:${i.tp}\nScore:${i.score}\nNote:${i.note}`);
    pushHistoryRecord({ type: 'manual', symbol, idea: i, user: chatId });
  } else bot.sendMessage(chatId, `⚠️ ${r.idea.reason}`);
});

// ---------------- BROADCAST MESSAGES ----------------

// Tự động lưu người dùng mới khi họ nhắn với bot
bot.on('message', (msg) => {
  const userId = String(msg.chat.id);
  const perms = readJSON(PERMS_FILE, { admins: [ADMIN_ID], users: [] });

  if (!perms.users.includes(userId) && userId !== ADMIN_ID) {
    perms.users.push(userId);
    writeJSON(PERMS_FILE, perms);
    console.log(`👤 New user added: ${userId}`);
  }
});

// Khi admin gửi tin nhắn bắt đầu bằng !broadcast thì gửi cho toàn bộ users
bot.onText(/^!broadcast (.+)/i, async (msg, match) => {
  const chatId = String(msg.chat.id);
  if (chatId !== ADMIN_ID) return;

  const text = match[1];
  const perms = readJSON(PERMS_FILE, { admins: [ADMIN_ID], users: [] });
  const allUsers = [ADMIN_ID, ...perms.users];

  let sent = 0;
  for (const uid of allUsers) {
    try {
      await bot.sendMessage(uid, `📢 ${text}`);
      sent++;
    } catch (e) {
      console.warn(`❌ Failed to send to ${uid}`, e.message);
    }
  }
  bot.sendMessage(chatId, `✅ Đã gửi broadcast cho ${sent} người.`);
});

// ---------------- AUTO BROADCAST MESSAGES ----------------

// Tự động lưu user khi họ nhắn gì đó
bot.on('message', async (msg) => {
  const senderId = String(msg.chat.id);
  const text = msg.text || '';
  if (!text || text.startsWith('!broadcast')) return; // tránh loop broadcast admin

  const perms = readJSON(PERMS_FILE, { admins: [ADMIN_ID], users: [] });

  // Thêm user mới nếu chưa có
  if (!perms.users.includes(senderId) && senderId !== ADMIN_ID) {
    perms.users.push(senderId);
    writeJSON(PERMS_FILE, perms);
    console.log(`👤 New user auto-added: ${senderId}`);
  }

  const allRecipients = [ADMIN_ID, ...perms.users].filter(id => id !== senderId);

  // Forward tin nhắn đến tất cả người khác
    for (const uid of allRecipients) {
    try {
      await bot.sendMessage(uid, `💬 Từ ${senderId}: ${text}`);
    } catch (e) {
      console.warn(`❌ Không gửi được tới ${uid}:`, e.message);
    }
  }
});

// ---------------- SERVER & START ----------------
console.log(`${BOT_NAME} running...`);
const app = express();
app.get('/', (_, res) => res.send(`${BOT_NAME} is alive`));
app.listen(process.env.PORT || 3000);

setTimeout(() => {
  autoScanAll();
  setInterval(autoScanAll, AUTO_INTERVAL_MIN * 60000);
}, 3000);function readPerms() { return readJSON(PERMS_FILE, { admins: [ADMIN_ID], users: [] }); }
function savePerms(obj) { writeJSON(PERMS_FILE, obj); }
function readLastSignals() { return readJSON(LAST_SIGNALS_FILE, {}); }
function saveLastSignals(obj) { writeJSON(LAST_SIGNALS_FILE, obj); }

// ---------------- TELEGRAM BOT ----------------
const bot = new TelegramBot(TOKEN, { polling: true });

// ---------------- BINANCE FETCH ----------------
async function fetchKlines(symbol, interval = '15m', limit = 300) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data.map(c => ({
      t: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5])
    }));
  } catch (e) {
    console.warn('fetchKlines error', symbol, e && e.message ? e.message : e);
    return [];
  }
}

// ---------------- DETECTORS ----------------
function detectBOS(candles, lookback = 20) {
  if (!candles || candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  const last = slice[slice.length - 1];
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);
  const recentHigh = Math.max(...highs.slice(0, -1));
  const recentLow = Math.min(...lows.slice(0, -1));
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
    const range = c.high - c.low || 1;
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
    const c = candles[i], c2 = candles[i - 2];
    if (!c || !c2) continue;
    if (c.low > c2.high) return { type: 'FVG_UP', idx: i, low: c2.high, high: c.low };
    if (c.high < c2.low) return { type: 'FVG_DOWN', idx: i, low: c.high, high: c2.low };
  }
  return null;
}

function detectSweep(candles) {
  if (!candles || candles.length < 3) return null;
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  if (last.high > prev.high && last.close < prev.close) return 'LIQUIDITY_SWEEP_TOP';
  if (last.low < prev.low && last.close > prev.close) return 'LIQUIDITY_SWEEP_BOTTOM';
  return null;
}

function detectCandlePattern(candles) {
  const n = candles ? candles.length : 0;
  if (n < 2) return null;
  const last = candles[n - 1], prev = candles[n - 2];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low || 1;
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  if (body < range * 0.3 && upper > lower * 2) return 'ShootingStar';
  if (body < range * 0.3 && lower > upper * 2) return 'Hammer';
  if (last.close > prev.open && last.open < prev.close && last.close > last.open) return 'BullishEngulfing';
  if (last.close < prev.open && last.open > prev.close && last.close < last.open) return 'BearishEngulfing';
  return null;
}

function detectLiquidityZone(candles) {
  if (!candles || candles.length < 10) return null;
  const recent = candles.slice(-30);
  const vols = recent.map(c => c.vol || 0);
  const avg = vols.reduce((s, v) => s + v, 0) / Math.max(1, vols.length);
  const last = recent[recent.length - 1];
  if (last && last.vol > avg * 1.8) return { type: 'LIQUIDITY_ZONE', vol: last.vol, avgVol: avg };
  return null;
}

// ---------------- IDEA ENGINE ----------------
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

  // strict conditions for strong signal
  const ok = dir && fvg && (ob && (ob.bullish || ob.bearish)) && liq && score >= 6;
  if (!ok) return { ok: false, reason: 'Not enough confluence', score };

  const entry = price;
  const sl = dir === 'LONG' ? +(price * 0.99).toFixed(6) : +(price * 1.01).toFixed(6);
  const tp = dir === 'LONG' ? +(price * 1.02).toFixed(6) : +(price * 0.98).toFixed(6);
  const rr = Math.abs((tp - entry) / (entry - sl)).toFixed(2);
  const note = `${bos ? bos.type : ''} ${fvg ? fvg.type : ''} ${ob.bullish ? 'OB_BULL' : ''} ${ob.bearish ? 'OB_BEAR' : ''} ${pattern || ''} ${liq ? liq.type : ''}`.trim();

  return { ok: true, symbol, dir, entry, sl, tp, rr, note, score };
}

// ---------------- FULL ANALYSIS ----------------
async function fullAnalysis(symbol) {
  const kl15 = await fetchKlines(symbol, '15m', 300);
  if (!kl15 || !kl15.length) return { ok: false, reason: 'no data' };

  const kl1h = await fetchKlines(symbol, '1h', 200);
  const kl4h = await fetchKlines(symbol, '4h', 200);
  const price = kl15[kl15.length - 1].close;

  const bos15 = detectBOS(kl15, 20);
  const ob15 = detectOrderBlock(kl15);
  const fvg15 = detectFVG(kl15);
  const sweep15 = detectSweep(kl15);
  const pattern15 = detectCandlePattern(kl15);
  const liq15 = detectLiquidityZone(kl15);

  const bos1h = (kl1h && kl1h.length) ? detectBOS(kl1h, 20) : null;
  const bos4h = (kl4h && kl4h.length) ? detectBOS(kl4h, 12) : null;

  const idea = generateIdea(symbol, price, bos15, fvg15, ob15, pattern15, liq15);

  return { ok: true, symbol, price, bos15, bos1h, bos4h, ob15, fvg15, sweep15, pattern15, liq15, idea };
}

// ---------------- HISTORY ----------------
function pushHistoryRecord(rec) {
  const arr = readHistory();
  rec._time = Date.now();
  arr.unshift(rec);
  if (arr.length > 2000) arr.splice(2000);
  saveHistory(arr);
}

// ---------------- AUTO SCAN ----------------
async function autoScanAll() {
  try {
    const lastSignals = readLastSignals();

    for (const s of AUTO_COINS) {
      const r = await fullAnalysis(s);
      if (!r.ok) continue;
      const newIdea = r.idea;
      const prev = lastSignals[s];

      // if new idea weak but prev stronger and older than 5 min -> resend prev
      if (!newIdea.ok) {
        if (prev && prev.score > (newIdea.score || 0) && (Date.now() - (prev._time || 0) > 5 * 60000)) {
          // resend previous strong sig
          try {
            await bot.sendMessage(ADMIN_ID, `🔁 Resending previous stronger signal for ${s}:\n${prev.dir} Entry:${prev.entry} SL:${prev.sl} TP:${prev.tp}\nScore:${prev.score}\nNote:${prev.note}`);
            prev._time = Date.now();
            lastSignals[s] = prev;
            saveLastSignals(lastSignals);
          } catch (err) {
            console.error('Error resending previous signal', err);
          }
        }
        continue;
      }

      // newIdea.ok === true -> send if stronger or no prev
      if (!prev || newIdea.score >= prev.score) {
        try {
          await bot.sendMessage(ADMIN_ID, `🤖 Auto-scan ${s}\n${newIdea.dir}\nEntry:${newIdea.entry}\nSL:${newIdea.sl}\nTP:${newIdea.tp}\nRR:${newIdea.rr}\nScore:${newIdea.score}\nNote:${newIdea.note}`);
        } catch (err) {
          console.error('Error sending auto signal', err);
        }
        pushHistoryRecord({ auto: true, symbol: s, analysis: r, idea: newIdea });
        lastSignals[s] = { ...newIdea, _time: Date.now() };
        saveLastSignals(lastSignals);
      } else {
        // optionally resend prev if still relevant and old
        if (prev && (Date.now() - (prev._time || 0) > 10 * 60000)) {
          try {
            await bot.sendMessage(ADMIN_ID, `🔁 Previous strong signal still relevant for ${s}:\n${prev.dir} Entry:${prev.entry} SL:${prev.sl} TP:${prev.tp}\nScore:${prev.score}`);
            prev._time = Date.now();
            lastSignals[s] = prev;
            saveLastSignals(lastSignals);
          } catch (err) {
            console.error('Error resending prev strong', err);
          }
        }
      }
    }

    // per-user watchlist notifications for users with permission
    const watch = readWatch();
    const perms = readPerms();
    for (const userId of (perms.users || [])) {
      const list = (watch[String(userId)] || []);
      for (const s of list) {
        const r = await fullAnalysis(s);
        if (r.idea && r.idea.ok) {
          const i = r.idea;
          try {
            await bot.sendMessage(String(userId), `🔔 Watchlist alert ${s}\n${i.dir} Entry:${i.entry} SL:${i.sl} TP:${i.tp}\nScore:${i.score}\nNote:${i.note}`);
            pushHistoryRecord({ auto: true, symbol: s, analysis: r, idea: i, sentTo: String(userId) });
          } catch (err) {
            console.error('Error sending watchlist alert to', userId, err);
          }
        }
      }
    }

  } catch (err) {
    console.error('autoScanAll error', err && err.stack ? err.stack : err);
  }
}

// ---------------- TELEGRAM COMMANDS ----------------
// /start help
bot.onText(/\/start/, (msg) => {
  const chatId = String(msg.chat.id);
  const help = `🤖 *${BOT_NAME}* ready.\nCommands:\n/scan SYMBOL - phân tích\n/watch SYMBOL - thêm watch\n/unwatch SYMBOL - xóa watch\n/signals - last signals\n/stats - thống kê\n/request - yêu cầu quyền\n/status - trạng thái\nAdmin only: /grant /revoke /announce\nAuto-scan every ${AUTO_INTERVAL_MIN} min for: ${AUTO_COINS.join(', ')}`;
  bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
});

// /scan
bot.onText(/\/scan (.+)/i, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId) && chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền. Gửi /request');
  const r = await fullAnalysis(symbol);
  if (!r.ok) return bot.sendMessage(chatId, `❌ ${r.reason || 'No data'}`);
  if (r.idea && r.idea.ok) {
    const i = r.idea;
    bot.sendMessage(chatId, `📊 ${symbol} -> ${i.dir}\nEntry:${i.entry}\nSL:${i.sl}\nTP:${i.tp}\nScore:${i.score}\nNote:${i.note}`);
    pushHistoryRecord({ type: 'manual_scan', symbol, analysis: r, idea: i, user: chatId });
  } else {
    bot.sendMessage(chatId, `⚠️ Không đủ confluence cho ${symbol}. Score:${r.idea ? r.idea.score : 0}`);
  }
});

// /watch and /unwatch
bot.onText(/\/watch\s+(.+)/i, (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId) && chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền.');
  const watch = readWatch();
  watch[chatId] = watch[chatId] || [];
  if (!watch[chatId].includes(symbol)) {
    watch[chatId].push(symbol);
    saveWatch(watch);
  }
  bot.sendMessage(chatId, `✅ Đã thêm ${symbol} vào watchlist.`);
});

bot.onText(/\/unwatch\s+(.+)/i, (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId) && chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền.');
  const watch = readWatch();
  watch[chatId] = (watch[chatId] || []).filter(x => x !== symbol);
  saveWatch(watch);
  bot.sendMessage(chatId, `🗑️ Đã xóa ${symbol} khỏi watchlist.`);
});

// /signals
bot.onText(/\/signals/, (msg) => {
  const chatId = String(msg.chat.id);
  const last = readLastSignals();
  const keys = Object.keys(last || {});
  if (!keys.length) return bot.sendMessage(chatId, 'Chưa có tín hiệu nào được lưu.');
  const out = keys.map(k => {
    const s = last[k];
    return `${k}: ${s.dir} Entry:${s.entry} SL:${s.sl} TP:${s.tp} Score:${s.score}`;
  }).join('\n');
  bot.sendMessage(chatId, `📡 Last signals:\n${out}`);
});

// /stats
bot.onText(/\/stats/, (msg) => {
  const chatId = String(msg.chat.id);
  const hist = readHistory();
  const total = hist.length;
  const ideas = hist.filter(h => h.idea && h.idea.ok);
  const ideaRate = total ? ((ideas.length / total) * 100).toFixed(2) : 0;
  bot.sendMessage(chatId, `📊 Stats:\nTotal records: ${total}\nIdea rate: ${ideaRate}%\nIdeas: ${ideas.length}`);
});

// /request -> notify admin
bot.onText(/\/request/, (msg) => {
  const chatId = String(msg.chat.id);
  bot.sendMessage(ADMIN_ID, `📥 Request access from ${chatId}. To grant run: /grant ${chatId}`);
  bot.sendMessage(chatId, '✅ Yêu cầu đã gửi đến admin.');
});

// admin commands
bot.onText(/\/grant\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1] || '').trim());
  const perms = readPerms();
  if (!perms.users.includes(target)) {
    perms.users.push(target);
    savePerms(perms);
    bot.sendMessage(ADMIN_ID, `✅ Đã cấp quyền cho ${target}`);
    bot.sendMessage(target, `🎉 Bạn đã được cấp quyền sử dụng ${BOT_NAME}.`);
  } else {
    bot.sendMessage(ADMIN_ID, `${target} đã có quyền rồi.`);
  }
});

bot.onText(/\/revoke\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1] || '').trim());
  const perms = readPerms();
  perms.users = (perms.users || []).filter(x => x !== target);
  savePerms(perms);
  bot.sendMessage(ADMIN_ID, `🗑️ Đã thu hồi quyền của ${target}`);
  bot.sendMessage(target, `⚠️ Quyền sử dụng ${BOT_NAME} đã bị thu hồi.`);
});

bot.onText(/\/announce\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const text = match[1].trim();
  const perms = readPerms();
  const users = perms.users || [];
  users.forEach((uid, i) => {
    setTimeout(() => {
      bot.sendMessage(uid, `📣 Announcement from admin:\n${text}`);
    }, i * 50);
  });
  bot.sendMessage(ADMIN_ID, `✅ Sent announcement to ${users.length} users.`);
});

bot.onText(/\/status/, (msg) => {
  const chatId = String(msg.chat.id);
  const last = readLastSignals();
  bot.sendMessage(chatId, `Bot: ${BOT_NAME}\nAuto-scan: every ${AUTO_INTERVAL_MIN} minutes\nWatchlist users: ${Object.keys(readWatch()).length}\nPerms users: ${(readPerms().users || []).length}\nLast signals saved for: ${Object.keys(last).join(', ') || 'none'}`);
});

// ---------------- STARTUP & HEALTH ----------------
console.log(`${BOT_NAME} running... (polling)`);
const app = express();
app.get('/', (req, res) => res.send(`${BOT_NAME} is alive`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('HTTP server listening on', PORT));

// initial run + scheduler
setTimeout(() => {
  autoScanAll();
  setInterval(autoScanAll, AUTO_INTERVAL_MIN * 60000);
}, 3000);

// ---------------- graceful handlers ----------------
process.on('uncaughtException', (err) => console.error('uncaughtException', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection', reason));
// ---------------- DATA FILES & HELPERS ----------------
const DATA_DIR = path.join(__dirname, '.data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');
const PERMS_FILE = path.join(DATA_DIR, 'permissions.json');
const LAST_SIGNALS_FILE = path.join(DATA_DIR, 'last_signals.json');

if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
if (!fs.existsSync(WATCH_FILE)) fs.writeFileSync(WATCH_FILE, JSON.stringify({}));
if (!fs.existsSync(PERMS_FILE)) fs.writeFileSync(PERMS_FILE, JSON.stringify({ admins: [ADMIN_ID], users: [] }));
if (!fs.existsSync(LAST_SIGNALS_FILE)) fs.writeFileSync(LAST_SIGNALS_FILE, JSON.stringify({}));

function readJSON(filePath, def = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return def;
    return JSON.parse(raw);
  } catch {
    return def;
  }
}
function writeJSON(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// wrappers
function readHistory() { return readJSON(HISTORY_FILE, []); }
function saveHistory(arr) { writeJSON(HISTORY_FILE, arr); }
function readWatch() { return readJSON(WATCH_FILE, {}); }
function saveWatch(obj) { writeJSON(WATCH_FILE, obj); }
function readPerms() { return readJSON(PERMS_FILE, { admins: [ADMIN_ID], users: [] }); }
function savePerms(obj) { writeJSON(PERMS_FILE, obj); }
function readLastSignals() { return readJSON(LAST_SIGNALS_FILE, {}); }
function saveLastSignals(obj) { writeJSON(LAST_SIGNALS_FILE, obj); }

// ---------------- TELEGRAM BOT ----------------
const bot = new TelegramBot(TOKEN, { polling: true });

// ---------------- BINANCE FETCH ----------------
async function fetchKlines(symbol, interval = '15m', limit = 300) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data.map(c => ({
      t: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5])
    }));
  } catch (e) {
    console.warn('fetchKlines error', symbol, e.message);
    return [];
  }
}

// ---------------- DETECTORS ----------------
function detectBOS(candles, lookback = 20) {
  if (!candles || candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  const last = slice[slice.length - 1];
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);
  const recentHigh = Math.max(...highs.slice(0, -1));
  const recentLow = Math.min(...lows.slice(0, -1));
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
    const range = c.high - c.low || 1;
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
    const c = candles[i], c2 = candles[i - 2];
    if (c.low > c2.high) return { type: 'FVG_UP', idx: i, low: c2.high, high: c.low };
    if (c.high < c2.low) return { type: 'FVG_DOWN', idx: i, low: c.high, high: c2.low };
  }
  return null;
}

function detectSweep(candles) {
  if (!candles || candles.length < 3) return null;
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  if (last.high > prev.high && last.close < prev.close) return 'LIQUIDITY_SWEEP_TOP';
  if (last.low < prev.low && last.close > prev.close) return 'LIQUIDITY_SWEEP_BOTTOM';
  return null;
}

function detectCandlePattern(candles) {
  const n = candles.length;
  if (n < 2) return null;
  const last = candles[n - 1], prev = candles[n - 2];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low || 1;
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  if (body < range * 0.3 && upper > lower * 2) return 'ShootingStar';
  if (body < range * 0.3 && lower > upper * 2) return 'Hammer';
  if (last.close > prev.open && last.open < prev.close && last.close > last.open) return 'BullishEngulfing';
  if (last.close < prev.open && last.open > prev.close && last.close < last.open) return 'BearishEngulfing';
  return null;
}

function detectLiquidityZone(candles) {
  if (!candles || candles.length < 10) return null;
  const recent = candles.slice(-30);
  const vols = recent.map(c => c.vol || 0);
  const avg = vols.reduce((s, v) => s + v, 0) / Math.max(1, vols.length);
  const last = recent[recent.length - 1];
  if (last && last.vol > avg * 1.8) return { type: 'LIQUIDITY_ZONE', vol: last.vol, avgVol: avg };
  return null;
}

// ---------------- IDEA ENGINE ----------------
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
  if (bos?.type === 'BOS_UP') dir = 'LONG';
  if (bos?.type === 'BOS_DOWN') dir = 'SHORT';
  const score = scoreIdea({ bos, fvg, ob, pattern, liq });

  const ok = dir && fvg && (ob?.bullish || ob?.bearish) && liq && score >= 6;
  if (!ok) return { ok: false, reason: 'Not enough confluence', score };

  const entry = price;
  const sl = dir === 'LONG' ? +(price * 0.99).toFixed(6) : +(price * 1.01).toFixed(6);
  const tp = dir === 'LONG' ? +(price * 1.02).toFixed(6) : +(price * 0.98).toFixed(6);
  const rr = Math.abs((tp - entry) / (entry - sl)).toFixed(2);
  const note = `${bos?.type || ''} ${fvg?.type || ''} ${ob.bullish ? 'OB_BULL' : ''} ${ob.bearish ? 'OB_BEAR' : ''} ${pattern || ''} ${liq?.type || ''}`.trim();

  return { ok: true, symbol, dir, entry, sl, tp, rr, note, score };
}

// ---------------- FULL ANALYSIS ----------------
async function fullAnalysis(symbol) {
  const kl15 = await fetchKlines(symbol, '15m', 300);
  if (!kl15.length) return { ok: false, reason: 'no data' };

  const kl1h = await fetchKlines(symbol, '1h', 200);
  const kl4h = await fetchKlines(symbol, '4h', 200);
  const price = kl15[kl15.length - 1].close;

  const bos15 = detectBOS(kl15, 20);
  const ob15 = detectOrderBlock(kl15);
  const fvg15 = detectFVG(kl15);
  const sweep15 = detectSweep(kl15);
  const pattern15 = detectCandlePattern(kl15);
  const liq15 = detectLiquidityZone(kl15);

  const bos1h = kl1h.length ? detectBOS(kl1h, 20) : null;
  const bos4h = kl4h.length ? detectBOS(kl4h, 12) : null;

  const idea = generateIdea(symbol, price, bos15, fvg15, ob15, pattern15, liq15);

  return { ok: true, symbol, price, bos15, bos1h, bos4h, ob15, fvg15, sweep15, pattern15, liq15, idea };
}

// ---------------- HISTORY ----------------
function pushHistoryRecord(rec) {
  const arr = readHistory();
  rec._time = Date.now();
  arr.unshift(rec);
  if (arr.length > 2000) arr.splice(2000);
  saveHistory(arr);
}

// ---------------- AUTO SCAN ----------------
async function autoScanAll() {
  try {
    const lastSignals = readLastSignals();
    for (const s of AUTO_COINS) {
      const r = await fullAnalysis(s);
      if (!r.ok) continue;
      const newIdea = r.idea;
      const prev = lastSignals[s];

      if (!newIdea.ok) {
        if (prev && prev.score > (newIdea.score || 0) && Date.now() - (prev._time || 0) > 5 * 60000) {
          await bot.sendMessage(ADMIN_ID, `🔁 Resending previous stronger signal for ${s}\n${prev.dir} Entry:${prev.entry} SL:${prev.sl} TP:${prev.tp}\nScore:${prev.score}`);
          prev._time = Date.now();
          lastSignals[s] = prev;
          saveLastSignals(lastSignals);
        }
        continue;
      }

      if (!prev || newIdea.score >= prev.score) {
        await bot.sendMessage(ADMIN_ID, `🤖 Auto-scan ${s}\n${newIdea.dir}\nEntry:${newIdea.entry}\nSL:${newIdea.sl}\nTP:${newIdea.tp}\nRR:${newIdea.rr}\nScore:${newIdea.score}\nNote:${newIdea.note}`);
        pushHistoryRecord({ auto: true, symbol: s, analysis: r, idea: newIdea });
        lastSignals[s] = { ...newIdea, _time: Date.now() };
        saveLastSignals(lastSignals);
      }
    }
  } catch (err) {
    console.error('autoScanAll error', err);
  }
}

// ---------------- TELEGRAM COMMANDS ----------------
bot.onText(/\/start/, msg => {
  const chatId = String(msg.chat.id);
  const help = `🤖 *${BOT_NAME}* ready.\nCommands:\n/scan SYMBOL\n/watch SYMBOL\n/unwatch SYMBOL\n/signals\n/stats\n/request\n/status\nAuto-scan every ${AUTO_INTERVAL_MIN} min`;
  bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
});

// scan
bot.onText(/\/scan (.+)/i, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId) && chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Chưa có quyền. Gửi /request');
  const r = await fullAnalysis(symbol);
  if (!r.ok) return bot.sendMessage(chatId, `❌ ${r.reason}`);
  if (r.idea.ok) {
    const i = r.idea;
    bot.sendMessage(chatId, `📊 ${symbol} -> ${i.dir}\nEntry:${i.entry}\nSL:${i.sl}\nTP:${i.tp}\nScore:${i.score}\nNote:${i.note}`);
    pushHistoryRecord({ type: 'manual_scan', symbol, analysis: r, idea: i, user: chatId });
  } else {
    bot.sendMessage(chatId, `⚠️ Không đủ confluence. Score:${r.idea.score}`);
  }
});

// ---------------- HEALTH & START ----------------
console.log(`${BOT_NAME} running...`);
const app = express();
app.get('/', (_, res) => res.send(`${BOT_NAME} is alive`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('HTTP server listening on', PORT));

setTimeout(() => {
  autoScanAll();
  setInterval(autoScanAll, AUTO_INTERVAL_MIN * 60000);
}, 3000);

process.on('uncaughtException', err => console.error('uncaughtException', err));
process.on('unhandledRejection', reason => console.error('unhandledRejection', reason));        if (prev && prev.score > (newIdea.score || 0) && ((Date.now() - (prev._time || 0)) > (5 * 60 * 1000))) {
          await bot.sendMessage(ADMIN_ID, `🔁 Resending previous stronger signal for ${s}:\n${prev.dir} Entry:${prev.entry} SL:${prev.sl} TP:${prev.tp}\nScore:${prev.score}\nNote:${prev.note}`);
          prev._time = Date.now();
          lastSignals[s] = prev;
          saveLastSignalsSafe(lastSignals);
        }
        continue;
      }

      // newIdea.ok === true
      if (!prev || newIdea.score >= prev.score) {
        const msg = `🤖 Auto-scan ${s}\n${newIdea.dir}\nEntry: ${newIdea.entry}\nSL: ${newIdea.sl}\nTP: ${newIdea.tp}\nRR: ${newIdea.rr}\nScore: ${newIdea.score}\nNote: ${newIdea.note}`;
        await bot.sendMessage(ADMIN_ID, msg);
        pushHistoryRecord({ auto: true, symbol: s, analysis: r, idea: newIdea });
        lastSignals[s] = Object.assign({}, newIdea, { _time: Date.now() });
        saveLastSignalsSafe(lastSignals);
      } else {
        // prev stronger: optionally resend if older than 10 min
        if (prev && ((Date.now() - (prev._time || 0)) > (10 * 60 * 1000))) {
          await bot.sendMessage(ADMIN_ID, `🔁 Previous strong signal still relevant for ${s}:\n${prev.dir} Entry:${prev.entry} SL:${prev.sl} TP:${prev.tp}\nScore:${prev.score}`);
          prev._time = Date.now();
          lastSignals[s] = prev;
          saveLastSignalsSafe(lastSignals);
        }
      }
    }

    // per-user watchlist notifications
    const watch = readWatch();
    const perms = readPerms();
    for (const userId of (perms.users || [])) {
      const list = (watch[String(userId)] || []);
      for (const s of list) {
        const r = await fullAnalysis(s);
        if (r.idea && r.idea.ok) {
          const i = r.idea;
          await bot.sendMessage(String(userId), `🔔 Watchlist alert ${s}\n${i.dir} Entry:${i.entry} SL:${i.sl} TP:${i.tp}\nScore:${i.score}\nNote:${i.note}`);
          pushHistoryRecord({ auto: true, symbol: s, analysis: r, idea: i, sentTo: String(userId) });
        }
      }
    }

  } catch (err) {
    console.error('autoScanAll error', err && err.stack ? err.stack : err);
  }
}

// ---------------- TELEGRAM COMMANDS ----------------
// Basic help/start
bot.onText(/\/start/, (msg) => {
  const chatId = String(msg.chat.id);
  const help = `🤖 *${BOT_NAME}* ready.\nCommands:\n/scan SYMBOL - phân tích ngay (vd: /scan BTCUSDT)\n/watch SYMBOL - thêm coin vào watchlist\n/unwatch SYMBOL - xoá coin khỏi watchlist\n/signals - xem last signals\n/stats - thống kê nhanh\n/request - yêu cầu quyền sử dụng\n/status - trạng thái bot\n\nAdmin-only:\n/grant CHATID - cấp quyền\n/revoke CHATID - thu hồi quyền\n/announce TEXT - gửi tới tất cả user được cấp\nAuto-scan every ${AUTO_INTERVAL_MIN} minutes for: ${AUTO_COINS.join(', ')}`;
  bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
});

// manual scan (requires permission)
bot.onText(/\/scan (.+)/i, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId) && chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền. Gửi /request để yêu cầu.');
  const r = await fullAnalysis(symbol);
  if (!r.ok) return bot.sendMessage(chatId, `❌ ${r.reason || 'No data'}`);
  if (r.idea && r.idea.ok) {
    const i = r.idea;
    bot.sendMessage(chatId, `📊 ${symbol} -> ${i.dir}\nEntry:${i.entry}\nSL:${i.sl}\nTP:${i.tp}\nScore:${i.score}\nNote:${i.note}`);
    pushHistoryRecord({ type: 'manual_scan', symbol, analysis: r, idea: i, user: chatId });
  } else {
    bot.sendMessage(chatId, `⚠️ Không đủ confluence cho ${symbol}. Reason: ${r.idea ? r.idea.reason : 'No idea'}. Score:${r.idea ? r.idea.score : 0}`);
  }
});

// watch/unwatch (for users with perms)
bot.onText(/\/watch\s+(.+)/i, (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId) && chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền.');
  const watch = readWatch();
  watch[chatId] = watch[chatId] || [];
  if (!watch[chatId].includes(symbol)) {
    watch[chatId].push(symbol);
    saveWatch(watch);
  }
  bot.sendMessage(chatId, `✅ Đã thêm ${symbol} vào watchlist.`);
});

bot.onText(/\/unwatch\s+(.+)/i, (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId) && chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền.');
  const watch = readWatch();
  watch[chatId] = (watch[chatId] || []).filter(x => x !== symbol);
  saveWatch(watch);
  bot.sendMessage(chatId, `🗑️ Đã xóa ${symbol} khỏi watchlist.`);
});

// /signals - show last signals saved
bot.onText(/\/signals/, (msg) => {
  const chatId = String(msg.chat.id);
  const last = readLastSignals();
  const keys = Object.keys(last);
  if (!keys.length) return bot.sendMessage(chatId, 'Chưa có tín hiệu nào được lưu.');
  const out = keys.map(k => {
    const s = last[k];
    return `${k}: ${s.dir} Entry:${s.entry} SL:${s.sl} TP:${s.tp} Score:${s.score}`;
  }).join('\n');
  bot.sendMessage(chatId, `📡 Last signals:\n${out}`);
});

// /stats - basic stats from history
bot.onText(/\/stats/, (msg) => {
  const chatId = String(msg.chat.id);
  const hist = readHistory();
  const total = hist.length;
  const ideas = hist.filter(h => h.idea && h.idea.ok);
  const ideaRate = total ? ((ideas.length / total) * 100).toFixed(2) : 0;
  bot.sendMessage(chatId, `📊 Stats:\nTotal records: ${total}\nIdea rate: ${ideaRate}%\nIdeas: ${ideas.length}`);
});

// /request - ask admin for permission
bot.onText(/\/request/, (msg) => {
  const chatId = String(msg.chat.id);
  bot.sendMessage(ADMIN_ID, `📥 Request access from ${chatId}. To grant run: /grant ${chatId}`);
  bot.sendMessage(chatId, '✅ Yêu cầu đã gửi đến admin.');
});

// admin: grant/revoke/announce
bot.onText(/\/grant\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1] || '').trim());
  const perms = readPerms();
  if (!perms.users.includes(target)) {
    perms.users.push(target);
    savePerms(perms);
    bot.sendMessage(ADMIN_ID, `✅ Đã cấp quyền cho ${target}`);
    bot.sendMessage(target, `🎉 Bạn đã được cấp quyền sử dụng ${BOT_NAME}.`);
  } else {
    bot.sendMessage(ADMIN_ID, `${target} đã có quyền rồi.`);
  }
});

bot.onText(/\/revoke\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1] || '').trim());
  const perms = readPerms();
  perms.users = (perms.users || []).filter(x => x !== target);
  savePerms(perms);
  bot.sendMessage(ADMIN_ID, `🗑️ Đã thu hồi quyền của ${target}`);
  bot.sendMessage(target, `⚠️ Quyền sử dụng ${BOT_NAME} đã bị thu hồi.`);
});

bot.onText(/\/announce\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const text = match[1].trim();
  const perms = readPerms();
  const users = perms.users || [];
  users.forEach((uid, i) => {
    setTimeout(() => {
      bot.sendMessage(uid, `📣 Announcement from admin:\n${text}`);
    }, i * 50);
  });
  bot.sendMessage(ADMIN_ID, `✅ Sent announcement to ${users.length} users.`);
});

bot.onText(/\/status/, (msg) => {
  const chatId = String(msg.chat.id);
  const last = readLastSignals();
  bot.sendMessage(chatId, `Bot: ${BOT_NAME}\nAuto-scan: every ${AUTO_INTERVAL_MIN} minutes\nWatchlist users: ${Object.keys(readWatch()).length}\nPerms users: ${(readPerms().users || []).length}\nLast signals saved for: ${Object.keys(last).join(', ') || 'none'}`);
});

// ---------------- STARTUP & HEALTH ----------------
console.log(`${BOT_NAME} running... (polling)`);
const app = express();
app.get('/', (req, res) => res.send(`${BOT_NAME} is alive`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('HTTP server listening on', PORT));

// initial scan and scheduler
setTimeout(() => {
  autoScanAll();
  setInterval(autoScanAll, AUTO_INTERVAL_MIN * 60 * 1000);
}, 3000);

// ---------------- graceful handlers ----------------
process.on('uncaughtException', (err) => console.error('uncaughtException', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection', reason));
// ----------------- DATA FILES -----------------
const DATA_DIR = path.join(__dirname, '.data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');
const PERMS_FILE = path.join(DATA_DIR, 'permissions.json');
const LAST_SIGNALS_FILE = path.join(DATA_DIR, 'last_signals.json');

// ensure files exist
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
if (!fs.existsSync(WATCH_FILE)) fs.writeFileSync(WATCH_FILE, JSON.stringify({}));
if (!fs.existsSync(PERMS_FILE)) fs.writeFileSync(PERMS_FILE, JSON.stringify({ admins: [ADMIN_ID], users: [] }));
if (!fs.existsSync(LAST_SIGNALS_FILE)) fs.writeFileSync(LAST_SIGNALS_FILE, JSON.stringify({}));

// ----------------- IO HELPERS -----------------
function readJSON(filePath, def = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return def;
    return JSON.parse(raw);
  } catch (e) {
    return def;
  }
}
function writeJSON(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// wrappers
function readHistory() { return readJSON(HISTORY_FILE, []); }
function saveHistory(arr) { writeJSON(HISTORY_FILE, arr); }
function readWatch() { return readJSON(WATCH_FILE, {}); }
function saveWatch(obj) { writeJSON(WATCH_FILE, obj); }
function readPerms() { return readJSON(PERMS_FILE, { admins: [ADMIN_ID], users: [] }); }
function savePerms(obj) { writeJSON(PERMS_FILE, obj); }
function readLastSignals() { return readJSON(LAST_SIGNALS_FILE, {}); }
function saveLastSignals(obj) { writeJSON(LAST_SIGNALS_FILE, obj); }

// ----------------- TELEGRAM BOT -----------------
const bot = new TelegramBot(TOKEN, { polling: true });

// ----------------- BINANCE FETCH -----------------
async function fetchKlines(symbol, interval = '15m', limit = 300) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data.map(c => ({
      t: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5])
    }));
  } catch (e) {
    console.warn('fetchKlines error', symbol, e && e.message ? e.message : e);
    return [];
  }
}

// ----------------- DETECTORS -----------------
function detectBOS(candles, lookback = 20) {
  if (!candles || candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  const last = slice[slice.length - 1];
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);
  const recentHigh = Math.max(...highs.slice(0, highs.length - 1));
  const recentLow = Math.min(...lows.slice(0, lows.length - 1));
  if (last.close > recentHigh) return { type: 'BOS_UP', price: last.close };
  if (last.close < recentLow) return { type: 'BOS_DOWN', price: last.close };
  return null;
}

function detectOrderBlock(candles) {
  if (!candles || candles.length < 6) return { bullish: null, bearish: null };
  const last5 = candles.slice(-6, -1);
  const blocks = { bullish: null, bearish: null };
  for (let i = 0; i < last5.length; i++) {
    const c = last5[i];
    const body = Math.abs(c.close - c.open);
    const range = (c.high - c.low) || 1;
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
    const c = candles[i], c2 = candles[i - 2];
    if (!c || !c2) continue;
    if (c.low > c2.high) return { type: 'FVG_UP', idx: i, low: c2.high, high: c.low };
    if (c.high < c2.low) return { type: 'FVG_DOWN', idx: i, low: c.high, high: c2.low };
  }
  return null;
}

function detectSweep(candles) {
  if (!candles || candles.length < 3) return null;
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  if (last.high > prev.high && last.close < prev.close) return 'LIQUIDITY_SWEEP_TOP';
  if (last.low < prev.low && last.close > prev.close) return 'LIQUIDITY_SWEEP_BOTTOM';
  return null;
}

function detectCandlePattern(candles) {
  const n = candles ? candles.length : 0;
  if (n < 2) return null;
  const last = candles[n - 1], prev = candles[n - 2];
  const body = Math.abs(last.close - last.open);
  const range = (last.high - last.low) || 1;
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  if (body < range * 0.3 && upper > lower * 2) return 'ShootingStar';
  if (body < range * 0.3 && lower > upper * 2) return 'Hammer';
  if (last.close > prev.open && last.open < prev.close && last.close > last.open) return 'BullishEngulfing';
  if (last.close < prev.open && last.open > prev.close && last.close < last.open) return 'BearishEngulfing';
  return null;
}

function detectLiquidityZone(candles) {
  if (!candles || candles.length < 10) return null;
  const recent = candles.slice(-30);
  const vols = recent.map(c => c.vol || 0);
  const avg = vols.reduce((s, v) => s + v, 0) / Math.max(1, vols.length);
  const last = recent[recent.length - 1];
  if (last && last.vol > avg * 1.8) return { type: 'LIQUIDITY_ZONE', vol: last.vol, avgVol: avg };
  return null;
}

// ----------------- IDEA ENGINE -----------------
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

  // Strict strong requirement: BOS + FVG + OB + liquidity + score >= 6
  const ok = (dir && fvg && (ob && (ob.bullish || ob.bearish)) && liq && score >= 6);
  if (!ok) return { ok: false, reason: 'Not enough confluence (need BOS+FVG+OB+LIQ)', score };

  const entry = price;
  const sl = dir === 'LONG' ? +(price * 0.99).toFixed(6) : +(price * 1.01).toFixed(6);
  const tp = dir === 'LONG' ? +(price * 1.02).toFixed(6) : +(price * 0.98).toFixed(6);
  const rr = Math.abs((tp - entry) / (entry - sl)).toFixed(2);
  const note = `${bos ? bos.type : ''} ${fvg ? fvg.type : ''} ${ob.bullish ? 'OB_BULL' : ''} ${ob.bearish ? 'OB_BEAR' : ''} ${pattern || ''} ${liq ? liq.type : ''}`.trim();

  return { ok: true, symbol, dir, entry, sl, tp, rr, note, score };
}

// ----------------- FULL ANALYSIS -----------------
async function fullAnalysis(symbol) {
  // fetch TFs
  const kl15 = await fetchKlines(symbol, '15m', 300);
  const kl1h = await fetchKlines(symbol, '1h', 200);
  const kl4h = await fetchKlines(symbol, '4h', 200);

  if (!kl15 || !kl15.length) return { ok: false, reason: 'no data' };

  const price = kl15[kl15.length - 1].close;
  const bos15 = detectBOS(kl15, 20);
  const ob15 = detectOrderBlock(kl15);
  const fvg15 = detectFVG(kl15);
  const sweep15 = detectSweep(kl15);
  const pattern15 = detectCandlePattern(kl15);
  const liq15 = detectLiquidityZone(kl15);

  const bos1h = kl1h && kl1h.length ? detectBOS(kl1h, 20) : null;
  const bos4h = kl4h && kl4h.length ? detectBOS(kl4h, 12) : null;

  const idea = generateIdea(symbol, price, bos15, fvg15, ob15, pattern15, liq15);

  return {
    ok: true,
    symbol,
    price,
    timeframe: '15m',
    bos15, bos1h, bos4h,
    ob15, fvg15, sweep15, pattern15, liq15,
    idea
  };
}

// ----------------- HISTORY -----------------
function pushHistoryRecord(rec) {
  const arr = readHistory();
  rec._time = Date.now();
  arr.unshift(rec);
  if (arr.length > 2000) arr.splice(2000);
  saveHistory(arr);
}

// ----------------- LAST SIGNALS (persistence) -----------------
function readLastSignalsSafe() { return readLastSignals(); }
function saveLastSignalsSafe(obj) { saveLastSignals(obj); }

// ----------------- AUTO-SCAN -----------------
async function autoScanAll() {
  try {
    const lastSignals = readLastSignalsSafe();
    for (const s of AUTO_COINS) {
      const r = await fullAnalysis(s);
      if (!r.ok) continue;
      const newIdea = r.idea;
      const prev = lastSignals[s];

      // if newIdea not ok but prev stronger and old enough => resend prev
      if (!newIdea.ok) {
        if (prev && prev.score > (newIdea.score || 0) && ((Date.now() - (prev._time || 0)) > (5 * 60 * 1000))) {
          await bot.sendMessage(ADMIN_ID, `🔁 Resending previous stronger signal for ${s}:\n${prev.dir} Entry:${prev.entry} SL:${prev.sl} TP:${prev.tp}\nScore:${prev.score}\nNote:${prev.note}`);
          prev._time = Date.now();
          lastSignals[s] = prev;
          saveLastSignalsSafe(lastSignals);
        }
        continue;
      }

      // send if new stronger or no prev
      if (!prev || newIdea.score >= prev.score) {
        const msg = `🤖 Auto-scan ${s}\n${newIdea.dir}\nEntry:${newIdea.entry}\nSL:${newIdea.sl}\nTP:${newIdea.tp}\nRR:${newIdea.rr}\nScore:${newIdea.score}\nNote:${newIdea.note}`;
        await bot.sendMessage(ADMIN_ID, msg);
        pushHistoryRecord({ auto: true, symbol: s, analysis: r, idea: newIdea });
        lastSignals[s] = Object.assign({}, newIdea, { _time: Date.now() });
        saveLastSignalsSafe(lastSignals);
      } else {
        // prev stronger: optionally resend if old enough
        if (prev && ((Date.now() - (prev._time || 0)) > (10 * 60 * 1000))) {
          await bot.sendMessage(ADMIN_ID, `🔁 Previous strong signal still relevant for ${s}:\n${prev.dir} Entry:${prev.entry} SL:${prev.sl} TP:${prev.tp}\nScore:${prev.score}`);
          prev._time = Date.now();
          lastSignals[s] = prev;
          saveLastSignalsSafe(lastSignals);
        }
      }
    }

    // per-user watchlist notifications (perms)
    const watch = readWatch();
    const perms = readPerms();
    for (const userId of (perms.users || [])) {
      const list = (watch[String(userId)] || []);
      for (const s of list) {
        const r = await fullAnalysis(s);
        if (r.idea && r.idea.ok) {
          const i = r.idea;
          await bot.sendMessage(String(userId), `🔔 Watchlist alert ${s}\n${i.dir} Entry:${i.entry} SL:${i.sl} TP:${i.tp}\nScore:${i.score}\nNote:${i.note}`);
          pushHistoryRecord({ auto: true, symbol: s, analysis: r, idea: i, sentTo: String(userId) });
        }
      }
    }

  } catch (err) {
    console.error('autoScanAll error', err && err.stack ? err.stack : err);
  }
}

// ----------------- TELEGRAM COMMANDS -----------------
bot.onText(/\/start/, (msg) => {
  const chatId = String(msg.chat.id);
  const help = `🤖 *${BOT_NAME}* ready.\nCommands:\n/scan SYMBOL - phân tích ngay (vd: /scan BTCUSDT)\n/watch add SYMBOL - thêm watchlist\n/watch rm SYMBOL - xoá\n/watch list - hiện watchlist\n/history N - xem N lịch sử tín hiệu\n/request - yêu cầu quyền sử dụng\n/status - xem trạng thái bot\n\nAdmin (only):\n/grant CHATID - cấp quyền\n/revoke CHATID - thu hồi quyền\n/announce TEXT - gửi tới tất cả user có quyền\nAuto-scan every ${AUTO_INTERVAL_MIN} minutes for: ${AUTO_COINS.join(', ')}`;
  bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
});

bot.onText(/\/scan (.+)/i, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId)) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền sử dụng bot. Gửi /request để yêu cầu.');
  const r = await fullAnalysis(symbol);
  if (!r.ok) return bot.sendMessage(chatId, `❌ ${r.reason || 'No data'}`);
  if (r.idea && r.idea.ok) {
    const i = r.idea;
    bot.sendMessage(chatId, `📊 ${symbol} -> ${i.dir}\nEntry:${i.entry}\nSL:${i.sl}\nTP:${i.tp}\nScore:${i.score}\nNote:${i.note}`);
    pushHistoryRecord({ type: 'manual_scan', symbol, analysis: r, idea: i, user: chatId });
  } else {
    bot.sendMessage(chatId, `⚠️ Không đủ confluence cho ${symbol}. Reason: ${r.idea ? r.idea.reason : 'No idea'}. Score:${r.idea ? r.idea.score : 0}`);
  }
});

bot.onText(/\/watch (.+)/i, (msg, match) => {
  const chatId = String(msg.chat.id);
  const perms = readPerms();
  if (!perms.users.includes(chatId)) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền. /request để yêu cầu.');
  const args = (match[1] || '').trim().split(/\s+/);
  const cmd = args[0] && args[0].toLowerCase();
  const watch = readWatch();
  if (cmd === 'add' && args[1]) {
    const s = args[1].toUpperCase();
    watch[chatId] = watch[chatId] || [];
    if (!watch[chatId].includes(s)) {
      watch[chatId].push(s);
      saveWatch(watch);
    }
    bot.sendMessage(chatId, `✅ Đã thêm ${s} vào watchlist`);
    return;
  }
  if (cmd === 'rm' && args[1]) {
    const s = args[1].toUpperCase();
    watch[chatId] = (watch[chatId] || []).filter(x => x !== s);
    saveWatch(watch);
    bot.sendMessage(chatId, `🗑️ Đã xóa ${s}`);
    return;
  }
  if (cmd === 'list') {
    const list = (watch[chatId] || []).join(', ') || 'Trống';
    bot.sendMessage(chatId, `📋 Watchlist: ${list}`);
    return;
  }
  bot.sendMessage(chatId, 'Usage: /watch add SYMBOL | /watch rm SYMBOL | /watch list');
});

bot.onText(/\/history(?:\s+(\d+))?/, (msg, match) => {
  const chatId = String(msg.chat.id);
  const n = Math.min(50, parseInt(match[1] || '10', 10));
  const hist = readHistory().slice(0, n);
  if (!hist.length) { bot.sendMessage(chatId, 'Chưa có history'); return; }
  const out = hist.map(h => {
    const t = new Date(h._time).toLocaleString();
    const s = h.symbol || (h.analysis && h.analysis.symbol) || '—';
    const idea = h.idea && h.idea.ok ? `${h.idea.dir} ${h.idea.entry}` : (h.analysis && h.analysis.idea && h.analysis.idea.ok ? `${h.analysis.idea.dir} ${h.analysis.idea.entry}` : 'NoIdea');
    return `${t} | ${s} | ${idea}`;
  }).join('\n');
  bot.sendMessage(chatId, `Lịch sử (mới nhất):\n${out}`);
});

bot.onText(/\/request/, (msg) => {
  const chatId = String(msg.chat.id);
  bot.sendMessage(ADMIN_ID, `📥 Request access from ${chatId}. To grant run: /grant ${chatId}`);
  bot.sendMessage(chatId, '✅ Yêu cầu đã gửi đến admin. Bạn sẽ được thông báo khi được cấp quyền.');
});

bot.onText(/\/grant\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1] || '').trim());
  const perms = readPerms();
  if (!perms.users.includes(target)) {
    perms.users.push(target);
    savePerms(perms);
    bot.sendMessage(ADMIN_ID, `✅ Đã cấp quyền cho ${target}`);
    bot.sendMessage(target, `🎉 Bạn đã được cấp quyền sử dụng ${BOT_NAME} bởi admin.`);
  } else {
    bot.sendMessage(ADMIN_ID, `${target} đã có quyền rồi.`);
  }
});

bot.onText(/\/revoke\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1] || '').trim());
  const perms = readPerms();
  perms.users = (perms.users || []).filter(x => x !== target);
  savePerms(perms);
  bot.sendMessage(ADMIN_ID, `🗑️ Đã thu hồi quyền của ${target}`);
  bot.sendMessage(target, `⚠️ Quyền sử dụng ${BOT_NAME} đã bị thu hồi.`);
});

bot.onText(/\/announce\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const text = match[1].trim();
  const perms = readPerms();
  const users = perms.users || [];
  users.forEach((uid, i) => {
    setTimeout(() => {
      bot.sendMessage(uid, `📣 Announcement from admin:\n${text}`);
    }, i * 50);
  });
  bot.sendMessage(ADMIN_ID, `✅ Sent announcement to ${users.length} users.`);
});

bot.onText(/\/status/, (msg) => {
  const chatId = String(msg.chat.id);
  const last = readLastSignals();
  bot.sendMessage(chatId, `Bot: ${BOT_NAME}\nAuto-scan: every ${AUTO_INTERVAL_MIN} minutes\nWatchlist users: ${Object.keys(readWatch()).length}\nPerms users: ${(readPerms().users || []).length}\nLast signals saved for: ${Object.keys(last).join(', ') || 'none'}`);
});

// ----------------- STARTUP & SERVER -----------------
console.log(`${BOT_NAME} running... (polling)`);
const app = express();
app.get('/', (req, res) => res.send(`${BOT_NAME} is alive`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('HTTP server listening on', PORT));

setTimeout(() => {
  // initial scan on startup
  autoScanAll();
  // schedule
  setInterval(autoScanAll, AUTO_INTERVAL_MIN * 60 * 1000);
}, 2000);

// graceful handlers
process.on('uncaughtException', (err) => console.error('uncaughtException', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection', reason));const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');
const PERMS_FILE = path.join(DATA_DIR, 'permissions.json');
const LAST_SIGNALS_FILE = path.join(DATA_DIR, 'last_signals.json');

if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
if (!fs.existsSync(WATCH_FILE)) fs.writeFileSync(WATCH_FILE, JSON.stringify({}));
if (!fs.existsSync(PERMS_FILE)) fs.writeFileSync(PERMS_FILE, JSON.stringify({ admins: [String(ADMIN_ID)], users: [] }));
if (!fs.existsSync(LAST_SIGNALS_FILE)) fs.writeFileSync(LAST_SIGNALS_FILE, JSON.stringify({}));

// ========== IO HELPERS ==========
function readJSON(file, def = {}) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : def;
  } catch (e) {
    return def;
  }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function readHistory(){ return readJSON(HISTORY_FILE, []); }
function saveHistory(arr){ writeJSON(HISTORY_FILE, arr); }
function readWatch(){ return readJSON(WATCH_FILE, {}); }
function saveWatch(obj){ writeJSON(WATCH_FILE, obj); }
function readPerms(){ return readJSON(PERMS_FILE, { admins: [String(ADMIN_ID)], users: [] }); }
function savePerms(obj){ writeJSON(PERMS_FILE, obj); }
function readLastSignals(){ return readJSON(LAST_SIGNALS_FILE, {}); }
function saveLastSignals(obj){ writeJSON(LAST_SIGNALS_FILE, obj); }

// ========== TELEGRAM BOT ==========
const bot = new TelegramBot(TOKEN, { polling: true });

// ========== BINANCE FETCH ==========
async function fetchKlines(symbol, interval='15m', limit=300){
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data.map(c => ({
      t: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5])
    }));
  } catch (e) {
    console.log('fetchKlines err', e && e.message ? e.message : e);
    return [];
  }
}

// ========== DETECTORS (BOS / OB / FVG / Sweep / Patterns / Liquidity) ==========
function detectBOS(candles, lookback = 20){
  if (candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  const last = slice[slice.length-1];
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);
  const recentHigh = Math.max(...highs.slice(0, highs.length-1));
  const recentLow = Math.min(...lows.slice(0, lows.length-1));
  if (last.close > recentHigh) return { type:'BOS_UP', price: last.close };
  if (last.close < recentLow) return { type:'BOS_DOWN', price: last.close };
  return null;
}

function detectOrderBlock(candles){
  if (candles.length < 6) return { bullish: null, bearish: null };
  const last5 = candles.slice(-6, -1);
  const blocks = { bullish: null, bearish: null };
  for (let i = 0; i < last5.length; i++){
    const c = last5[i];
    const body = Math.abs(c.close - c.open);
    const range = (c.high - c.low) || 1;
    if (body > range * 0.6) {
      if (c.close > c.open) blocks.bullish = c;
      else blocks.bearish = c;
    }
  }
  return blocks;
}

function detectFVG(candles){
  if (candles.length < 5) return null;
  for (let i = candles.length - 3; i >= 2; i--){
    const c = candles[i], c2 = candles[i-2];
    if (!c || !c2) continue;
    if (c.low > c2.high) return { type:'FVG_UP', idx: i, low: c2.high, high: c.low };
    if (c.high < c2.low) return { type:'FVG_DOWN', idx: i, low: c.high, high: c2.low };
  }
  return null;
}

function detectSweep(candles){
  if (candles.length < 3) return null;
  const last = candles[candles.length-1], prev = candles[candles.length-2];
  if (last.high > prev.high && last.close < prev.close) return 'LIQUIDITY_SWEEP_TOP';
  if (last.low < prev.low && last.close > prev.close) return 'LIQUIDITY_SWEEP_BOTTOM';
  return null;
}

function detectCandlePattern(candles){
  const n = candles.length;
  if (n < 2) return null;
  const last = candles[n-1], prev = candles[n-2];
  const body = Math.abs(last.close - last.open);
  const range = (last.high - last.low) || 1;
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  if (body < range * 0.3 && upper > lower * 2) return 'ShootingStar';
  if (body < range * 0.3 && lower > upper * 2) return 'Hammer';
  if (last.close > prev.open && last.open < prev.close && last.close > last.open) return 'BullishEngulfing';
  if (last.close < prev.open && last.open > prev.close && last.close < last.open) return 'BearishEngulfing';
  return null;
}

function detectLiquidityZone(candles){
  if (!candles || candles.length < 20) return null;
  const recent = candles.slice(-30);
  const vols = recent.map(c => c.vol || 0);
  const avgVol = vols.reduce((s, v) => s + v, 0) / Math.max(1, vols.length);
  const last = recent[recent.length-1];
  if (!last) return null;
  if (last.vol > avgVol * 1.8) return { type: 'LIQUIDITY_ZONE', vol: last.vol, avgVol };
  return null;
}

// ========== IDEA ENGINE & SCORING ==========
function scoreIdea({ bos, fvg, ob, pattern, liq }){
  let score = 0;
  if (bos) score += 3;
  if (fvg) score += 3;
  if (ob && (ob.bullish || ob.bearish)) score += 2;
  if (liq) score += 1;
  if (pattern) score += 1;
  return score;
}

function generateIdea(symbol, price, bos, fvg, ob, pattern, liq){
  // direction from BOS
  let dir = null;
  if (bos && bos.type === 'BOS_UP') dir = 'LONG';
  if (bos && bos.type === 'BOS_DOWN') dir = 'SHORT';
  const score = scoreIdea({ bos, fvg, ob, pattern, liq });

  // strict requirement: BOS + FVG + OB + liquidity + score >= 6
  const ok = (dir && fvg && (ob && (ob.bullish || ob.bearish)) && liq && score >= 6);

  if (!ok) return { ok: false, reason: 'Not enough confluence (need BOS+FVG+OB+LIQ)', score };

  const entry = price;
  const sl = dir === 'LONG' ? +(price * 0.99).toFixed(4) : +(price * 1.01).toFixed(4);
  const tp = dir === 'LONG' ? +(price * 1.02).toFixed(4) : +(price * 0.98).toFixed(4);
  const rr = Math.abs((tp - entry) / (entry - sl)).toFixed(2);
  const note = `${bos ? bos.type : ''} ${fvg ? fvg.type : ''} ${ob.bullish ? 'OB_BULL' : ''} ${ob.bearish ? 'OB_BEAR' : ''} ${pattern || ''} ${liq ? liq.type : ''}`.trim();

  return { ok: true, symbol, dir, entry, sl, tp, rr, note, score };
}

// ========== FULL ANALYSIS (TF confluence) ==========
async function fullAnalysis(symbol){
  const kl15 = await fetchKlines(symbol, '15m', 300);
  const kl1h = await fetchKlines(symbol, '1h', 200);
  const kl4h = await fetchKlines(symbol, '4h', 200);

  if (!kl15 || !kl15.length) return { ok: false, reason: 'no data' };

  const price = kl15[kl15.length - 1].close;
  const bos15 = detectBOS(kl15, 20);
  const ob15 = detectOrderBlock(kl15);
  const fvg15 = detectFVG(kl15);
  const sweep15 = detectSweep(kl15);
  const pattern15 = detectCandlePattern(kl15);
  const liq15 = detectLiquidityZone(kl15);

  // optionally check higher timeframe BOS to favor direction
  const bos1h = kl1h && kl1h.length ? detectBOS(kl1h, 20) : null;
  const bos4h = kl4h && kl4h.length ? detectBOS(kl4h, 12) : null;

  const idea = generateIdea(symbol, price, bos15, fvg15, ob15, pattern15, liq15);

  // attach TF info
  return {
    ok: true,
    symbol,
    price,
    timeframe: '15m',
    bos15, bos1h, bos4h,
    ob15, fvg15, sweep15, pattern15, liq15,
    idea
  };
}

// ========== HISTORY HELPERS ==========
function pushHistoryRecord(rec){
  const arr = readHistory();
  rec._time = Date.now();
  arr.unshift(rec);
  if (arr.length > 2000) arr.splice(2000);
  saveHistory(arr);
}
function saveHistory(arr){ writeJSON(HISTORY_FILE, arr); }
function readHistory(){ return readJSON(HISTORY_FILE, []); }

// ========== AUTO-SCAN LOGIC (compare + resend prev stronger) ==========
async function autoScanAll(){
  try {
    const lastSignals = readLastSignals();
    for (const s of AUTO_COINS){
      const r = await fullAnalysis(s);
      if (!r.ok) continue;

      const newIdea = r.idea;
      const prev = lastSignals[s];

      // if newIdea is not ok but prev stronger and not resent recently => resend prev
      if (!newIdea.ok) {
        if (prev && prev.score > (newIdea.score || 0) && ((Date.now() - (prev._time||0)) > (5 * 60 * 1000))) {
          // resend prev
          await bot.sendMessage(ADMIN_ID, `🔁 Resending previous stronger signal for ${s}:\n${prev.dir} Entry:${prev.entry} SL:${prev.sl} TP:${prev.tp}\nNote:${prev.note}\nScore:${prev.score}`);
          // update prev._time to avoid spam
          prev._time = Date.now();
          lastSignals[s] = prev;
          saveLastSignals(lastSignals);
        }
        continue;
      }

      // newIdea.ok === true -> decide whether to send: send only if prev missing or new score >= prev.score
      if (!prev || newIdea.score >= prev.score) {
        const msg = `🤖 Auto-scan ${s}\n${newIdea.dir}\nEntry:${newIdea.entry}\nSL:${newIdea.sl}\nTP:${newIdea.tp}\nRR:${newIdea.rr}\nScore:${newIdea.score}\nNote:${newIdea.note}`;
        await bot.sendMessage(ADMIN_ID, msg);
        pushHistoryRecord({ auto: true, symbol: s, analysis: r, idea: newIdea });
        lastSignals[s] = Object.assign({}, newIdea, { _time: Date.now() });
        saveLastSignals(lastSignals);
      } else {
        // prev stronger: optionally do nothing (or resend prev if older than threshold)
        if (prev && ((Date.now() - (prev._time||0)) > (10 * 60 * 1000))) {
          await bot.sendMessage(ADMIN_ID, `🔁 Previous strong signal still relevant for ${s}:\n${prev.dir} Entry:${prev.entry} SL:${prev.sl} TP:${prev.tp}\nScore:${prev.score}`);
          prev._time = Date.now();
          lastSignals[s] = prev;
          saveLastSignals(lastSignals);
        }
      }
    }

    // per-user watchlist notifications: only users in perms
    const watch = readWatch();
    const perms = readPerms();
    for (const userId of (perms.users || [])) {
      const list = (watch[String(userId)] || []);
      for (const s of list) {
        const r = await fullAnalysis(s);
        if (r.idea && r.idea.ok) {
          const i = r.idea;
          await bot.sendMessage(String(userId), `🔔 Watchlist alert ${s}\n${i.dir} Entry:${i.entry} SL:${i.sl} TP:${i.tp}\nNote:${i.note}\nScore:${i.score}`);
          pushHistoryRecord({ auto: true, symbol: s, analysis: r, idea: i, sentTo: String(userId) });
        }
      }
    }

  } catch (e) {
    console.log('autoScanAll err', e && e.stack ? e.stack : e);
  }
}

function readLastSignals(){ return readJSON(LAST_SIGNALS_FILE, {}); }
function saveLastSignals(obj){ writeJSON(LAST_SIGNALS_FILE, obj); }

// ========== TELEGRAM COMMANDS ==========
bot.onText(/\/start/, (msg) => {
  const chatId = String(msg.chat.id);
  const help = `🤖 *${BOT_NAME}* ready.\nCommands:\n/scan SYMBOL - phân tích ngay (vd: /scan BTCUSDT)\n/watch add SYMBOL - thêm watchlist\n/watch rm SYMBOL - xoá\n/watch list - hiện watchlist\n/history N - xem N lịch sử tín hiệu\n/request - yêu cầu quyền sử dụng\n/status - xem trạng thái bot\n\nAdmin-only:\n/grant CHATID - cấp quyền cho chat\n/revoke CHATID - thu hồi quyền\n/announce TEXT - gửi text tới tất cả user đã được cấp\nAuto-scan every ${AUTO_INTERVAL_MIN} minutes for: ${AUTO_COINS.join(', ')}`;
  bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
});

bot.onText(/\/scan (.+)/i, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId)) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền sử dụng bot. Gửi /request để yêu cầu.');
  const r = await fullAnalysis(symbol);
  if (!r.ok) return bot.sendMessage(chatId, `❌ ${r.reason || 'No data'}`);
  if (r.idea && r.idea.ok) {
    const i = r.idea;
    bot.sendMessage(chatId, `📊 ${symbol} -> ${i.dir}\nEntry:${i.entry}\nSL:${i.sl}\nTP:${i.tp}\nScore:${i.score}\nNote:${i.note}`);
    pushHistoryRecord({ type: 'manual_scan', symbol, analysis: r, idea: i, user: chatId });
  } else {
    bot.sendMessage(chatId, `⚠️ Không đủ confluence cho ${symbol}. Reason: ${r.idea ? r.idea.reason : 'No idea'}. Score:${r.idea ? r.idea.score : 0}`);
  }
});

bot.onText(/\/watch (.+)/i, (msg, match) => {
  const chatId = String(msg.chat.id);
  const perms = readPerms();
  if (!perms.users.includes(chatId)) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền. /request để yêu cầu.');
  const args = (match[1]||'').trim().split(/\s+/);
  const cmd = args[0] && args[0].toLowerCase();
  const watch = readWatch();
  if (cmd === 'add' && args[1]) {
    const s = args[1].toUpperCase();
    watch[chatId] = watch[chatId] || [];
    if (!watch[chatId].includes(s)) {
      watch[chatId].push(s);
      saveWatch(watch);
    }
    bot.sendMessage(chatId, `✅ Đã thêm ${s} vào watchlist`);
    return;
  }
  if (cmd === 'rm' && args[1]) {
    const s = args[1].toUpperCase();
    watch[chatId] = (watch[chatId]||[]).filter(x=>x!==s);
    saveWatch(watch);
    bot.sendMessage(chatId, `🗑️ Đã xóa ${s}`);
    return;
  }
  if (cmd === 'list') {
    const list = (watch[chatId]||[]).join(', ') || 'Trống';
    bot.sendMessage(chatId, `📋 Watchlist: ${list}`);
    return;
  }
  bot.sendMessage(chatId, 'Usage: /watch add SYMBOL | /watch rm SYMBOL | /watch list');
});

bot.onText(/\/history(?:\s+(\d+))?/, (msg, match) => {
  const chatId = String(msg.chat.id);
  const n = Math.min(50, parseInt(match[1]||'10', 10));
  const hist = readHistory().slice(0, n);
  if (!hist.length) { bot.sendMessage(chatId, 'Chưa có history'); return; }
  let out = hist.map(h => {
    const t = new Date(h._time).toLocaleString();
    const s = h.symbol || (h.analysis && h.analysis.symbol) || '—';
    const idea = h.idea && h.idea.ok ? `${h.idea.dir} ${h.idea.entry}` : (h.analysis && h.analysis.idea && h.analysis.idea.ok ? `${h.analysis.idea.dir} ${h.analysis.idea.entry}` : 'NoIdea');
    return `${t} | ${s} | ${idea}`;
  }).join('\n');
  bot.sendMessage(chatId, `Lịch sử (mới nhất):\n${out}`);
});

bot.onText(/\/request/, (msg) => {
  const chatId = String(msg.chat.id);
  bot.sendMessage(ADMIN_ID, `📥 Request access from ${chatId}. To grant run: /grant ${chatId}`);
  bot.sendMessage(chatId, '✅ Yêu cầu đã gửi đến admin. Bạn sẽ được thông báo khi được cấp quyền.');
});

// Admin: grant / revoke / announce
bot.onText(/\/grant\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1]||'').trim());
  const perms = readPerms();
  if (!perms.users.includes(target)) {
    perms.users.push(target);
    savePerms(perms);
    bot.sendMessage(ADMIN_ID, `✅ Đã cấp quyền cho ${target}`);
    bot.sendMessage(target, `🎉 Bạn đã được cấp quyền sử dụng ${BOT_NAME} bởi admin.`);
  } else {
    bot.sendMessage(ADMIN_ID, `${target} đã có quyền rồi.`);
  }
});

bot.onText(/\/revoke\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1]||'').trim());
  const perms = readPerms();
  perms.users = (perms.users||[]).filter(x => x !== target);
  savePerms(perms);
  bot.sendMessage(ADMIN_ID, `🗑️ Đã thu hồi quyền của ${target}`);
  bot.sendMessage(target, `⚠️ Quyền sử dụng ${BOT_NAME} đã bị thu hồi.`);
});

bot.onText(/\/announce\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const text = match[1].trim();
  const perms = readPerms();
  const users = perms.users || [];
  users.forEach((uid, i) => {
    setTimeout(()=> {
      bot.sendMessage(uid, `📣 Announcement from admin:\n${text}`);
    }, i * 50);
  });
  bot.sendMessage(ADMIN_ID, `✅ Sent announcement to ${users.length} users.`);
});

bot.onText(/\/status/, (msg) => {
  const chatId = String(msg.chat.id);
  const last = readLastSignals();
  bot.sendMessage(chatId, `Bot: ${BOT_NAME}\nAuto-scan: every ${AUTO_INTERVAL_MIN} minutes\nWatchlist users: ${Object.keys(readWatch()).length}\nPerms users: ${(readPerms().users||[]).length}\nLast signals saved for: ${Object.keys(last).join(', ') || 'none'}`);
});

// ========== STARTUP & SERVER ==========
console.log(`${BOT_NAME} running... (polling mode)`);
const app = express();
app.get('/', (req, res) => res.send(`${BOT_NAME} is alive`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('HTTP server listening', PORT));

// initial run + interval schedule
setTimeout(() => {
  autoScanAll();
  setInterval(autoScanAll, AUTO_INTERVAL_MIN * 60 * 1000);
}, 2000);

// graceful error logs
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
});// create defaults
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
if (!fs.existsSync(WATCHFILE)) fs.writeFileSync(WATCHFILE, JSON.stringify({}));
if (!fs.existsSync(PERMS_FILE)) fs.writeFileSync(PERMS_FILE, JSON.stringify({ users:[ADMIN_ID] }));
if (!fs.existsSync(LAST_SIGNAL_FILE)) fs.writeFileSync(LAST_SIGNAL_FILE, JSON.stringify({}));

// ---------- UTIL IO ----------
function readJSON(file, def = {}) {
  try {
    const raw = fs.readFileSync(file,'utf8');
    return raw ? JSON.parse(raw) : def;
  } catch (e) {
    return def;
  }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// wrappers
function readHistory(){ return readJSON(HISTORY_FILE, []); }
function saveHistory(arr){ writeJSON(HISTORY_FILE, arr); }
function readWatch(){ return readJSON(WATCHFILE, {}); }
function saveWatch(obj){ writeJSON(WATCHFILE, obj); }
function readPerms(){ return readJSON(PERMS_FILE, { users: [ADMIN_ID] }); }
function savePerms(obj){ writeJSON(PERMS_FILE, obj); }
function readLastSignals(){ return readJSON(LAST_SIGNAL_FILE, {}); }
function saveLastSignals(obj){ writeJSON(LAST_SIGNAL_FILE, obj); }

// ---------- TELEGRAM ----------
const bot = new TelegramBot(TOKEN, { polling: true });

// ---------- BINANCE FETCH ----------
async function fetchKlines(symbol, interval='15m', limit=200){
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data.map(c => ({
      t: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5])
    }));
  } catch (e) {
    console.log('fetchKlines err', e.message || e.toString());
    return [];
  }
}

// ---------- DETECTORS (from your original logic, simplified & improved) ----------
function detectBOS(candles, lookback=20){
  if (candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  const last = slice[slice.length-1];
  const highs = slice.map(c=>c.high);
  const lows = slice.map(c=>c.low);
  const recentHigh = Math.max(...highs.slice(0, highs.length-1));
  const recentLow = Math.min(...lows.slice(0, lows.length-1));
  if (last.close > recentHigh) return {type:'BOS_UP', price: last.close};
  if (last.close < recentLow) return {type:'BOS_DOWN', price: last.close};
  return null;
}

function detectOrderBlock(candles){
  if (candles.length < 6) return {};
  const last5 = candles.slice(-6, -1);
  const blocks = {bullish:null,bearish:null};
  for (let i=0;i<last5.length;i++){
    const c = last5[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 1;
    if (body > range * 0.6){
      if (c.close > c.open) blocks.bullish = c;
      else blocks.bearish = c;
    }
  }
  return blocks;
}

function detectFVG(candles){
  if (candles.length < 5) return null;
  for (let i = candles.length-3; i >= 2; i--){
    const c = candles[i];
    const c2 = candles[i-2];
    if (!c || !c2) continue;
    if (c.low > c2.high) return {type:'FVG_UP', idx:i, low:c2.high, high:c.low};
    if (c.high < c2.low) return {type:'FVG_DOWN', idx:i, low:c.high, high:c2.low};
  }
  return null;
}

function detectSweep(candles){
  if (candles.length < 3) return null;
  const last = candles[candles.length-1], prev = candles[candles.length-2];
  if (last.high > prev.high && last.close < prev.close) return 'LIQUIDITY_SWEEP_TOP';
  if (last.low < prev.low && last.close > prev.close) return 'LIQUIDITY_SWEEP_BOTTOM';
  return null;
}

function detectCandlePattern(candles){
  const n = candles.length;
  if (n < 2) return null;
  const last = candles[n-1], prev = candles[n-2];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low || 1;
  const upper = last.high - Math.max(last.open,last.close);
  const lower = Math.min(last.open,last.close) - last.low;
  if (body < range*0.3 && upper > lower*2) return 'ShootingStar';
  if (body < range*0.3 && lower > upper*2) return 'Hammer';
  if (last.close > prev.open && last.open < prev.close && last.close > last.open) return 'BullishEngulfing';
  if (last.close < prev.open && last.open > prev.close && last.close < last.open) return 'BearishEngulfing';
  return null;
}

// liquidity zone detection: volume spike vs avg
function detectLiquidityZone(candles){
  if (!candles.length) return null;
  const recent = candles.slice(-20);
  const avgVol = recent.reduce((s,c)=>s + (c.vol||0), 0) / Math.max(1, recent.length);
  const last = recent[recent.length-1];
  if (last && last.vol > avgVol * 1.8) return {type:'LIQUIDITY_ZONE', vol:last.vol, avgVol};
  return null;
}

// ---------- IDEA ENGINE with scoring ----------
function scoreIdea({bos, fvg, ob, pattern, liq}){
  // weights
  let score = 0;
  if (bos) score += 3;          // strong
  if (fvg) score += 3;
  if (ob && (ob.bullish || ob.bearish)) score += 2;
  if (liq) score += 1;
  if (pattern) score += 1;
  return score;
}

function generateIdea(symbol, price, bos, fvg, ob, pattern, liq){
  // require BOS + FVG + OB for a "strong" setup
  // direction detection
  let dir = null;
  if (bos && bos.type === 'BOS_UP') dir = 'LONG';
  if (bos && bos.type === 'BOS_DOWN') dir = 'SHORT';

  // if BOS dir disagrees with FVG/OB, we still calculate score
  const score = scoreIdea({bos, fvg, ob, pattern, liq});
  const ok = (dir && fvg && (ob && (ob.bullish || ob.bearish)) && liq && score >= 6);

  if (!ok) return {ok:false, reason:'Not enough confluence', score};

  // entry/sl/tp (simple)
  const entry = price;
  const sl = dir === 'LONG' ? +(price * 0.99).toFixed(4) : +(price * 1.01).toFixed(4);
  const tp = dir === 'LONG' ? +(price * 1.02).toFixed(4) : +(price * 0.98).toFixed(4);
  const rr = Math.abs((tp - entry) / (entry - sl)).toFixed(2);

  const note = `${bos?bos.type:''} ${fvg?fvg.type:''} ${ob.bullish?'OB_BULL':''} ${ob.bearish?'OB_BEAR':''} ${pattern||''} ${liq?liq.type:''}`.trim();

  return { ok:true, symbol, dir, entry, sl, tp, rr, note, score };
}

// ---------- ANALYSIS WRAPPER ----------
async function fullAnalysis(symbol){
  const kl15 = await fetchKlines(symbol, '15m', 300);
  if (!kl15 || !kl15.length) return { ok:false, reason:'no data' };

  const price = kl15[kl15.length-1].close;
  const bos15 = detectBOS(kl15, 20);
  const ob15 = detectOrderBlock(kl15);
  const fvg15 = detectFVG(kl15);
  const sweep15 = detectSweep(kl15);
  const pattern15 = detectCandlePattern(kl15);
  const liq15 = detectLiquidityZone(kl15);

  const idea = generateIdea(symbol, price, bos15, fvg15, ob15, pattern15, liq15);

  return {
    ok:true,
    symbol,
    price,
    timeframe:'15m',
    bos15, ob15, fvg15, sweep15, pattern15, liq15,
    idea
  };
}

// ---------- HISTORY & LAST SIGNAL ----------
function pushHistoryRecord(rec){
  const arr = readHistory();
  rec._time = Date.now();
  arr.unshift(rec);
  if (arr.length > 2000) arr.splice(2000);
  saveHistory(arr);
}

// ---------- AUTO-SCAN LOGIC (compare with last signal) ----------
async function autoScanAll(){
  try {
    const lastSignals = readLastSignals();
    for (const s of AUTO_COINS){
      const r = await fullAnalysis(s);
      if (!r.ok) continue;

      const newIdea = r.idea;
      if (!newIdea.ok){
        // if previous was stronger than this, re-send previous
        const prev = lastSignals[s];
        if (prev && prev.score > (newIdea.score||0) && ((Date.now() - (prev._time||0)) > (5*60*1000))) {
          // resend previous to admin
          await bot.sendMessage(ADMIN_ID, `🔁 Resending previous stronger signal for ${s}:\n${prev.dir} Entry:${prev.entry} SL:${prev.sl} TP:${prev.tp}\nNote:${prev.note}`);
        }
        continue;
      }

      // check last saved
      const prev = lastSignals[s];
      // only send if newIdea.score >= prev.score OR prev missing
      if (!prev || newIdea.score >= prev.score){
        // send to admin and push history
        const msg = `🤖 Auto-scan ${s}\n${newIdea.dir} Entry:${newIdea.entry}\nSL:${newIdea.sl} TP:${newIdea.tp}\nRR:${newIdea.rr}\nScore:${newIdea.score}\nNote:${newIdea.note}`;
        await bot.sendMessage(ADMIN_ID, msg);
        pushHistoryRecord({ auto:true, symbol:s, analysis:r, idea:newIdea });
        // store last signal
        lastSignals[s] = Object.assign({}, newIdea, { _time: Date.now() });
        saveLastSignals(lastSignals);
      } else {
        // if prev stronger, optionally resend previous (already handled above)
      }
    }

    // per-user watchlist notifications (only users in perms)
    const watch = readWatch();
    const perms = readPerms();
    for (const chat of perms.users || []){
      const list = watch[chat] || [];
      for (const s of list){
        const r = await fullAnalysis(s);
        if (r.idea && r.idea.ok){
          await bot.sendMessage(chat, `🔔 Watchlist alert ${s}\n${r.idea.dir} Entry:${r.idea.entry} SL:${r.idea.sl} TP:${r.idea.tp}\nNote:${r.idea.note}`);
          pushHistoryRecord({ auto:true, symbol:s, analysis:r, idea:r.idea, sentTo:chat });
        }
      }
    }
  } catch (e){
    console.log('autoScanAll err', e.message || e.toString());
  }
}

// ---------- COMMANDS ----------
bot.onText(/\/start/, (msg) => {
  const chatId = String(msg.chat.id);
  const help = `🤖 *${BOT_NAME}* ready.\nCommands:\n/scan SYMBOL - phân tích ngay (vd: /scan BTCUSDT)\n/watch add SYMBOL - thêm watchlist\n/watch rm SYMBOL - xoá\n/watch list - hiện watchlist\n/history N - xem N lịch sử tín hiệu\n/request - gửi yêu cầu dùng bot đến admin\n/status - xem trạng thái bot\n\nAdmin-only:\n/grant CHATID - cấp quyền cho chat\n/revoke CHATID - thu hồi quyền\n/announce TEXT - gửi text tới tất cả user đã được cấp\nAuto-scan every ${AUTO_INTERVAL_MIN} minutes for ${AUTO_COINS.join(', ')}`;
  bot.sendMessage(chatId, help, { parse_mode:'Markdown' });
});

bot.onText(/\/scan (.+)/i, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const symbol = (match[1] || '').trim().toUpperCase();
  const perms = readPerms();
  if (!perms.users.includes(chatId)) {
    return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền sử dụng bot. Gửi /request để yêu cầu.');
  }
  const r = await fullAnalysis(symbol);
  if (!r.ok) return bot.sendMessage(chatId, `❌ Không lấy được dữ liệu cho ${symbol}`);
  if (r.idea && r.idea.ok) {
    const i = r.idea;
    bot.sendMessage(chatId, `📊 ${symbol} -> ${i.dir}\nEntry:${i.entry}\nSL:${i.sl}\nTP:${i.tp}\nNote:${i.note}\nScore:${i.score}`);
    pushHistoryRecord({ type:'manual_scan', symbol, analysis:r, idea:i, user:chatId });
  } else {
    bot.sendMessage(chatId, `⚠️ Không đủ confluence cho ${symbol}. Reason: ${r.idea.reason || 'No idea'}. Score:${r.idea.score||0}`);
  }
});

bot.onText(/\/watch (.+)/i, (msg, match) => {
  const chatId = String(msg.chat.id);
  const perms = readPerms();
  if (!perms.users.includes(chatId)) return bot.sendMessage(chatId, '❌ Bạn chưa được cấp quyền. /request để yêu cầu.');
  const args = (match[1]||'').trim().split(/\s+/);
  const cmd = args[0] && args[0].toLowerCase();
  const watch = readWatch();
  if (cmd === 'add' && args[1]) {
    const s = args[1].toUpperCase();
    watch[chatId] = watch[chatId]||[];
    if (!watch[chatId].includes(s)) {
      watch[chatId].push(s);
      saveWatch(watch);
    }
    bot.sendMessage(chatId, `✅ Thêm ${s} vào watchlist`);
    return;
  }
  if (cmd === 'rm' && args[1]) {
    const s = args[1].toUpperCase();
    watch[chatId] = (watch[chatId]||[]).filter(x=>x!==s);
    saveWatch(watch);
    bot.sendMessage(chatId, `🗑️ Đã xóa ${s}`);
    return;
  }
  if (cmd === 'list') {
    const list = (watch[chatId]||[]).join(', ') || 'Trống';
    bot.sendMessage(chatId, `📋 Watchlist: ${list}`);
    return;
  }
  bot.sendMessage(chatId, 'Usage: /watch add SYMBOL | /watch rm SYMBOL | /watch list');
});

bot.onText(/\/history(?:\s+(\d+))?/, (msg, match) => {
  const chatId = String(msg.chat.id);
  const n = Math.min(50, parseInt(match[1]||10,10));
  const hist = readHistory().slice(0,n);
  if (!hist.length) { bot.sendMessage(chatId, 'Chưa có history'); return; }
  let out = hist.map(h => {
    const t = new Date(h._time).toLocaleString();
    const s = h.symbol || (h.analysis && h.analysis.symbol) || '—';
    const idea = h.idea && h.idea.ok ? `${h.idea.dir} ${h.idea.entry}` : (h.analysis && h.analysis.idea && h.analysis.idea.ok ? `${h.analysis.idea.dir} ${h.analysis.idea.entry}` : 'NoIdea');
    return `${t} | ${s} | ${idea}`;
  }).join('\n');
  bot.sendMessage(chatId, `Lịch sử (mới nhất):\n${out}`);
});

bot.onText(/\/request/, (msg) => {
  const chatId = String(msg.chat.id);
  const perms = readPerms();
  // notify admin that someone requested access
  bot.sendMessage(ADMIN_ID, `📥 Request access from ${chatId}. To grant run: /grant ${chatId}`);
  bot.sendMessage(chatId, '✅ Yêu cầu đã gửi đến admin. Bạn sẽ được thông báo khi được cấp quyền.');
});

// Admin commands: grant/revoke/announce
bot.onText(/\/grant\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1]||'').trim());
  const perms = readPerms();
  if (!perms.users.includes(target)) {
    perms.users.push(target);
    savePerms(perms);
    bot.sendMessage(ADMIN_ID, `✅ Đã cấp quyền cho ${target}`);
    bot.sendMessage(target, `🎉 Bạn đã được cấp quyền sử dụng ${BOT_NAME} bởi admin.`);
  } else {
    bot.sendMessage(ADMIN_ID, `${target} đã có quyền rồi.`);
  }
});
bot.onText(/\/revoke\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const target = String((match[1]||'').trim());
  const perms = readPerms();
  perms.users = (perms.users||[]).filter(x=>x!==target);
  savePerms(perms);
  bot.sendMessage(ADMIN_ID, `🗑️ Đã thu hồi quyền của ${target}`);
  bot.sendMessage(target, `⚠️ Quyền sử dụng ${BOT_NAME} đã bị thu hồi.`);
});
bot.onText(/\/announce\s+(.+)/i, (msg, match) => {
  const from = String(msg.from && msg.from.id);
  if (from !== String(ADMIN_ID)) return bot.sendMessage(from, '❌ Chỉ admin mới có quyền này.');
  const text = match[1].trim();
  const perms = readPerms();
  const users = perms.users || [];
  users.forEach(uid => {
    setTimeout(()=> {
      bot.sendMessage(uid, `📣 Announcement from admin:\n${text}`);
    }, 50);
  });
  bot.sendMessage(ADMIN_ID, `✅ Sent announcement to ${users.length} users.`);
});

bot.onText(/\/status/, (msg) => {
  const chatId = String(msg.chat.id);
  const last = readLastSignals();
  bot.sendMessage(chatId, `Bot: ${BOT_NAME}\nAuto-scan: every ${AUTO_INTERVAL_MIN} minutes\nWatchlist users: ${Object.keys(readWatch()).length}\nPerms users: ${(readPerms().users||[]).length}\nLast signals saved for: ${Object.keys(last).join(', ') || 'none'}`);
});

// ---------- STARTUP ----------
console.log(`${BOT_NAME} running...`);

// start HTTP server (health) so Render keeps it alive
const app = express();
app.get('/', (req,res)=> res.send(`${BOT_NAME} is alive`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('HTTP server listening', PORT));

// initial run
setTimeout(() => {
  autoScanAll();
  // schedule interval
  setInterval(autoScanAll, AUTO_INTERVAL_MIN * 60 * 1000);
}, 2000);

// ---------- graceful error logging ----------
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
});  const arr = readJSON(HISTORY_FILE, []);
  rec._time = Date.now();
  arr.unshift(rec);
  if (arr.length > 2000) arr.splice(2000);
  writeJSON(HISTORY_FILE, arr);
};
const readWatch = ()=> readJSON(WATCH_FILE, {});
const saveWatch = (o)=> writeJSON(WATCH_FILE, o);
const readPerms = ()=> readJSON(PERMS_FILE, { admins: [String(ADMIN_ID)], users: [] });
const savePerms = (o)=> writeJSON(PERMS_FILE, o);
const getCurrentSignal = ()=> readJSON(CURRENT_FILE, null);
const saveCurrentSignal = (s)=> writeJSON(CURRENT_FILE, s);

// ========== TELEGRAM BOT ==========
const bot = new TelegramBot(TOKEN, { polling: true });

// ========== BINANCE FETCH ==========
async function fetchKlines(symbol, interval='15m', limit=200){
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data.map(c => ({
      t: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5])
    }));
  } catch (e) {
    console.log('fetchKlines err', e.message);
    return [];
  }
}

// ========== DETECTORS ==========
function detectBOS(candles, lookback=20){
  if (candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  const last = slice[slice.length-1];
  const highs = slice.map(c=>c.high);
  const lows = slice.map(c=>c.low);
  const recentHigh = Math.max(...highs.slice(0, highs.length-1));
  const recentLow = Math.min(...lows.slice(0, lows.length-1));
  if (last.close > recentHigh) return { type: 'BOS_UP', price: last.close };
  if (last.close < recentLow) return { type: 'BOS_DOWN', price: last.close };
  return null;
}

function detectOrderBlock(candles){
  if (candles.length < 6) return { bullish:null, bearish:null };
  const last5 = candles.slice(-6, -1);
  const blocks = { bullish:null, bearish:null };
  for (let i=0;i<last5.length;i++){
    const c = last5[i];
    const body = Math.abs(c.close - c.open);
    const range = (c.high - c.low) || 1;
    if (body > range * 0.6){
      if (c.close > c.open) blocks.bullish = c;
      else blocks.bearish = c;
    }
  }
  return blocks;
}

function detectFVG(candles){
  if (candles.length < 5) return null;
  for (let i = candles.length - 3; i >= 2; i--){
    const c = candles[i], c2 = candles[i-2];
    if (!c || !c2) continue;
    if (c.low > c2.high) return { type:'FVG_UP', idx:i, low:c2.high, high:c.low };
    if (c.high < c2.low) return { type:'FVG_DOWN', idx:i, low:c.high, high:c2.low };
  }
  return null;
}

function detectLiquidityZone(candles){
  if (candles.length < 30) return false;
  const last = candles[candles.length-1];
  const slice = candles.slice(-50);
  const vols = slice.map(c=>c.vol||0);
  const avg = vols.reduce((a,b)=>a+b,0) / vols.length || 0;
  const wickTop = last.high - Math.max(last.open,last.close);
  const wickBottom = Math.min(last.open,last.close) - last.low;
  const wick = Math.max(wickTop, wickBottom);
  const range = (last.high - last.low) || 1;
  return (avg>0 && last.vol > avg * 1.5 && wick > range * 0.35);
}

function detectPattern(candles){
  const n = candles.length;
  if (n < 2) return null;
  const last = candles[n-1], prev = candles[n-2];
  const body = Math.abs(last.close - last.open);
  const range = (last.high - last.low) || 1;
  const upper = last.high - Math.max(last.open,last.close);
  const lower = Math.min(last.open,last.close) - last.low;
  if (body < range*0.3 && upper > lower*2) return 'ShootingStar';
  if (body < range*0.3 && lower > upper*2) return 'Hammer';
  if (last.close > prev.open && last.open < prev.close && last.close > last.open) return 'BullishEngulfing';
  if (last.close < prev.open && last.open > prev.close && last.close < last.open) return 'BearishEngulfing';
  return null;
}

// ========== IDEA & SCORING ==========
function generateIdea(symbol, price, bos, fvg, ob){
  if (!bos) return { ok:false, reason:'No BOS' };
  if (!fvg) return { ok:false, reason:'No FVG' };
  if (!ob || !(ob.bullish || ob.bearish)) return { ok:false, reason:'No OB' };
  const dir = bos.type === 'BOS_UP' ? 'LONG' : 'SHORT';
  const entry = price;
  const sl = dir==='LONG' ? +(price * 0.99).toFixed(2) : +(price * 1.01).toFixed(2);
  const tp = dir==='LONG' ? +(price * 1.02).toFixed(2) : +(price * 0.98).toFixed(2);
  const rr = Math.abs((tp - entry) / (entry - sl)) || 0;
  return { ok:true, symbol, dir, entry, sl, tp, rr, reason:`${bos.type} ${fvg.type} ${ob.bullish? 'OB_Bull':''}${ob.bearish? 'OB_Bear':''}` };
}

// Score function: baseline 100 for having all four; add RR factor and liquidity bonus
function computeSignalScore({ idea, liq }){
  if (!idea || !idea.ok) return 0;
  let score = 100; // base for meeting BOS+FVG+OB
  // RR contributes: rr capped at 3 -> normalized to 0-30
  const rr = Math.min(3, Math.max(0, Number(idea.rr) || 0));
  score += Math.round((rr / 3) * 30); // up to +30
  if (liq) score += 20; // liquidity strong bonus
  return score; // typical range 100..150
}

// ========== FULL ANALYSIS ==========
async function fullAnalysis(symbol){
  const kl15 = await fetchKlines(symbol, '15m', 200);
  if (!kl15.length) return { ok:false, reason:'no data' };
  const price = kl15[kl15.length-1].close;
  const bos15 = detectBOS(kl15, 20);
  const ob15 = detectOrderBlock(kl15);
  const fvg15 = detectFVG(kl15);
  const liq15 = detectLiquidityZone(kl15);
  const pattern15 = detectPattern(kl15);
  const idea = generateIdea(symbol, price, bos15, fvg15, ob15);
  const score = computeSignalScore({ idea, liq: liq15 });
  return { ok:true, symbol, price, timeframe:'15m', bos15, ob15, fvg15, liq15, pattern15, idea, score, kl15 };
}

// ========== SENDING / RECIPIENTS ==========
async function sendToRecipients(text){
  const perms = readPerms();
  const users = Array.from(new Set([...(perms.users||[]).map(String), String(ADMIN_ID)]));
  for (const u of users){
    try { await bot.sendMessage(Number(u), text); } catch(e){ console.log('send err', u, e.message); }
  }
}
async function sendToUser(id, text){
  try { await bot.sendMessage(Number(id), text); } catch(e){ console.log('sendToUser err', id, e.message); }
}

// ========== AUTO-SCAN LOGIC (10 min interval by env) ==========
async function autoScanAll(){
  try {
    console.log('Auto-scan run at', new Date().toISOString());
    const prev = getCurrentSignal(); // may be null
    let prevScore = prev && prev.score ? prev.score : 0;
    let prevSignal = prev;

    for (const s of AUTO_COINS){
      const r = await fullAnalysis(s);
      if (!r.ok) continue;
      // require all four factors to consider sending
      const obExists = !!(r.ob15 && (r.ob15.bullish || r.ob15.bearish));
      const cond = r.bos15 && r.fvg15 && obExists && r.liq15 && r.idea && r.idea.ok;
      if (!cond) continue;

      // new candidate
      const newScore = r.score || 0;
      // Compare by symbol: if previous signal exists for same symbol, compare; 
      // else if previous global is lower, may replace.
      let shouldSend = false;
      if (!prevSignal) {
        shouldSend = true;
      } else if (prevSignal.symbol === s){
        if (newScore > prevScore + 5) shouldSend = true; // threshold
        else shouldSend = false;
      } else {
        // different symbol: if new stronger than prev by margin, replace; else keep prev and resend prev.
        if (newScore > prevScore + 10) shouldSend = true;
        else shouldSend = false;
      }

      if (shouldSend){
        const m = `🤖 Tool_Auto_Trade — Auto-scan ${s}\n${r.idea.dir} | Entry:${r.idea.entry} | SL:${r.idea.sl} | TP:${r.idea.tp} | RR:${r.idea.rr}\nScore:${newScore}\nBOS:${r.bos15.type} FVG:${r.fvg15.type} OB:${obExists? 'Yes':''} Liquidity:Strong\nNote:${r.pattern15||'—'}`;
        await sendToRecipients(m);
        pushHistory({ symbol:s, analysis:r, auto:true, sent:Date.now() });
        // update current_signal
        const signalObj = { symbol:s, analysis:r, score:newScore, sentAt:Date.now() };
        saveCurrentSignal(signalObj);
        // update prev for next comparisons in same run
        prevSignal = signalObj;
        prevScore = newScore;
      } else {
        // resend previous signal (if exists) to keep users reminded (user requested behavior)
        if (prevSignal){
          try {
            const rprev = prevSignal.analysis;
            const mprev = `🔁 Repeat previous signal ${rprev.symbol}\n${rprev.idea.dir} | Entry:${rprev.idea.entry} | SL:${rprev.idea.sl} | TP:${rprev.idea.tp}\nScore:${prevSignal.score}\nNote: resend because new signal weaker`;
            await sendToRecipients(mprev);
            pushHistory({ symbol: rprev.symbol, analysis: rprev, auto:true, resent:true, sentAt:Date.now() });
          } catch(e){}
        }
      }
    }

    // per-user watchlist notifications (only when their watchlist symbol meets criteria)
    const watch = readWatch();
    for (const chat in watch){
      const list = watch[chat]||[];
      for (const s of list){
        const r = await fullAnalysis(s);
        if (!r.ok) continue;
        const obExists = !!(r.ob15 && (r.ob15.bullish || r.ob15.bearish));
        const cond = r.bos15 && r.fvg15 && obExists && r.liq15 && r.idea && r.idea.ok;
        if (cond){
          const m = `🔔 Watchlist ${s}: ${r.idea.dir} | Entry:${r.idea.entry} | SL:${r.idea.sl} | TP:${r.idea.tp}`;
          await sendToUser(chat, m);
          pushHistory({ symbol:s, analysis:r, auto:true, sentTo:chat, sentAt:Date.now() });
        }
      }
    }

  } catch (e){
    console.log('autoScanAll exception', e.message);
  }
}

// start interval
setInterval(autoScanAll, AUTO_INTERVAL_MIN * 60 * 1000);
autoScanAll();

// ========== COMMANDS (permissions, broadcast, request, scan, watch, history) ==========
bot.onText(/\/start/, (msg) => {
  const help = `🤖 Tool_Auto_Trade ready.
Commands:
/getid - xem chat id
/scan SYMBOL - phân tích nhanh
/watch add SYMBOL | /watch rm SYMBOL | /watch list
/request_access - yêu cầu quyền nhận tín hiệu
/users - (admin) list allowed users
/grant <chatId> - (admin) cấp phép
/revoke <chatId> - (admin) thu hồi
/broadcast <message> - (admin) gửi đến tất cả users
/to_boss <message> - gửi tin tới admin
/history N - xem lịch sử N bản
`;
  bot.sendMessage(msg.chat.id, help);
});

bot.onText(/\/getid/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your chat id: ${msg.chat.id}`);
});

bot.onText(/\/scan (.+)/i, async (msg, match) => {
  const chat = msg.chat.id;
  const symbol = (match[1]||'').trim().toUpperCase();
  if (!symbol.endsWith('USDT')) return bot.sendMessage(chat, 'VD: /scan BTCUSDT');
  const r = await fullAnalysis(symbol);
  if (!r.ok) return bot.sendMessage(chat, `Không lấy được dữ liệu ${symbol}`);
  const obExists = !!(r.ob15 && (r.ob15.bullish || r.ob15.bearish));
  const text = `📊 ${symbol}\nGiá:${r.price}\nBOS:${r.bos15? r.bos15.type:'Không'}\nFVG:${r.fvg15? r.fvg15.type:'Không'}\nOB:${obExists? (r.ob15.bullish?'Bullish ':'')+(r.ob15.bearish?'Bearish':'') : 'Không'}\nLiquidity:${r.liq15? 'Strong':'No'}\nIdea:${r.idea.ok? `${r.idea.dir} Entry:${r.idea.entry} SL:${r.idea.sl} TP:${r.idea.tp} RR:${r.idea.rr}` : 'No clear idea'}`;
  bot.sendMessage(chat, text);
});

// watch
bot.onText(/\/watch (.+)/i, (msg, match) => {
  const chat = String(msg.chat.id);
  const args = (match[1]||'').trim().split(/\s+/);
  const cmd = args[0] && args[0].toLowerCase();
  const watch = readWatch();
  if (cmd === 'add' && args[1]) {
    const s = args[1].toUpperCase();
    watch[chat] = watch[chat]||[];
    if (!watch[chat].includes(s)) watch[chat].push(s);
    saveWatch(watch);
    bot.sendMessage(Number(chat), `✅ Thêm ${s} vào watchlist`);
    return;
  }
  if (cmd === 'rm' && args[1]) {
    const s = args[1].toUpperCase();
    watch[chat] = (watch[chat]||[]).filter(x=>x!==s);
    saveWatch(watch);
    bot.sendMessage(Number(chat), `🗑️ Đã xóa ${s}`);
    return;
  }
  if (cmd === 'list') {
    bot.sendMessage(Number(chat), `📋 Watchlist: ${(watch[chat]||[]).join(', ') || 'Trống'}`);
    return;
  }
  bot.sendMessage(Number(chat), 'Usage: /watch add SYMBOL | /watch rm SYMBOL | /watch list');
});

// request access -> admin notified
bot.onText(/\/request_access/, (msg) => {
  const perms = readPerms();
  bot.sendMessage(Number(ADMIN_ID), `Request access from ${msg.chat.id} (${msg.from.username||''}). To grant: /grant ${msg.chat.id}`);
  bot.sendMessage(msg.chat.id, 'Đã gửi yêu cầu đến admin.');
});

// admin commands
bot.onText(/\/grant\s+(\d+)/, (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, 'Chỉ admin mới dùng lệnh này.');
  const id = String(match[1]);
  const perms = readPerms();
  if (!perms.users.includes(id)) perms.users.push(id);
  savePerms(perms);
  bot.sendMessage(msg.chat.id, `Đã cấp phép ${id}`);
  bot.sendMessage(Number(id), 'Bạn đã được cấp quyền nhận tín hiệu từ Tool_Auto_Trade.');
});

bot.onText(/\/revoke\s+(\d+)/, (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, 'Chỉ admin.');
  const id = String(match[1]);
  const perms = readPerms();
  perms.users = (perms.users||[]).filter(x=>x!==id);
  savePerms(perms);
  bot.sendMessage(msg.chat.id, `Đã thu hồi ${id}`);
  bot.sendMessage(Number(id), 'Quyền nhận tín hiệu đã bị thu hồi.');
});

bot.onText(/\/users/, (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, 'Chỉ admin.');
  const perms = readPerms();
  bot.sendMessage(msg.chat.id, `Allowed users:\n${(perms.users||[]).join('\n')}`);
});

// to_boss: user -> admin
bot.onText(/\/to_boss\s+([\s\S]+)/i, (msg, match) => {
  const text = match[1].trim();
  const from = `${msg.from.username || msg.from.first_name || ''} (${msg.chat.id})`;
  bot.sendMessage(Number(ADMIN_ID), `Message from ${from}:\n${text}`);
  bot.sendMessage(msg.chat.id, 'Đã gửi tới admin.');
});

// broadcast
bot.onText(/\/broadcast\s+([\s\S]+)/i, (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, 'Chỉ admin.');
  const text = match[1].trim();
  const perms = readPerms();
  const users = Array.from(new Set((perms.users||[]).map(String)));
  users.unshift(String(ADMIN_ID));
  users.forEach(async id => {
    try { await bot.sendMessage(Number(id), `📣 Broadcast từ Admin:\n${text}`); } catch(e){ console.log('broadcast err', id, e.message); }
  });
  bot.sendMessage(msg.chat.id, 'Đã gửi broadcast.');
});

// history
bot.onText(/\/history(?:\s+(\d+))?/, (msg, match) => {
  const n = Math.min(50, parseInt(match[1]||'10',10));
  const hist = readJSON(HISTORY_FILE, []).slice(0, n);
  if (!hist.length) return bot.sendMessage(msg.chat.id, 'Chưa có lịch sử');
  const out = hist.map(h => `${new Date(h._time).toLocaleString()} | ${h.symbol} | ${h.analysis && h.analysis.idea? h.analysis.idea.dir : 'No'}`).join('\n');
  bot.sendMessage(msg.chat.id, `Lịch sử:\n${out}`);
});

// ========== health server for Render ==========
const app = express();
app.get('/', (req, res) => res.send('Tool_Auto_Trade is alive'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('HTTP server listening', PORT));

console.log('Tool_Auto_Trade running...');
function readWatch(){ return readJSON(WATCHFILE, {}); }
function saveWatch(obj){ writeJSON(WATCHFILE, obj); }
function readPerms(){ return readJSON(PERMS_FILE, { users: [ADMIN_ID] }); }
function savePerms(obj){ writeJSON(PERMS_FILE, obj); }

function pushHistory(rec){
  const arr = readHistory();
  rec._time = Date.now();
  arr.unshift(rec);
  if (arr.length>2000) arr.splice(2000);
  saveHistory(arr);
}

// ========== TELEGRAM BOT ==========
const bot = new TelegramBot(TOKEN, { polling: true });

// ========== BINANCE KLINES ==========
async function fetchKlines(symbol, interval='15m', limit=200){
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 15000 });
    return res.data.map(c => ({
      t: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5])
    }));
  } catch(e){
    console.log('fetchKlines err', e.message);
    return [];
  }
}

// ========== DETECTORS (BOS, OB, FVG, Liquidity) ==========
function detectBOS(candles, lookback=20){
  if (candles.length < lookback) return null;
  const slice = candles.slice(-lookback);
  const last = slice[slice.length-1];
  const highs = slice.map(c=>c.high);
  const lows = slice.map(c=>c.low);
  const recentHigh = Math.max(...highs.slice(0, highs.length-1));
  const recentLow = Math.min(...lows.slice(0, lows.length-1));
  if (last.close > recentHigh) return { type: 'BOS_UP', price: last.close };
  if (last.close < recentLow) return { type: 'BOS_DOWN', price: last.close };
  return null;
}

function detectOrderBlock(candles){
  if (candles.length < 6) return {};
  const last5 = candles.slice(-6, -1);
  const blocks = { bullish: null, bearish: null };
  for (let i=0;i<last5.length;i++){
    const c = last5[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 1;
    if (body > range*0.6){
      if (c.close > c.open) blocks.bullish = c;
      else blocks.bearish = c;
    }
  }
  return blocks;
}

function detectFVG(candles){
  if (candles.length < 5) return null;
  for (let i = candles.length-3; i >= 2; i--){
    const c = candles[i], c2 = candles[i-2];
    if (!c || !c2) continue;
    if (c.low > c2.high) return { type:'FVG_UP', idx:i, low:c2.high, high:c.low };
    if (c.high < c2.low) return { type:'FVG_DOWN', idx:i, low:c.high, high:c2.low };
  }
  return null;
}

function detectLiquidityZone(candles){
  if (candles.length < 30) return false;
  const last = candles[candles.length-1];
  const slice = candles.slice(-50);
  const vols = slice.map(c=>c.vol || 0);
  const avg = vols.reduce((a,b)=>a+b,0)/vols.length || 0;
  const wickTop = last.high - Math.max(last.open,last.close);
  const wickBottom = Math.min(last.open,last.close) - last.low;
  const wick = Math.max(wickTop, wickBottom);
  const range = last.high - last.low || 1;
  // strong liquidity if volume >> avg and big wick
  return (avg>0 && last.vol > avg*1.5 && wick > range*0.35);
}

// pattern (optional)
function detectPattern(candles){
  const n=candles.length;
  if (n<2) return null;
  const last=candles[n-1], prev=candles[n-2];
  const body = Math.abs(last.close-last.open);
  const range = (last.high-last.low)||1;
  const upper = last.high - Math.max(last.open,last.close);
  const lower = Math.min(last.open,last.close) - last.low;
  if (body < range*0.3 && upper > lower*2) return 'ShootingStar';
  if (body < range*0.3 && lower > upper*2) return 'Hammer';
  if (last.close > prev.open && last.open < prev.close && last.close > last.open) return 'BullishEngulfing';
  if (last.close < prev.open && last.open > prev.close && last.close < last.open) return 'BearishEngulfing';
  return null;
}

// ========== IDEA generation (simple RR) ==========
function generateIdea(symbol, price, bos, fvg, ob){
  let dir = null;
  if (bos && bos.type==='BOS_UP') dir='LONG';
  if (bos && bos.type==='BOS_DOWN') dir='SHORT';
  // require confluence: bos + fvg + ob
  if (!dir) return { ok:false, reason:'No BOS' };
  if (!fvg) return { ok:false, reason:'No FVG' };
  if (!ob || !(ob.bullish || ob.bearish)) return { ok:false, reason:'No OB' };
  const entry = price;
  const sl = dir==='LONG' ? +(price*0.99).toFixed(2) : +(price*1.01).toFixed(2);
  const tp = dir==='LONG' ? +(price*1.02).toFixed(2) : +(price*0.98).toFixed(2);
  const rr = Math.abs((tp-entry)/(entry-sl)).toFixed(2);
  return { ok:true, symbol, dir, entry, sl, tp, rr, reason:`BOS:${bos.type} FVG:${fvg.type}` };
}

// ========== FULL ANALYSIS wrapper ==========
async function fullAnalysis(symbol){
  const kl15 = await fetchKlines(symbol, '15m', 200);
  const kl1h = await fetchKlines(symbol, '1h', 200);
  const kl4h = await fetchKlines(symbol, '4h', 200);
  if (!kl15.length) return { ok:false, reason:'no data' };
  const price = kl15[kl15.length-1].close;
  const bos15 = detectBOS(kl15, 20);
  const ob15 = detectOrderBlock(kl15);
  const fvg15 = detectFVG(kl15);
  const liq15 = detectLiquidityZone(kl15);
  const pattern15 = detectPattern(kl15);
  const idea = generateIdea(symbol, price, bos15, fvg15, ob15);
  return { ok:true, symbol, price, timeframe:'15m', bos15, ob15, fvg15, liq15, pattern15, idea, kl15, kl1h, kl4h };
}

// ========== SENDING functions ==========
async function sendToPermittedRecipients(text){
  const perms = readPerms();
  const users = Array.from(new Set((perms.users || []).map(String))).filter(Boolean);
  if (!users.includes(String(ADMIN_ID))) users.unshift(String(ADMIN_ID));
  for (const id of users){
    try { await bot.sendMessage(Number(id), text); }
    catch(e){ console.log('send err', id, e.message); }
  }
}

// ========== AUTO-SCAN ==========
async function autoScanAll(){
  try {
    console.log('Auto-scan start', new Date().toISOString());
    for (const s of AUTO_COINS){
      const r = await fullAnalysis(s);
      if (!r.ok) continue;
      const obExists = !!(r.ob15 && (r.ob15.bullish || r.ob15.bearish));
      const condition = r.bos15 && r.fvg15 && obExists && r.liq15;
      if (condition && r.idea && r.idea.ok){
        const m = `🤖 Auto-scan ${s}\n${r.idea.dir} | Entry:${r.idea.entry} | SL:${r.idea.sl} | TP:${r.idea.tp} | RR:${r.idea.rr}\nBOS:${r.bos15.type} FVG:${r.fvg15.type} OB:${obExists? 'Yes':'No'} Liquidity:Strong\nNote:${r.pattern15||'—'}`;
        await sendToPermittedRecipients(m);
        pushHistory({ symbol:s, analysis:r, auto:true });
      }
    }
    // per-user watchlist notifications
    const watch = readWatch();
    for (const chat in watch){
      const list = watch[chat]||[];
      for (const s of list){
        const r = await fullAnalysis(s);
        if (!r.ok) continue;
        const obExists = !!(r.ob15 && (r.ob15.bullish || r.ob15.bearish));
        const condition = r.bos15 && r.fvg15 && obExists && r.liq15;
        if (condition && r.idea && r.idea.ok){
          try {
            await bot.sendMessage(Number(chat), `🔔 Watch ${s}: ${r.idea.dir} @ ${r.idea.entry} SL:${r.idea.sl} TP:${r.idea.tp}`);
            pushHistory({ symbol:s, analysis:r, auto:true, sentTo:chat });
          } catch(e){}
        }
      }
    }
  } catch(e){
    console.log('autoScanAll exception', e.message);
  }
}
setInterval(autoScanAll, AUTO_INTERVAL_MIN * 60 * 1000);
autoScanAll();

// ========== COMMANDS & PERMISSIONS ==========
bot.onText(/\/start/, (msg) => {
  const help = `🤖 ICT Auto Bot
Commands:
/getid - xem chat id
/scan SYMBOL - phân tích ngay
/watch add SYMBOL | /watch rm SYMBOL | /watch list
/request_access - yêu cầu quyền nhận tín hiệu
/getperms - (admin) list allowed users
/grant <chatId> - (admin) cấp phép
/revoke <chatId> - (admin) thu hồi
/broadcast <message> - (admin) gửi đến tất cả users
/to_boss <message> - gửi tin tới admin (admin có thể broadcast)
`;
  bot.sendMessage(msg.chat.id, help);
});

bot.onText(/\/getid/, (msg) => bot.sendMessage(msg.chat.id, `Your chat id: ${msg.chat.id}`));

bot.onText(/\/scan (.+)/i, async (msg, match) => {
  const chat = msg.chat.id;
  const symbol = (match[1]||'').trim().toUpperCase();
  if (!symbol.endsWith('USDT')) return bot.sendMessage(chat, 'VD: /scan BTCUSDT');
  const r = await fullAnalysis(symbol);
  if (!r.ok) return bot.sendMessage(chat, `Không lấy được ${symbol}`);
  const obExists = !!(r.ob15 && (r.ob15.bullish || r.ob15.bearish));
  const text = `📊 ${symbol}\nGiá:${r.price}\nBOS:${r.bos15? r.bos15.type:'Không'}\nFVG:${r.fvg15? r.fvg15.type:'Không'}\nOB:${obExists? 'Yes':'No'}\nLiquidity:${r.liq15? 'Strong':'No'}\nIdea:${r.idea.ok? `${r.idea.dir} Entry:${r.idea.entry} SL:${r.idea.sl} TP:${r.idea.tp}` : 'No clear idea'}`;
  bot.sendMessage(chat, text);
});

// watch
bot.onText(/\/watch (.+)/i, (msg, match) => {
  const chat = String(msg.chat.id);
  const args = (match[1]||'').trim().split(/\s+/);
  const cmd = args[0] && args[0].toLowerCase();
  const watch = readWatch();
  if (cmd==='add' && args[1]){
    const s = args[1].toUpperCase();
    watch[chat] = watch[chat]||[];
    if (!watch[chat].includes(s)) watch[chat].push(s);
    saveWatch(watch);
    bot.sendMessage(Number(chat), `✅ Thêm ${s} vào watchlist`);
    return;
  }
  if (cmd==='rm' && args[1]){
    const s=args[1].toUpperCase();
    watch[chat] = (watch[chat]||[]).filter(x=>x!==s);
    saveWatch(watch);
    bot.sendMessage(Number(chat), `🗑️ Đã xóa ${s}`);
    return;
  }
  if (cmd==='list'){
    bot.sendMessage(Number(chat), `📋 Watchlist: ${(watch[chat]||[]).join(', ')||'Trống'}`);
    return;
  }
  bot.sendMessage(Number(chat), 'Usage: /watch add SYMBOL | /watch rm SYMBOL | /watch list');
});

// request access
bot.onText(/\/request_access/, (msg) => {
  const perms = readPerms();
  bot.sendMessage(Number(ADMIN_ID), `Request access from ${msg.chat.id} (${msg.from.username||''}). Use /grant ${msg.chat.id} to approve.`);
  bot.sendMessage(msg.chat.id, 'Yêu cầu đã gửi tới admin.');
});

// admin grant/revoke/getperms
bot.onText(/\/grant\s+(\d+)/, (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, 'Chỉ admin mới dùng được lệnh này.');
  const id = String(match[1]);
  const perms = readPerms();
  if (!perms.users.includes(id)) perms.users.push(id);
  savePerms(perms);
  bot.sendMessage(msg.chat.id, `Đã cấp phép cho ${id}`);
  bot.sendMessage(Number(id), 'Bạn đã được cấp quyền nhận tín hiệu từ bot.');
});

bot.onText(/\/revoke\s+(\d+)/, (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, 'Chỉ admin.');
  const id = String(match[1]);
  const perms = readPerms();
  perms.users = (perms.users||[]).filter(x=>x!==id);
  savePerms(perms);
  bot.sendMessage(msg.chat.id, `Đã thu hồi ${id}`);
  bot.sendMessage(Number(id), 'Quyền nhận tín hiệu đã bị thu hồi.');
});

bot.onText(/\/getperms/, (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, 'Chỉ admin.');
  const perms = readPerms();
  bot.sendMessage(msg.chat.id, `Allowed users:\n${(perms.users||[]).join('\n')}`);
});

// to_boss: user -> admin
bot.onText(/\/to_boss\s+([\s\S]+)/i, (msg, match) => {
  const text = match[1].trim();
  const from = `${msg.from.username||msg.from.first_name||''} (${msg.chat.id})`;
  bot.sendMessage(Number(ADMIN_ID), `Message from ${from}:\n${text}`);
  bot.sendMessage(msg.chat.id, 'Đã gửi tới admin.');
});

// broadcast (admin)
bot.onText(/\/broadcast\s+([\s\S]+)/i, (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return bot.sendMessage(msg.chat.id, 'Chỉ admin.');
  const text = match[1].trim();
  const perms = readPerms();
  const users = Array.from(new Set((perms.users||[]).map(String)));
  users.unshift(String(ADMIN_ID));
  users.forEach(async id => {
    try { await bot.sendMessage(Number(id), `📢 Broadcast từ Admin:\n${text}`); }
    catch(e){ console.log('broadcast err', id, e.message); }
  });
  bot.sendMessage(msg.chat.id, 'Đã gửi broadcast.');
});

// history
bot.onText(/\/history(?:\s+(\d+))?/, (msg, match) => {
  const n = Math.min(50, parseInt(match[1]||'10',10));
  const hist = readHistory().slice(0,n);
  if (!hist.length) return bot.sendMessage(msg.chat.id, 'Chưa có lịch sử');
  const out = hist.map(h => `${new Date(h._time).toLocaleString()} | ${h.symbol} | ${h.analysis && h.analysis.bos15? h.analysis.bos15.type:'No'}`).join('\n');
  bot.sendMessage(msg.chat.id, `Lịch sử:\n${out}`);
});

// ========== minimal webserver for Render healthcheck ==========
const app = express();
app.get('/', (req,res) => res.send('Bot OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('HTTP server running on', PORT));

console.log('ICT Auto Bot running...');
