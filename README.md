# Zalo Backend — AI Platform Long Phúc A

## Cài đặt

```bash
npm install
node server.js
```

## Deploy lên VPS/hosting có Node.js

### Option 1: PM2 (khuyến nghị)
```bash
npm install -g pm2
pm2 start server.js --name zalo-backend
pm2 startup
pm2 save
```

### Option 2: Chạy thủ công
```bash
PORT=3001 node server.js
```

## API Endpoints

| Method | URL | Mô tả |
|--------|-----|-------|
| POST | /api/zalo/create-qr | Tạo QR đăng nhập Zalo cá nhân |
| GET | /api/zalo/status/:sessionId | Kiểm tra trạng thái session |
| GET | /api/zalo/bots | Danh sách bot đang kết nối |
| POST | /api/zalo/disconnect | Ngắt kết nối bot |
| POST | /api/zalo/send | Gửi tin nhắn |
| POST | /api/zalo/configure | Cấu hình AI cho bot |
| GET | /health | Kiểm tra server |

## WebSocket

Kết nối: `ws://your-server:3001?sid=SESSION_ID`

Events nhận được:
- `connected` — đã kết nối WebSocket
- `qr` — QR mới (base64 image + URL)
- `login_success` — đăng nhập thành công (phone, name, avatar)
- `login_failed` — đăng nhập thất bại
- `new_message` — có tin nhắn mới từ khách

## Cấu hình trong platform

Vào **Sửa hệ thống** → nhập URL server:
```
http://your-server-ip:3001
```

Hoặc nếu deploy có domain:
```
https://api.web3aai.com
```

## Lưu ý quan trọng

- Server cần chạy liên tục (dùng PM2)
- Mỗi số Zalo cần quét QR 1 lần, sau đó tự động kết nối lại
- Zalo có thể yêu cầu xác minh nếu đăng nhập từ IP mới
- Nên dùng VPS Việt Nam để tránh bị chặn

## Yêu cầu hệ thống

- Node.js >= 18
- RAM >= 512MB
- Kết nối internet ổn định
