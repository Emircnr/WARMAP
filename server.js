// server.js - Paribu Arbitraj + 7/24 İSTATİSTİK KAYDI
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('🚀 Başlatılıyor... PORT:', PORT);

// CORS - EN ÖNCE OLMALI
app.use(cors());
app.use(express.json());

// WebSocket durumu (health check için)
let wsConnected = false;

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    websocket: { connected: wsConnected }
  });
});
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// ===== VERİ DEPOLAMA (MEMORY) =====
let allSignals = [];           // Tüm sinyal kayıtları
let activeSignals = new Map(); // Şu an aktif sinyaller
let stats = {
  totalSignals: 0,
  totalValue: 0,
  bySymbol: {},
  hourly: {},
  daily: {},
  maxPct: 0,
  maxPctSymbol: '',
  maxPctTime: null,
  startTime: Date.now()
};

// ===== STREAM CACHE =====
const streamCache = new Map();
const subscribedChannels = new Set();
const depthCache = new Map();
let ws = null;
let requestIdCounter = 1;

// ===== YAPILANDIRMA =====
let CONFIG = {
  symbols: ['ACM', 'ASR', 'ATM', 'BAR', 'CITY', 'JUV', 'LUNA', 'PSG'],
  minPct: 0.4,
  checkInterval: 100  // 0.1 saniye - Binance cache ile korunuyor
};

const BINANCE_CACHE_TIME = 300; // Binance için 300ms cache (rate limit koruması)

let usdtTry = 0;
let usdtLastFetch = 0;
let binancePrices = {};
let binanceLastFetch = 0;
let lastCheck = 0;

// ===== HELPER FUNCTIONS =====
function convertToParibuSymbol(sym) {
  // BTC -> btc_tl
  return sym.toLowerCase() + '_tl';
}

function convertFromParibuSymbol(sym) {
  // btc_tl -> BTC
  return sym.replace('_tl', '').toUpperCase();
}

function calculateDepth(market, bids, asks) {
  if (!bids || !asks) return;
  const topBidQty = bids.length > 0 ? parseFloat(bids[0][1]) : 0;
  const topAskQty = asks.length > 0 ? parseFloat(asks[0][1]) : 0;
  const topBidPrice = bids.length > 0 ? parseFloat(bids[0][0]) : 0;
  const topAskPrice = asks.length > 0 ? parseFloat(asks[0][0]) : 0;
  
  depthCache.set(market, {
    topBidQty, topAskQty,
    topBidValue: topBidPrice * topBidQty,
    topAskValue: topAskPrice * topAskQty,
    topBidPrice, topAskPrice,
    timestamp: Date.now()
  });
}

