/**
 * MAPI 테스트 - 채팅 에코 웹 + 모니터링 UI
 *
 * 구조:
 *   브라우저 → HTTP POST /send → MQTT cmd → mapiclient(에코) → MQTT res → SSE → 브라우저
 *
 * 실행 순서:
 *   1. cd mapitest && npm start          (이 파일)
 *   2. cd client && DEVICE_ID=echo-001 node mapiclient.js  (에코 클라이언트)
 *   3. 브라우저에서 http://localhost:3000 접속
 */

const express = require('express');
const mqtt = require('mqtt');

const app = express();
app.use(express.json());

const BROKER_URL = process.env.BROKER_URL || 'mqtt://mqtt.hdeng.net:1883';
const TOPIC_PREFIX = process.env.TOPIC_PREFIX || 'mapi';
const PORT = process.env.PORT || 3000;

// ── MQTT 연결 ──
const client = mqtt.connect(BROKER_URL, {
  username: process.env.MQTT_USER || 'smart',
  password: process.env.MQTT_PASS || 'korea'
});

const devices = new Map();   // deviceId → { online, lastSeen }
const pending = new Map();   // requestId → { resolve, timer }
const sseClients = [];       // SSE 연결된 브라우저들

client.on('connect', () => {
  console.log('[MAPI Test] MQTT 브로커 연결 완료');
  client.subscribe(`${TOPIC_PREFIX}/+/res`, { qos: 1 });
  client.subscribe(`${TOPIC_PREFIX}/+/status`, { qos: 0 });
});

client.on('message', (topic, payload) => {
  const [, deviceId, type] = topic.split('/');
  let msg;
  try { msg = JSON.parse(payload.toString()); } catch { return; }

  if (type === 'status') {
    devices.set(deviceId, { online: msg.online, lastSeen: new Date().toISOString() });
    broadcast('status', { deviceId, ...msg, lastSeen: new Date().toISOString() });
  } else if (type === 'res') {
    const p = pending.get(msg.requestId);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.requestId);
      p.resolve(msg);
    }
    broadcast('response', { deviceId, ...msg });
  }
});

