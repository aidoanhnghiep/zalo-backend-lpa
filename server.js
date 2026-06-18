// ============================================================
// SERVER.JS v4 — Long Phúc A — HOÀN CHỈNH
// Zalo cá nhân QR + AI Gemini auto-reply + Quản lý tin nhắn
// ============================================================
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT         = process.env.PORT || 3001;
const GEMINI_KEY   = process.env.GEMINI_API_KEY || '';
let   RUNTIME_KEY  = GEMINI_KEY; // có thể update từ frontend

// ── State ────────────────────────────────────────────────────
const wsClients = new Set();
const sessions  = new Map(); // sid → {ws, zalo}
const history   = new Map(); // uid → [{role,parts}]
const contacts  = new Map(); // uid → {name,avatar,phone,msgs[]}

function getHist(uid){ return history.get(uid)||[]; }
function addHist(uid,role,text){
  const h=getHist(uid);
  h.push({role,parts:[{text}]});
  if(h.length>20) h.splice(0,h.length-20);
  history.set(uid,h);
}
function getContact(uid,name,avatar){
  if(!contacts.has(uid)) contacts.set(uid,{name:name||uid,avatar:avatar||'',phone:uid,msgs:[],unread:0,lastTime:Date.now()});
  const c=contacts.get(uid);
  if(name && name!==uid) c.name=name;
  if(avatar) c.avatar=avatar;
  return c;
}

// ── Broadcast ────────────────────────────────────────────────
function broadcast(data){
  const m=JSON.stringify(data);
  wsClients.forEach(ws=>{ if(ws.readyState===WebSocket.OPEN) ws.send(m); });
}

// ── Gemini AI ─────────────────────────────────────────────────
async function askGemini(text,uid,sysPrompt){
  const key=RUNTIME_KEY;
  if(!key) return 'Xin lỗi, AI chưa được cấu hình. Hotline: 0915 40 5969 ạ!';
  const {default:fetch}=await import('node-fetch');
  addHist(uid,'user',text);
  try{
    const r=await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      { method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          contents: getHist(uid),
          systemInstruction:{parts:[{text: sysPrompt||
            'Bạn là trợ lý AI của Long Phúc A Technology (LPA Computer).\n'+
            'Hotline: 0915 40 5969. Web: web3aai.com\n'+
            'Chuyên: Chatbot AI, chuyển đổi số, IT, camera, mạng, máy tính.\n'+
            'Trả lời ngắn gọn dưới 150 từ, thân thiện, xưng em, gọi anh/chị.\n'+
            'Nếu cần hỗ trợ sâu hơn: mời gọi hotline 0915 40 5969.'
          }]}
        })
      }
    );
    const d=await r.json();
    const reply=d.candidates?.[0]?.content?.parts?.[0]?.text||'Em chưa hiểu. Anh/chị nói rõ hơn được không ạ?';
    addHist(uid,'model',reply);
    return reply;
  }catch(e){
    console.error('[Gemini]',e.message);
    return 'Hệ thống đang bận. Vui lòng thử lại sau ạ!';
  }
}

// ── zca-js ───────────────────────────────────────────────────
let ZaloClass=null;
(async()=>{
  try{
    const m=await import('zca-js');
    ZaloClass=m.Zalo||m.default?.Zalo||m.default;
    console.log('[ZCA] loaded ✅');
  }catch(e){ console.warn('[ZCA] not found:',e.message); }
})();

