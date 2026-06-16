/**
 * ZALO BACKEND — AI Platform Long Phúc A
 * Xử lý đăng nhập Zalo cá nhân qua QR + webhook chatbot
 * 
 * Deploy: Node.js server (port 3001)
 * Cài đặt: npm install
 * Chạy: node server.js
 */

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const WebSocket = require('ws');
const QRCode  = require('qrcode');
const { Zalo, LoginQRCallbackEventType } = require('zca-js');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── State ──────────────────────────────────────────────────────
const sessions = {};   // { sessionId: { zalo, status, info, listeners } }
const bots     = {};   // { phoneNumber: { zalo, name, listeners } }

// ── WebSocket broadcast ────────────────────────────────────────
function broadcast(sessionId, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.sessionId === sessionId) {
      ws.send(msg);
    }
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  ws.sessionId = url.searchParams.get('sid') || 'default';
  ws.send(JSON.stringify({ type: 'connected', sid: ws.sessionId }));
});

// ── API: Tạo QR đăng nhập Zalo cá nhân ────────────────────────
app.post('/api/zalo/create-qr', async (req, res) => {
  const { sessionId = 'default', displayName = 'Zalo Bot' } = req.body;

  try {
    const zalo = new Zalo();
    sessions[sessionId] = { zalo, status: 'pending', displayName };

    // Lắng nghe sự kiện QR
    zalo.onLoginQR(async (event) => {
      if (event.type === LoginQRCallbackEventType.QRUpdated) {
        // Tạo QR image từ URL
        const qrDataURL = await QRCode.toDataURL(event.data.qrUrl, {
          width: 280,
          margin: 2,
          color: { dark: '#0068FF', light: '#FFFFFF' }
        });

        broadcast(sessionId, {
          type: 'qr',
          qrDataURL,
          qrUrl: event.data.qrUrl,
          expiry: event.data.expiry || 60
        });

        console.log(`[QR] Session ${sessionId}: QR updated`);
      }
    });

    // Bắt đầu login
    const loginResult = await zalo.login({
      qr: true,
      onSuccess: (info) => {
        sessions[sessionId].status  = 'connected';
        sessions[sessionId].info    = info;
        sessions[sessionId].phone   = info.profile?.phoneNumber;
        sessions[sessionId].name    = info.profile?.displayName || displayName;

        // Lưu bot
        const phone = info.profile?.phoneNumber;
        if (phone) {
          bots[phone] = { zalo, name: info.profile?.displayName, sessionId };
          setupMessageListener(phone, zalo);
        }

        broadcast(sessionId, {
          type: 'login_success',
          phone: info.profile?.phoneNumber,
          name:  info.profile?.displayName,
          avatar: info.profile?.avatar
        });

        console.log(`[Login] ✅ Session ${sessionId}: ${info.profile?.displayName} (${info.profile?.phoneNumber})`);
      },
      onFailed: (err) => {
        sessions[sessionId].status = 'failed';
        broadcast(sessionId, { type: 'login_failed', message: err?.message || 'Đăng nhập thất bại' });
        console.warn(`[Login] ❌ Session ${sessionId}:`, err?.message);
      }
    });

    res.json({ success: true, sessionId, message: 'QR đang được tạo...' });

  } catch (err) {
    console.error('[create-qr]', err);
    res.json({ success: false, message: err.message });
  }
});

// ── API: Kiểm tra trạng thái session ──────────────────────────
app.get('/api/zalo/status/:sessionId', (req, res) => {
  const s = sessions[req.params.sessionId];
  if (!s) return res.json({ status: 'not_found' });
  res.json({
    status: s.status,
    phone:  s.phone,
    name:   s.name,
    displayName: s.displayName
  });
});

// ── API: Liệt kê tất cả bot đang kết nối ─────────────────────
app.get('/api/zalo/bots', (req, res) => {
  const list = Object.entries(bots).map(([phone, b]) => ({
    phone, name: b.name, sessionId: b.sessionId, active: true
  }));
  res.json({ success: true, bots: list });
});