function sendCommand(deviceId, action, params = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = `${deviceId}-${Date.now()}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('응답 시간 초과'));
    }, timeout);
    pending.set(requestId, { resolve, timer });
    client.publish(`${TOPIC_PREFIX}/${deviceId}/cmd`, JSON.stringify({ requestId, action, params }), { qos: 1 });
  });
}

// ── SSE: 실시간 이벤트 스트림 ──
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => sseClients.splice(sseClients.indexOf(res), 1));
});

// ── API ──
app.post('/send', async (req, res) => {
  const { deviceId, message } = req.body;
  try {
    const result = await sendCommand(deviceId, 'echo', { message });
    res.json(result);
  } catch (e) {
    res.status(504).json({ success: false, error: e.message });
  }
});

app.get('/devices', (req, res) => {
  res.json(Object.fromEntries(devices));
});

// ── HTML UI ──
app.get('/', (req, res) => {
  res.send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MAPI 테스트</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; height: 100vh; display: flex; }

  /* 사이드바 - 모니터링 */
  .sidebar {
    width: 280px; background: #1e293b; padding: 20px; display: flex; flex-direction: column;
    border-right: 1px solid #334155;
  }
  .sidebar h2 { font-size: 14px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; }
  .mqtt-status { padding: 10px; border-radius: 8px; background: #334155; margin-bottom: 16px; font-size: 13px; }
  .mqtt-status .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .mqtt-status .dot.on { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
  .mqtt-status .dot.off { background: #ef4444; }
  .device-list { flex: 1; overflow-y: auto; }
  .device-card {
    background: #334155; border-radius: 8px; padding: 12px; margin-bottom: 8px; font-size: 13px;
    border-left: 3px solid #64748b; transition: border-color 0.3s;
  }
  .device-card.online { border-left-color: #22c55e; }
  .device-card .name { font-weight: 600; color: #f1f5f9; }
  .device-card .meta { color: #94a3b8; font-size: 11px; margin-top: 4px; }
  .stats { background: #334155; border-radius: 8px; padding: 12px; margin-top: 12px; font-size: 13px; }
  .stats div { display: flex; justify-content: space-between; padding: 4px 0; }
  .stats .val { color: #38bdf8; font-weight: 600; }

  /* 메인 - 채팅 */
  .main { flex: 1; display: flex; flex-direction: column; }
  .header { padding: 16px 24px; background: #1e293b; border-bottom: 1px solid #334155; }
  .header h1 { font-size: 18px; }
  .header p { font-size: 12px; color: #94a3b8; }
  .messages { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 70%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; }
  .msg.sent { align-self: flex-end; background: #2563eb; border-bottom-right-radius: 4px; }
  .msg.recv { align-self: flex-start; background: #334155; border-bottom-left-radius: 4px; }
  .msg .time { font-size: 10px; color: #94a3b8; margin-top: 4px; }
  .msg.error { background: #7f1d1d; }
  .input-bar {
    padding: 16px 24px; background: #1e293b; border-top: 1px solid #334155;
    display: flex; gap: 8px; align-items: center;
  }
  .input-bar input[type=text] {
    flex: 1; background: #0f172a; border: 1px solid #334155; border-radius: 8px;
    padding: 10px 14px; color: #e2e8f0; font-size: 14px; outline: none;
  }
  .input-bar input[type=text]:focus { border-color: #2563eb; }
  .input-bar .device-input { width: 130px; flex: none; }
  .input-bar button {
    background: #2563eb; color: white; border: none; border-radius: 8px;
    padding: 10px 20px; cursor: pointer; font-size: 14px; font-weight: 600;
  }
  .input-bar button:hover { background: #1d4ed8; }
  .input-bar button:disabled { background: #334155; cursor: not-allowed; }

  .log { padding: 12px 24px; background: #0c0f1a; max-height: 120px; overflow-y: auto; font-family: monospace; font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; }
  .log div { padding: 1px 0; }
  .log .ts { color: #475569; }
</style>
</head>
<body>

<!-- 사이드바: 모니터링 -->
<div class="sidebar">
  <h2>모니터링</h2>
  <div class="mqtt-status">
    <span class="dot off" id="mqttDot"></span>
    <span id="mqttLabel">연결 중...</span>
  </div>

  <h2>장비 목록</h2>
  <div class="device-list" id="deviceList">
    <div style="color:#64748b; font-size:13px;">장비 연결 대기 중...</div>
  </div>

  <div class="stats">
    <h2 style="margin-bottom:8px;">통계</h2>
    <div><span>전송</span><span class="val" id="statSent">0</span></div>
    <div><span>응답</span><span class="val" id="statRecv">0</span></div>
    <div><span>실패</span><span class="val" id="statFail">0</span></div>
    <div><span>평균 응답시간</span><span class="val" id="statAvg">-</span></div>
  </div>
</div>

<!-- 메인: 채팅 -->
<div class="main">
  <div class="header">
    <h1>MAPI 채팅 에코 테스트</h1>
    <p>메시지를 보내면 장비(mapiclient)가 에코 응답합니다</p>
  </div>

  <div class="messages" id="messages"></div>

  <div class="input-bar">
    <input type="text" class="device-input" id="deviceId" value="echo-001" placeholder="장비 ID">
    <input type="text" id="msgInput" placeholder="메시지를 입력하세요..." autofocus>
    <button id="sendBtn" onclick="send()">전송</button>
  </div>

  <div class="log" id="log"></div>
</div>

<script>
  const messages = document.getElementById('messages');
  const msgInput = document.getElementById('msgInput');
  const deviceId = document.getElementById('deviceId');
  const sendBtn = document.getElementById('sendBtn');
  const logEl = document.getElementById('log');

  let stats = { sent: 0, recv: 0, fail: 0, totalMs: 0 };
  const deviceMap = {};

  // SSE 실시간 이벤트
  const es = new EventSource('/events');
  es.onopen = () => {
    document.getElementById('mqttDot').className = 'dot on';
    document.getElementById('mqttLabel').textContent = 'SSE 연결됨';
    log('SSE 스트림 연결');
  };
  es.onerror = () => {
    document.getElementById('mqttDot').className = 'dot off';
    document.getElementById('mqttLabel').textContent = '연결 끊김';
  };
  es.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    deviceMap[d.deviceId] = d;
    renderDevices();
    log('장비 상태: ' + d.deviceId + ' → ' + (d.online ? '온라인' : '오프라인'));
  });
  es.addEventListener('response', (e) => {
    const d = JSON.parse(e.data);
    log('MQTT 응답 수신: ' + d.deviceId + ' [' + d.requestId + ']');
  });

  // 장비 목록 렌더링
  function renderDevices() {
    const el = document.getElementById('deviceList');
    const ids = Object.keys(deviceMap);
    if (ids.length === 0) { el.innerHTML = '<div style="color:#64748b;font-size:13px;">장비 연결 대기 중...</div>'; return; }
    el.innerHTML = ids.map(id => {
      const d = deviceMap[id];
      const on = d.online;
      const ts = d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : '-';
      return '<div class="device-card ' + (on ? 'online' : '') + '">' +
        '<div class="name">' + id + '</div>' +
        '<div class="meta">' + (on ? '온라인' : '오프라인') + ' · ' + ts + '</div></div>';
    }).join('');
  }

  // 통계 갱신
  function updateStats() {
    document.getElementById('statSent').textContent = stats.sent;
    document.getElementById('statRecv').textContent = stats.recv;
    document.getElementById('statFail').textContent = stats.fail;
    document.getElementById('statAvg').textContent = stats.recv > 0 ? Math.round(stats.totalMs / stats.recv) + 'ms' : '-';
  }

  // 메시지 전송
  async function send() {
    const msg = msgInput.value.trim();
    const did = deviceId.value.trim();
    if (!msg || !did) return;

    msgInput.value = '';
    addMsg(msg, 'sent');
    sendBtn.disabled = true;
    stats.sent++;
    updateStats();
    const t0 = Date.now();
    log('전송: [' + did + '] ' + msg);

    try {
      const res = await fetch('/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: did, message: msg })
      });
      const data = await res.json();
      const ms = Date.now() - t0;

      if (data.success) {
        addMsg(data.data.echo, 'recv', ms);
        stats.recv++;
        stats.totalMs += ms;
        log('응답 (' + ms + 'ms): ' + data.data.echo);
      } else {
        addMsg('오류: ' + (data.error || '알 수 없는 오류'), 'error');
        stats.fail++;
        log('실패: ' + (data.error || ''));
      }
    } catch (e) {
      addMsg('전송 실패: ' + e.message, 'error');
      stats.fail++;
      log('에러: ' + e.message);
    }
    sendBtn.disabled = false;
    updateStats();
    msgInput.focus();
  }

  function addMsg(text, type, ms) {
    const el = document.createElement('div');
    el.className = 'msg ' + (type === 'error' ? 'error' : type);
    const now = new Date().toLocaleTimeString();
    el.innerHTML = text + '<div class="time">' + now + (ms ? ' · ' + ms + 'ms' : '') + '</div>';
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  function log(text) {
    const el = document.createElement('div');
    el.innerHTML = '<span class="ts">[' + new Date().toLocaleTimeString() + ']</span> ' + text;
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
  }

  msgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  // 초기 장비 목록 로드
  fetch('/devices').then(r => r.json()).then(data => {
    Object.entries(data).forEach(([id, d]) => { deviceMap[id] = d; });
    renderDevices();
  });
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`[MAPI Test] http://localhost:${PORT} 에서 실행 중`);
  console.log('[MAPI Test] 에코 클라이언트 실행: cd ../client && DEVICE_ID=echo-001 node mapiclient.js');
});
