const express = require("express");
const cors = require("cors");
const { LiveChat } = require("youtube-chat");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =========================
// Keyword filter (punyamu)
// =========================
const KEYWORDS = [
  "mati", "meninggal", "rip", "pak dhe", "phey", "pheym", "pakde", "pak de",
  "zenmoza", "mas pe", "tp", "tepelepsi", "kabupaten", "jember", "tepe",
  "huget", "teguh", "pyem", "phyem", "tepung", "tepu",
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildKeywordMatchers(keywords) {
  return keywords
    .map((kw) => {
      const k = String(kw).trim().toLowerCase();
      if (!k) return null;

      // keyword pendek (contoh: "tp") biar ga nabrak kata lain
      if (k.length <= 2) {
        const re = new RegExp(`\\b${escapeRegex(k)}\\b`, "i");
        return { kw: k, test: (s) => re.test(s) };
      }

      // keyword normal: contains (case-insensitive)
      return { kw: k, test: (s) => s.toLowerCase().includes(k) };
    })
    .filter(Boolean);
}

const MATCHERS = buildKeywordMatchers(KEYWORDS);

function matchesKeywords(messageText) {
  const s = String(messageText || "");
  if (!s) return false;
  return MATCHERS.some((m) => m.test(s));
}

// =========================
// State (chat observer + buffer)
// =========================
let liveChat = null;
let running = false;

const MAX_BUFFER = 500;
const buffer = [];
let seq = 0;

// =========================
// SSE clients
// =========================
const sseClients = new Set();

function toWIBString(date) {
  // format mirip contohmu: "11/2/2026, 21.49.51"
  return date.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function chatItemToApi(chatItem) {
  // message: MessageItem[] -> gabung jadi string
  const msg = Array.isArray(chatItem?.message)
    ? chatItem.message.map((m) => m?.text ?? "").join("")
    : "";

  const ts = chatItem?.timestamp instanceof Date ? chatItem.timestamp : new Date();

  let authorName = String(chatItem?.author?.name || "").trim();
  if (authorName && !authorName.startsWith("@")) authorName = "@" + authorName;

  return {
    id: ++seq,
    tsIso: ts.toISOString(),
    tsWIB: toWIBString(ts),
    author: authorName || null,
    msg,
    usec: null, // biarin null sesuai formatmu
  };
}

function broadcastSSE(item) {
  const payload = `data: ${JSON.stringify(item)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

function pushMessage(item) {
  buffer.push(item);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  broadcastSSE(item);
}

// =========================
// Start / stop observer
// =========================
async function startObserver({ liveId, channelId }) {
  if (running) return { ok: true, msg: "already running" };
  if (!liveId && !channelId) return { ok: false, msg: "liveId atau channelId wajib" };

  liveChat = new LiveChat(liveId ? { liveId } : { channelId });

  liveChat.on("start", (resolvedLiveId) => {
    console.log("✅ LiveChat start, liveId =", resolvedLiveId);
  });

  liveChat.on("chat", (chatItem) => {
    const msg = Array.isArray(chatItem?.message)
      ? chatItem.message.map((m) => m?.text ?? "").join("")
      : "";

    if (!matchesKeywords(msg)) return;

    const payload = chatItemToApi(chatItem);
    pushMessage(payload);

    console.log(`[MATCH] ${payload.tsWIB} ${payload.author}: ${payload.msg}`);
  });

  liveChat.on("end", (reason) => {
    console.log("🛑 LiveChat end:", reason || "(no reason)");
    running = false;
  });

  liveChat.on("error", (err) => {
    console.error("❌ LiveChat error:", err?.message || err);
  });

  const ok = await liveChat.start(); // boolean
  running = !!ok;

  if (!ok) return { ok: false, msg: "failed to start (cek log error)" };
  return { ok: true, msg: "started" };
}

function stopObserver() {
  if (liveChat) liveChat.stop();
  liveChat = null;
  running = false;
  return { ok: true, msg: "stopped" };
}

// =========================
// Routes
// =========================

// Start:
// /api/start?liveId=VIDEO_ID
// /api/start?channelId=UCxxxx
app.get("/api/start", async (req, res) => {
  try {
    const liveId = req.query.liveId ? String(req.query.liveId) : null;
    const channelId = req.query.channelId ? String(req.query.channelId) : null;

    const result = await startObserver({ liveId, channelId });
    res.json({ ...result, running, keywords: KEYWORDS });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/api/stop", (req, res) => {
  const result = stopObserver();
  res.json({ ...result, running });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    running,
    bufferSize: buffer.length,
    lastId: buffer.at(-1)?.id ?? 0,
    keywords: KEYWORDS,
    sseClients: sseClients.size,
  });
});

// Polling endpoint (opsional):
// /api/messages?limit=50
// /api/messages?sinceId=123
app.get("/api/messages", (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  const sinceId = req.query.sinceId ? Number(req.query.sinceId) : null;

  let items = buffer;
  if (sinceId != null && Number.isFinite(sinceId)) {
    items = items.filter((x) => x.id > sinceId);
  }

  const sliced = items.slice(-limit);

  res.json({
    ok: true,
    running,
    count: sliced.length,
    lastId: sliced.length ? sliced[sliced.length - 1].id : (buffer.at(-1)?.id ?? 0),
    data: sliced,
  });
});

// SSE endpoint (real-time + keep-alive tiap 1 detik)
// Client: new EventSource("http://localhost:3000/api/stream");
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // optional: kirim lastId biar client tau posisi
  res.write(`event: hello\ndata: ${JSON.stringify({ running, lastId: buffer.at(-1)?.id ?? 0 })}\n\n`);

  // ping tiap 1 detik supaya koneksi ga mati
  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 1000);

  sseClients.add(res);

  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// =========================
// Start server
// =========================
app.listen(PORT, () => {
  console.log(`✅ API up on http://localhost:${PORT}`);
  console.log(`- Start : /api/start?liveId=VIDEO_ID (atau ?channelId=CHANNEL_ID)`);
  console.log(`- SSE   : /api/stream`);
  console.log(`- Poll  : /api/messages?limit=50`);
  console.log(`- Stop  : /api/stop`);
});