// ── API: Ngắt kết nối bot ─────────────────────────────────────
app.post('/api/zalo/disconnect', (req, res) => {
  const { phone, sessionId } = req.body;
  const key = phone || sessionId;

  if (phone && bots[phone]) {
    try { bots[phone].zalo?.logout?.(); } catch(e) {}
    delete bots[phone];
  }

  if (sessionId && sessions[sessionId]) {
    sessions[sessionId].status = 'disconnected';
    delete sessions[sessionId];
  }

  res.json({ success: true, message: 'Đã ngắt kết nối' });
});

// ── API: Gửi tin nhắn qua Zalo cá nhân ───────────────────────
app.post('/api/zalo/send', async (req, res) => {
  const { phone, toPhone, toThread, message, type = 'user' } = req.body;

  const bot = bots[phone];
  if (!bot) return res.json({ success: false, message: 'Bot không tồn tại hoặc chưa kết nối' });

  try {
    const zalo = bot.zalo;
    const api  = zalo.api;

    if (type === 'group') {
      await api.sendMessage({ msg: message }, toThread, 2); // ThreadType.Group = 2
    } else {
      await api.sendMessage({ msg: message }, toPhone, 0); // ThreadType.User = 0
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[send]', err);
    res.json({ success: false, message: err.message });
  }
});

// ── Lắng nghe tin nhắn đến ────────────────────────────────────
function setupMessageListener(phone, zalo) {
  try {
    zalo.api.listener.on('message', async (msg) => {
      if (msg.isSelf) return; // Bỏ qua tin tự gửi

      const fromPhone  = msg.fromUid;
      const content    = msg.data?.content || msg.data?.msg || '';
      const threadType = msg.threadType; // 0=user, 2=group
      const threadId   = msg.threadId;

      console.log(`[Msg] Bot ${phone} ← ${fromPhone}: ${content}`);

      // Gọi AI để xử lý (nếu cấu hình)
      let replyText = await processMessage(phone, fromPhone, content, threadId, threadType);

      if (replyText) {
        try {
          if (threadType === 2) {
            await zalo.api.sendMessage({ msg: replyText }, threadId, 2);
          } else {
            await zalo.api.sendMessage({ msg: replyText }, fromPhone, 0);
          }
        } catch(e) {
          console.error('[reply]', e.message);
        }
      }

      // Broadcast đến platform dashboard
      const bot = bots[phone];
      if (bot) {
        broadcast(bot.sessionId, {
          type:       'new_message',
          from:       fromPhone,
          content,
          threadId,
          threadType,
          timestamp:  Date.now()
        });
      }
    });

    zalo.api.listener.start();
    console.log(`[Listener] Started for bot ${phone}`);
  } catch(e) {
    console.warn('[setupMessageListener]', e.message);
  }
}

// ── Xử lý tin nhắn bằng AI ────────────────────────────────────
const companyPrompts = {}; // { phone: { prompt, apiKey, greeting } }

app.post('/api/zalo/configure', (req, res) => {
  const { phone, prompt, apiKey, greeting, autoReply = true } = req.body;
  companyPrompts[phone] = { prompt, apiKey, greeting, autoReply };
  res.json({ success: true });
});

async function processMessage(botPhone, fromPhone, content, threadId, threadType) {
  const config = companyPrompts[botPhone];
  if (!config || !config.autoReply) return null;

  // Nếu có API key → gọi AI
  if (config.apiKey) {
    try {
      const fetch = (await import('node-fetch')).default;
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          system: config.prompt || 'Bạn là trợ lý AI hỗ trợ khách hàng. Trả lời ngắn gọn, thân thiện bằng tiếng Việt.',
          messages: [{ role: 'user', content }]
        })
      });
      const data = await resp.json();
      return data.content?.[0]?.text || null;
    } catch(e) {
      console.warn('[AI]', e.message);
    }
  }

  // Fallback: greeting
  return config.greeting || null;
}

// ── Health check ───────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bots: Object.keys(bots).length,
    sessions: Object.keys(sessions).length,
    uptime: Math.round(process.uptime()) + 's'
  });
});

// ── Start server ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║  🤖 Zalo Backend — AI Platform Long Phúc A ║
║  Port: ${PORT}                                ║
║  WebSocket: ws://localhost:${PORT}           ║
╚═══════════════════════════════════════════╝
  `);
});