// ===== WEBSOCKET BAĞLANTISI =====
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;
let pingInterval = null;

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  console.log('🔌 Paribu WebSocket bağlanıyor... (Deneme:', wsReconnectAttempts + 1, ')');
  
  try {
    // Eski bağlantıyı temizle
    if (ws) {
      try { ws.terminate(); } catch(e) {}
      ws = null;
    }
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    
    ws = new WebSocket('wss://stream.paribu.com');
    
    // Timeout - 10 saniyede bağlanamazsa yeniden dene
    const connectTimeout = setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        console.log('⏱️ WebSocket bağlantı timeout');
        try { ws.terminate(); } catch(e) {}
        ws = null;
        wsConnected = false;
        scheduleReconnect();
      }
    }, 10000);

    ws.on('open', () => {
      clearTimeout(connectTimeout);
      wsConnected = true;
      wsReconnectAttempts = 0;
      subscribedChannels.clear();
      console.log('✅ Paribu WebSocket bağlandı!');
      
      // USDT ve sembollere abone ol
      subscribeToMarket('usdt_tl');
      CONFIG.symbols.forEach(sym => subscribeToMarket(convertToParibuSymbol(sym)));
      
      // Ping interval for keep-alive
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch(e) {}
        }
      }, 30000);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Paribu orderbook response format
        // {"e":"orderbook","E":timestamp,"s":"usdt_tl","r":{"u":123,"b":[["price","amount"]],"a":[["price","amount"]]}}
        if (msg.e === 'orderbook' && msg.r && msg.s) {
          const market = msg.s; // usdt_tl format
          const bids = (msg.r.b || []).map(o => [o[0], o[1]])
            .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])).slice(0, 20);
          const asks = (msg.r.a || []).map(o => [o[0], o[1]])
            .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).slice(0, 20);
          
          streamCache.set(market, { bids, asks, timestamp: Date.now() });
          calculateDepth(market, bids, asks);
        }
        
        // Paribu ticker24h response for price updates
        // {"e":"ticker24h","E":timestamp,"s":"usdt_tl","r":{...}}
        if (msg.e === 'ticker24h' && msg.r && msg.s) {
          const market = msg.s;
          const existing = streamCache.get(market);
          if (!existing) {
            // Create basic entry from ticker
            const lastPrice = msg.r.c || msg.r.l;
            if (lastPrice) {
              streamCache.set(market, { 
                bids: [[lastPrice, '1']], 
                asks: [[lastPrice, '1']], 
                timestamp: Date.now() 
              });
            }
          }
        }
        
        // Subscription confirmation
        if (msg.code !== undefined) {
          if (msg.code === 100) {
            console.log('✅ Abone olundu');
          } else if (msg.error) {
            console.log('❌ Abonelik hatası:', msg.error);
          }
        }
      } catch (e) {}
    });

    ws.on('close', (code, reason) => {
      wsConnected = false;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      console.log('🔴 WebSocket kapandı. Kod:', code);
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('❌ WS Error:', err.message);
      wsConnected = false;
    });
    
  } catch (err) {
    console.error('❌ WS Create Error:', err.message);
    wsConnected = false;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  
  wsReconnectAttempts++;
  // Exponential backoff: 1s, 2s, 4s, 8s... max 30s
  const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts - 1), 30000);
  
  console.log(`🔄 ${delay/1000}sn sonra yeniden bağlanılacak...`);
  
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket();
  }, delay);
}

// Her 30 saniyede bağlantı kontrolü
setInterval(() => {
  if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) {
    console.log('⚠️ WebSocket kopuk, yeniden bağlanıyor...');
    if (ws) {
      try { ws.terminate(); } catch(e) {}
      ws = null;
    }
    wsConnected = false;
    connectWebSocket();
  }
}, 30000);

function subscribeToMarket(market) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (subscribedChannels.has(market)) return true;

  try {
    // Paribu subscription format
    // {"method":"subscribe","channels":["orderbook:usdt_tl@100ms"],"id":"req_123"}
    const subscribeMsg = {
      method: "subscribe",
      channels: [`orderbook:${market}@100ms`],
      id: `req_${requestIdCounter++}`
    };
    
    ws.send(JSON.stringify(subscribeMsg));
    subscribedChannels.add(market);
    console.log(`📡 ${market} orderbook abone olundu`);
    return true;
  } catch (e) { 
    console.error('Abonelik hatası:', e.message);
    return false; 
  }
}

// ===== BINANCE FİYATLARI =====
async function fetchBinancePrices() {
  // Cache kontrolü - çok sık istek atma
  if (Date.now() - binanceLastFetch < BINANCE_CACHE_TIME) {
    return; // Cache'den kullan
  }
  
  try {
    const symbols = CONFIG.symbols.map(s => `"${s}USDT"`).join(',');
    const url = `https://api.binance.com/api/v3/ticker/bookTicker?symbols=[${symbols}]`;
    const res = await fetch(url);
    const data = await res.json();
    
    data.forEach(item => {
      const sym = item.symbol.replace('USDT', '');
      binancePrices[sym] = {
        bid: parseFloat(item.bidPrice),
        ask: parseFloat(item.askPrice)
      };
    });
    binanceLastFetch = Date.now();
  } catch (e) {
    console.error('Binance hatası:', e.message);
  }
}

