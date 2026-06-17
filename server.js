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

    // Trả về ngay để frontend không bị timeout
    res.json({ success: true, sessionId, message: 'QR đang được tạo...' });

    // Bắt đầu login QR — callback nhận từng sự kiện
    try {
      const api = await zalo.loginQR({}, async (event) => {
        console.log(`[QR] Session ${sessionId} event:`, event.type, LoginQRCallbackEventType[event.type]);

        // QR mới được tạo
        // event.data.image = base64 PNG (KHÔNG có prefix data:image/png;base64,)
        if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
          console.log(`[QR] data keys:`, Object.keys(event.data || {}));

          const imgBase64 = event.data?.image;
          if (imgBase64) {
            // Thêm prefix để thành data URL hợp lệ
            const qrDataURL = 'data:image/png;base64,' + imgBase64;
            broadcast(sessionId, {
              type: 'qr',
              qrDataURL,
              qrUrl: null,  // zca-js không trả về URL riêng
              expiry: 60
            });
            console.log(`[QR] ✅ Broadcast QR image (base64 PNG) to session ${sessionId}`);
          } else {
            console.warn('[QR] event.data.image không có:', event.data);
          }
        }

        // QR hết hạn
        if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
          broadcast(sessionId, { type: 'qr_expired', message: 'QR hết hạn, đang tạo mới...' });
        }

        // Đã quét QR
        if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
          broadcast(sessionId, { type: 'qr_scanned', message: 'Đã quét QR, đang xác nhận...' });
        }

        // Đăng nhập thành công — GotLoginInfo
        if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
          const info = event.data;
          sessions[sessionId].status = 'connected';
          sessions[sessionId].info   = info;

          // Lấy profile từ api (loginQR trả về api object sau khi resolve)
          broadcast(sessionId, {
            type: 'login_success',
            phone: null,
            name:  displayName,
            message: 'Đăng nhập thành công!'
          });
          console.log(`[Login] ✅ Session ${sessionId}: login thành công`);
        }
      });

      // loginQR resolve = đăng nhập xong, api là Zalo API instance
      if (api) {
        sessions[sessionId].api    = api;
        sessions[sessionId].status = 'connected';
        const profile = await api.fetchAccountInfo().catch(() => null);
        const phone   = profile?.profile?.phoneNumber;
        const name    = profile?.profile?.displayName || displayName;

        if (phone) {
          bots[phone] = { zalo: api, name, sessionId };
          setupMessageListener(phone, api);
        }

        broadcast(sessionId, {
          type: 'login_success',
          phone,
          name,
          avatar: profile?.profile?.avatar
        });
        console.log(`[Login] ✅ Profile: ${name} (${phone})`);
      }
    } catch(loginErr) {
      sessions[sessionId].status = 'failed';
      broadcast(sessionId, { type: 'login_failed', message: loginErr.message });
      console.error('[login]', loginErr.message);
    }

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
function setupMessageListener(phone, api) {
  try {
    // api là instance trả về từ loginQR (đã có listener)
    const listener = api.listener || (api.api && api.api.listener);
    if (!listener) { console.warn('[Listener] Không tìm thấy listener cho', phone); return; }
    listener.on('message', async (msg) => {
      if (msg.isSelf) return; // Bỏ qua tin tự gửi

      const fromPhone  = msg.fromUid;
      const content    = msg.data?.content || msg.data?.msg || '';
      const threadType = msg.threadType; // 0=user, 2=group
      const threadId   = msg.threadId;

      console.log(`[Msg] Bot ${phone} ← ${fromPhone}: ${content}`);

      // Lấy tên người dùng từ Zalo API
      let fromName = fromPhone;
      let fromAvatar = '';
      try {
        const sendApi = api.sendMessage ? api : (api.api || api);
        const userInfo = await sendApi.getUserInfo({ userId: fromPhone }).catch(() => null);
        if (userInfo?.profile) {
          fromName   = userInfo.profile.displayName || fromPhone;
          fromAvatar = userInfo.profile.avatar       || '';
        }
      } catch(e) { /* Không lấy được tên — dùng UID */ }

      // Gọi AI để xử lý (nếu cấu hình)
      let replyText = await processMessage(phone, fromPhone, content, threadId, threadType);

      if (replyText) {
        try {
          const sendApi = api.sendMessage ? api : (api.api || api);
          if (threadType === 2) {
            await sendApi.sendMessage({ msg: replyText }, threadId, 2);
          } else {
            await sendApi.sendMessage({ msg: replyText }, fromPhone, 0);
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
          fromName,
          fromAvatar,
          content,
          threadId,
          threadType,
          timestamp:  Date.now()
        });
      }
    });

    listener.start();
    console.log(`[Listener] ✅ Started for bot ${phone}`);
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