// ── WebSocket — parse sid từ URL query ───────────────────────
wss.on('connection',(ws,req)=>{
  // Parse ?sid=xxx từ URL
  let sid=null;
  try{
    const u=new URL(req.url,'http://x');
    sid=u.searchParams.get('sid');
  }catch(e){}

  wsClients.add(ws);
  if(sid){
    if(!sessions.has(sid)) sessions.set(sid,{ws});
    else sessions.get(sid).ws=ws;
    ws._sid=sid;
    console.log('[WS] connected, sid:',sid,'total:',wsClients.size);
  } else {
    console.log('[WS] connected (no sid), total:',wsClients.size);
  }

  ws.on('message',async raw=>{
    try{
      const m=JSON.parse(raw.toString());
      if(m.type==='ping'){ ws.send(JSON.stringify({type:'pong'})); return; }
      if(m.type==='register_session'){
        const s=m.sessionId;
        if(!sessions.has(s)) sessions.set(s,{ws});
        else sessions.get(s).ws=ws;
        ws._sid=s;
        console.log('[WS] register_session:',s);
      }
      // Nhân viên gửi tin nhắn thủ công
      if(m.type==='send_message' && m.to && m.text){
        const sess=sessions.get(ws._sid);
        if(sess?.zalo){
          await sess.zalo.sendMessage({to:m.to,text:m.text});
          console.log('[WS] manual send to',m.to);
        }
      }
    }catch(_){}
  });

  ws.on('close',()=>{
    wsClients.delete(ws);
    if(ws._sid){
      const sess=sessions.get(ws._sid);
      if(sess && sess.ws===ws) { sess.ws=null; } // giữ session nhưng xóa ws
    }
    console.log('[WS] disconnected, total:',wsClients.size);
  });
  ws.on('error',e=>console.warn('[WS err]',e.message));
});

