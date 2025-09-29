// bot.js — Tool_Auto_Trade (FULL)
// Requires: npm install node-telegram-bot-api axios express
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// ========== CONFIG (from env) ==========
const TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID; // string or number
const AUTO_INTERVAL_MIN = parseInt(process.env.AUTO_INTERVAL_MIN || '10', 10); // 10 minutes
const AUTO_COINS = (process.env.AUTO_COINS || 'BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,BNBUSDT').split(',').map(s=>s.trim().toUpperCase());

// sanity checks
if (!TOKEN || !ADMIN_ID) {
  console.error('Missing TELEGRAM_TOKEN or ADMIN_ID environment variable. Set them before start.');
  process.exit(1);
}

// ========== FILES ==========
const HISTORY_FILE = path.join(__dirname, 'history.json');
const WATCH_FILE = path.join(__dirname, 'watchlist.json');
const PERMS_FILE = path.join(__dirname, 'permissions.json');
const CURRENT_FILE = path.join(__dirname, 'current_signal.json');

// ensure files exist
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
if (!fs.existsSync(WATCH_FILE)) fs.writeFileSync(WATCH_FILE, JSON.stringify({}));
if (!fs.existsSync(PERMS_FILE)) fs.writeFileSync(PERMS_FILE, JSON.stringify({ admins: [String(ADMIN_ID)], users: [] }));
if (!fs.existsSync(CURRENT_FILE)) fs.writeFileSync(CURRENT_FILE, JSON.stringify(null));

// ========== HELPERS ==========
const readJSON = (p, d)=>{ try { return JSON.parse(fs.readFileSync(p,'utf8') || 'null') || d; } catch(e){ return d; } }
const writeJSON = (p, o)=> fs.writeFileSync(p, JSON.stringify(o, null, 2));
const pushHistory = (rec) => {
  const arr = readJSON(HISTORY_FILE, []);
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