// ===== USDT/TRY =====
function getUsdtTry() {
  const cached = streamCache.get('usdt_tl');
  if (cached && cached.bids && cached.bids.length > 0) {
    const bid = parseFloat(cached.bids[0][0]);
    const ask = parseFloat(cached.asks[0][0]);
    usdtTry = (bid + ask) / 2;
  }
  return usdtTry;
}

// ===== ARBİTRAJ KONTROLÜ =====
async function checkArbitrage() {
  try {
    if (!wsConnected) return;
    
    const usdt = getUsdtTry();
    if (usdt <= 0) return;
    
    await fetchBinancePrices();
    
    const now = Date.now();
    const hour = new Date().toISOString().slice(0, 13);
    const day = new Date().toISOString().slice(0, 10);
    
    const currentActive = new Set();
  
  CONFIG.symbols.forEach(sym => {
    const paribuMarket = convertToParibuSymbol(sym);
    const cached = streamCache.get(paribuMarket);
    const binance = binancePrices[sym];
    
    if (!cached || !cached.bids || cached.bids.length === 0) return;
    if (!binance) return;
    
    const pBid = parseFloat(cached.bids[0][0]);
    const pAsk = parseFloat(cached.asks[0][0]);
    const pBidQty = parseFloat(cached.bids[0][1]);
    const pAskQty = parseFloat(cached.asks[0][1]);
    
    const bBidTL = binance.bid * usdt;
    const bAskTL = binance.ask * usdt;
    
    const diff1 = pBid - bAskTL;
    const diff2 = bBidTL - pAsk;
    
    let pct = 0, direction = '', qty = 0, value = 0;
    
    if (diff1 > diff2 && diff1 > 0) {
      pct = (diff1 / bAskTL) * 100;
      direction = 'sell';
      qty = pBidQty;
      value = pBid * pBidQty;
    } else if (diff2 > 0) {
      pct = (diff2 / pAsk) * 100;
      direction = 'buy';
      qty = pAskQty;
      value = pAsk * pAskQty;
    }
    
    if (pct >= CONFIG.minPct) {
      currentActive.add(sym);
      
      if (!activeSignals.has(sym)) {
        activeSignals.set(sym, {
          sym, direction, startTime: now, startPct: pct, maxPct: pct, qty, value
        });
        console.log(`📈 [${sym}] ${direction === 'sell' ? 'SAT' : 'AL'} %${pct.toFixed(2)} | ${qty.toFixed(2)} adet | ${value.toFixed(0)} TL`);
      } else {
        const signal = activeSignals.get(sym);
        if (pct > signal.maxPct) {
          signal.maxPct = pct;
          signal.qty = qty;
          signal.value = value;
        }
      }
    }
  });
  
  // Biten sinyalleri kaydet
  for (const [sym, signal] of activeSignals) {
    if (!currentActive.has(sym)) {
      const duration = (now - signal.startTime) / 1000;
      
      const record = {
        sym,
        direction: signal.direction,
        pct: signal.maxPct,
        qty: signal.qty,
        value: signal.value,
        duration,
        timestamp: signal.startTime,
        endTime: now,
        hour,
        day
      };
      
      allSignals.push(record);
      if (allSignals.length > 50000) allSignals = allSignals.slice(-40000);
      
      // Stats güncelle
      stats.totalSignals++;
      stats.totalValue += signal.value;
      
      if (!stats.bySymbol[sym]) {
        stats.bySymbol[sym] = { count: 0, totalDuration: 0, maxPct: 0, totalValue: 0, avgPct: 0 };
      }
      const s = stats.bySymbol[sym];
      s.count++;
      s.totalDuration += duration;
      s.totalValue += signal.value;
      if (signal.maxPct > s.maxPct) s.maxPct = signal.maxPct;
      s.avgPct = ((s.avgPct * (s.count - 1)) + signal.maxPct) / s.count;
      
      // Saatlik
      if (!stats.hourly[hour]) stats.hourly[hour] = { count: 0, value: 0 };
      stats.hourly[hour].count++;
      stats.hourly[hour].value += signal.value;
      
      // Günlük
      if (!stats.daily[day]) stats.daily[day] = { count: 0, value: 0, maxPct: 0 };
      stats.daily[day].count++;
      stats.daily[day].value += signal.value;
      if (signal.maxPct > stats.daily[day].maxPct) stats.daily[day].maxPct = signal.maxPct;
      
      // Global max
      if (signal.maxPct > stats.maxPct) {
        stats.maxPct = signal.maxPct;
        stats.maxPctSymbol = sym;
        stats.maxPctTime = signal.startTime;
      }
      
      console.log(`✅ [${sym}] Kapandı: %${signal.maxPct.toFixed(2)} | ${duration.toFixed(1)}sn | Toplam: ${stats.totalSignals}`);
      
      activeSignals.delete(sym);
    }
  }
  
  lastCheck = now;
  } catch (e) {
    console.error('Arbitraj kontrol hatası:', e.message);
  }
}