// ── API: Tạo QR đăng nhập Zalo ───────────────────────────────
app.post('/api/zalo/create-qr',async(req,res)=>{
  const{sessionId,displayName}=req.body||{};
  res.json({ok:true,sessionId});

  const sendTo=(data)=>{
    const sess=sessions.get(sessionId);
    const ws=sess?.ws;
    if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data));
    else { // thử tìm ws khác có cùng sid
      wsClients.forEach(c=>{ if(c._sid===sessionId && c.readyState===WebSocket.OPEN) c.send(JSON.stringify(data)); });
    }
  };

  if(!ZaloClass){ sendTo({type:'error',message:'zca-js chưa cài. Chạy: npm install zca-js'}); return; }

  try{
    const zalo=new ZaloClass();
    const stream=await zalo.login({loginType:'qr'});
    if(!stream){ sendTo({type:'error',message:'login() không trả về stream'}); return; }

    stream.on('qr',qr=>{
      console.log('[ZCA] QR ready, sending to session:',sessionId);
      sendTo({type:'qr',qrDataURL:qr,expiry:60});
    });

    stream.on('login',async cred=>{
      const name=cred?.name||displayName||'Zalo cá nhân';
      const phone=cred?.phone||'';
      console.log('[ZCA] ✅ Login OK:',name,phone);
      sendTo({type:'login_success',name,phone});

      // Lưu zalo instance vào session
      if(!sessions.has(sessionId)) sessions.set(sessionId,{ws:null});
      sessions.get(sessionId).zalo=zalo;

      // Lấy danh sách hội thoại và broadcast
      setTimeout(async()=>{
        try{
          const convList=await zalo.getConversations?.({count:20})||[];
          if(convList.length){
            broadcast({type:'zalo_conversations',data:convList});
            console.log('[ZCA] Synced',convList.length,'conversations');
          }
        }catch(e){ console.warn('[ZCA] getConversations:',e.message); }
      },2000);

      // ── Lắng nghe tin nhắn thật ──
      zalo.on('message',async msg=>{
        try{
          if(msg.isSelf) return;
          const fromId  =msg.uidFrom||msg.fromId||msg.from||'';
          const fromName=msg.dName||msg.fromName||'Khách';
          const avatar  =msg.srcAvt||msg.avatar||'';
          const content =msg.data?.content||msg.content||msg.text||'';
          const ts      =Number(msg.ts||msg.time||Date.now());
          if(!content||!fromId) return;

          console.log(`[ZCA msg] ${fromName}(${fromId}): ${content.slice(0,50)}`);

          // Lưu vào contacts
          const contact=getContact(fromId,fromName,avatar);
          contact.unread++;
          contact.lastTime=ts;
          if(!contact.msgs) contact.msgs=[];
          contact.msgs.push({from:'cust',t:content,time:new Date(ts).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'})});

          // Broadcast tới tất cả frontend
          broadcast({
            type:'new_message', platform:'zalo',
            from:fromId, fromName, fromAvatar:avatar,
            content, timestamp:ts,
            isGroup:!!msg.isGroup, groupId:msg.idTo||''
          });

          // Gemini AI tự động trả lời
          const key=RUNTIME_KEY;
          if(key){
            const reply=await askGemini(content,fromId);
            try{
              const toId=msg.isGroup?msg.idTo:fromId;
              await zalo.sendMessage({to:toId,text:reply});
              console.log(`[ZCA reply] → ${fromName}: ${reply.slice(0,60)}`);
            }catch(se){ console.error('[ZCA send]',se.message); }
            // Lưu reply vào contacts
            contact.msgs.push({from:'bot',t:reply,time:new Date().toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'})});
            broadcast({type:'bot_reply',platform:'zalo',to:fromId,toName:fromName,content:reply,timestamp:Date.now()});
          }
        }catch(me){ console.error('[msg handler]',me.message); }
      });
    });

    stream.on('error',e=>{
      console.error('[ZCA stream error]',e.message);
      sendTo({type:'login_failed',message:e.message});
    });

  }catch(e){
    console.error('[create-qr]',e.message);
    const sess=sessions.get(sessionId);
    const ws2=sess?.ws;
    if(ws2?.readyState===WebSocket.OPEN) ws2.send(JSON.stringify({type:'login_failed',message:e.message}));
  }
});

// ── API: Lấy danh sách contacts/conversations ────────────────
app.get('/api/zalo/contacts',(req,res)=>{
  const list=Array.from(contacts.entries()).map(([uid,c])=>({uid,...c,msgs:undefined}));
  res.json({ok:true,data:list.sort((a,b)=>b.lastTime-a.lastTime)});
});

// ── API: Lấy tin nhắn của 1 contact ─────────────────────────
app.get('/api/zalo/messages/:uid',(req,res)=>{
  const c=contacts.get(req.params.uid);
  if(!c){ res.json({ok:false,data:[]}); return; }
  c.unread=0;
  res.json({ok:true,data:c.msgs||[]});
});

// ── API: Gửi tin nhắn thủ công ──────────────────────────────
app.post('/api/zalo/send',async(req,res)=>{
  const{sessionId,to,text}=req.body||{};
  const sess=sessions.get(sessionId);
  if(!sess?.zalo){ res.json({ok:false,error:'Chưa đăng nhập Zalo'}); return; }
  try{
    await sess.zalo.sendMessage({to,text});
    // Lưu tin nhắn thủ công
    const c=getContact(to);
    c.msgs.push({from:'human',t:text,time:new Date().toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'})});
    broadcast({type:'human_reply',platform:'zalo',to,content:text,timestamp:Date.now()});
    res.json({ok:true});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

// ── API: Cập nhật Gemini key từ frontend ─────────────────────
app.post('/api/set-gemini-key',(req,res)=>{
  const{key}=req.body||{};
  if(key&&key.length>10){
    RUNTIME_KEY=key;
    console.log('[LP] ✅ Gemini key updated from frontend');
    res.json({ok:true,message:'Gemini key đã được cập nhật'});
  } else {
    res.json({ok:false,error:'Key không hợp lệ'});
  }
});

// ── API: Status tổng hợp ─────────────────────────────────────
app.get('/health',(req,res)=>{
  res.json({
    status:'ok', version:'v4',
    uptime: Math.floor(process.uptime())+'s',
    ws_clients: wsClients.size,
    sessions: sessions.size,
    contacts: contacts.size,
    ai_ready: !!RUNTIME_KEY,
    zca_ready: !!ZaloClass,
    time: new Date().toISOString()
  });
});

app.get('/',(req,res)=>res.send('LPA Backend v4 ✅'));

// ── START ─────────────────────────────────────────────────────
server.listen(PORT,()=>{
  console.log(`\n🚀 LPA Backend v4 — port ${PORT}`);
  console.log(`   Gemini AI: ${RUNTIME_KEY?'✅ Ready':'⚠️  Chưa có key (nhập từ frontend)'}`);
  console.log(`   ZCA-JS:    loading...`);
  console.log(`   WS:        ws://localhost:${PORT}?sid=YOUR_SID`);
  console.log(`   Health:    http://localhost:${PORT}/health\n`);
});