// ===== INDEX.HTML =====
let indexHtml = '<h1>Loading...</h1>';
let statsHtml = '<h1>Loading...</h1>';
try {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    indexHtml = fs.readFileSync(indexPath, 'utf8');
    console.log('✅ index.html yüklendi');
  }
  const statsPath = path.join(__dirname, 'stats.html');
  if (fs.existsSync(statsPath)) {
    statsHtml = fs.readFileSync(statsPath, 'utf8');
    console.log('✅ stats.html yüklendi');
  }
} catch (e) {}

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(indexHtml);
});

app.get('/stats', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(statsHtml);
});

// ===== API ENDPOINTS =====
app.get('/api/paribu/orderbook', async (req, res) => {
  const { market } = req.query;
  if (!market) return res.status(400).json({ error: 'market gerekli' });
  const paribuMarket = market.includes('_') ? market.toLowerCase() : convertToParibuSymbol(market.replace('TRY', '').replace('TL', ''));
  subscribeToMarket(paribuMarket);
  const cached = streamCache.get(paribuMarket);
  res.json(cached ? { bids: cached.bids, asks: cached.asks } : { bids: [], asks: [] });
});

// Backward compatibility
app.get('/api/btcturk/orderbook', async (req, res) => {
  const { market } = req.query;
  if (!market) return res.status(400).json({ error: 'market gerekli' });
  // USDTTRY -> usdt_tl, BTCTRY -> btc_tl
  let paribuMarket = market.toLowerCase().replace('try', '_tl');
  if (!paribuMarket.includes('_')) {
    paribuMarket = paribuMarket.replace('tl', '_tl');
  }
  subscribeToMarket(paribuMarket);
  const cached = streamCache.get(paribuMarket);
  res.json(cached ? { bids: cached.bids, asks: cached.asks } : { bids: [], asks: [] });
});

app.post('/api/paribu/batch', async (req, res) => {
  const { markets } = req.body;
  if (!Array.isArray(markets)) return res.status(400).json({ error: 'markets array gerekli' });

  markets.forEach(m => {
    const paribuMarket = m.includes('_') ? m.toLowerCase() : convertToParibuSymbol(m.replace('TRY', '').replace('TL', ''));
    subscribeToMarket(paribuMarket);
  });

  const results = markets.map(market => {
    const paribuMarket = market.includes('_') ? market.toLowerCase() : convertToParibuSymbol(market.replace('TRY', '').replace('TL', ''));
    const cached = streamCache.get(paribuMarket);
    const depth = depthCache.get(paribuMarket);
    if (cached && cached.bids && cached.bids.length > 0) {
      return { market, success: true, data: { bids: cached.bids, asks: cached.asks }, depth, cached: true };
    }
    return { market, success: false, error: 'Veri yok' };
  });

  res.json({ success: true, results });
});

// Backward compatibility
app.post('/api/btcturk/batch', async (req, res) => {
  const { markets } = req.body;
  if (!Array.isArray(markets)) return res.status(400).json({ error: 'markets array gerekli' });

  markets.forEach(m => {
    // BTCTRY -> btc_tl
    let paribuMarket = m.toLowerCase().replace('try', '_tl');
    if (!paribuMarket.includes('_')) {
      paribuMarket = paribuMarket.replace('tl', '_tl');
    }
    subscribeToMarket(paribuMarket);
  });

  const results = markets.map(market => {
    let paribuMarket = market.toLowerCase().replace('try', '_tl');
    if (!paribuMarket.includes('_')) {
      paribuMarket = paribuMarket.replace('tl', '_tl');
    }
    const cached = streamCache.get(paribuMarket);
    const depth = depthCache.get(paribuMarket);
    if (cached && cached.bids && cached.bids.length > 0) {
      return { market, success: true, data: { bids: cached.bids, asks: cached.asks }, depth, cached: true };
    }
    return { market, success: false, error: 'Veri yok' };
  });

  res.json({ success: true, results });
});

// ===== İSTATİSTİK API =====
app.get('/api/stats', (req, res) => {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  res.json({
    ...stats,
    uptime,
    uptimeStr: `${Math.floor(uptime/3600)}s ${Math.floor((uptime%3600)/60)}d ${uptime%60}sn`,
    activeCount: activeSignals.size,
    activeSignals: Array.from(activeSignals.values()),
    wsConnected,
    usdtTry,
    lastCheck
  });
});

app.get('/api/stats/signals', (req, res) => {
  const { limit = 100, sym, day } = req.query;
  let filtered = allSignals;
  
  if (sym) filtered = filtered.filter(s => s.sym === sym.toUpperCase());
  if (day) filtered = filtered.filter(s => s.day === day);
  
  res.json({
    total: filtered.length,
    signals: filtered.slice(-parseInt(limit)).reverse()
  });
});

app.get('/api/stats/daily', (req, res) => {
  res.json(stats.daily);
});

app.get('/api/stats/hourly', (req, res) => {
  // Son 24 saat
  const hours = Object.entries(stats.hourly)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 24);
  res.json(Object.fromEntries(hours));
});

app.get('/api/stats/symbols', (req, res) => {
  res.json(stats.bySymbol);
});

app.get('/api/stats/export', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=arbitraj-stats-${new Date().toISOString().slice(0,10)}.json`);
  res.json({
    exportTime: new Date().toISOString(),
    stats,
    signals: allSignals
  });
});

// ===== CONFIG API =====
app.get('/api/config', (req, res) => {
  res.json(CONFIG);
});

app.post('/api/config', (req, res) => {
  const { symbols, minPct, checkInterval } = req.body;
  if (symbols) CONFIG.symbols = symbols;
  if (minPct !== undefined) CONFIG.minPct = parseFloat(minPct);
  if (checkInterval) CONFIG.checkInterval = parseInt(checkInterval);
  
  // Yeni sembollere abone ol
  if (symbols) {
    symbols.forEach(sym => subscribeToMarket(convertToParibuSymbol(sym)));
  }
  
  console.log('⚙️ Config güncellendi:', CONFIG);
  res.json({ success: true, config: CONFIG });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ===== START =====
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Server dinliyor - Port:', PORT);
  
  // WebSocket bağlan
  connectWebSocket();
  
  // Arbitraj kontrolü başlat
  setInterval(checkArbitrage, CONFIG.checkInterval);
  
  console.log('📊 7/24 istatistik kaydı aktif!');
  console.log(`📋 Semboller: ${CONFIG.symbols.join(', ')}`);
  console.log(`📉 Min %: ${CONFIG.minPct}`);
});

server.on('error', (err) => console.error('❌ Server Error:', err.message));
process.on('uncaughtException', (err) => console.error('⚠️ Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('⚠️ Rejection:', reason));

// Heartbeat
setInterval(() => {
  const now = new Date().toLocaleTimeString('tr-TR');
  const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  console.log(`[${now}] 💓 Sinyal: ${stats.totalSignals} | Aktif: ${activeSignals.size} | WS: ${wsConnected ? '✅' : '❌'} | RAM: ${mem}MB`);
}, 60000);
