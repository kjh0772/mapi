/**
 * MAPI UI - 대시보드(설정/모니터링/테스트) + 내장 에코 클라이언트
 *
 * 실행: cd mapi_ui && npm start
 * 접속: http://localhost:3000
 */

const express = require('express');
const mqtt = require('mqtt');

const app = express();
app.use(express.json());

// ── 상태 ──
let mqttClient = null;
let httpServer = null;
let config = {
  port: parseInt(process.env.PORT) || 3800,
  brokerUrl: process.env.BROKER_URL || 'mqtt://mqtt.hdeng.net:1883',
  topicPrefix: process.env.TOPIC_PREFIX || 'mapi',
  username: process.env.MQTT_USER || 'smart',
  password: process.env.MQTT_PASS || 'korea'
};
const devices = new Map();
const pending = new Map();
const sseClients = [];
const msgLog = [];          // 최근 메시지 로그 (최대 200건)

function addLog(type, data) {
  const entry = { type, ...data, ts: new Date().toISOString() };
  msgLog.push(entry);
  if (msgLog.length > 200) msgLog.shift();
  broadcast('log', entry);
}

// ── MQTT 연결 관리 ──
function connectMqtt() {
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }
  devices.clear();
  broadcast('devices', []);
  broadcast('mqtt', { connected: false, info: '연결 중...' });

  mqttClient = mqtt.connect(config.brokerUrl, {
    username: config.username,
    password: config.password,
    connectTimeout: 10000,
    reconnectPeriod: 5000
  });

  mqttClient.on('connect', () => {
    const info = `${config.brokerUrl} 연결됨`;
    console.log(`[MQTT] ${info}`);
    broadcast('mqtt', { connected: true, info });
    addLog('system', { message: `MQTT 브로커 연결: ${config.brokerUrl}` });
    mqttClient.subscribe(`${config.topicPrefix}/+/res`, { qos: 1 });
    mqttClient.subscribe(`${config.topicPrefix}/+/status`, { qos: 0 });
  });

  mqttClient.on('close', () => {
    broadcast('mqtt', { connected: false, info: '연결 끊김' });
  });

  mqttClient.on('error', (err) => {
    broadcast('mqtt', { connected: false, info: `오류: ${err.message}` });
    addLog('error', { message: err.message });
  });

  mqttClient.on('message', (topic, payload) => {
    const [, deviceId, type] = topic.split('/');
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; }

    if (type === 'status') {
      const state = { online: msg.online, lastSeen: new Date().toISOString() };
      devices.set(deviceId, state);
      broadcast('status', { deviceId, ...state });
      addLog('status', { deviceId, online: msg.online });
    } else if (type === 'res') {
      const p = pending.get(msg.requestId);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.requestId);
        p.resolve(msg);
      }
      broadcast('response', { deviceId, ...msg });
      addLog('res', { deviceId, requestId: msg.requestId, success: msg.success });
    }
  });
}

function sendCommand(deviceId, action, params = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || !mqttClient.connected) return reject(new Error('MQTT 미연결'));
    const requestId = `${deviceId}-${Date.now()}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('응답 시간 초과'));
    }, timeout);
    pending.set(requestId, { resolve, timer });
    const payload = JSON.stringify({ requestId, action, params });
    mqttClient.publish(`${config.topicPrefix}/${deviceId}/cmd`, payload, { qos: 1 });
    addLog('cmd', { deviceId, action, requestId });
  });
}

// ── SSE ──
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
app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', (req, res) => {
  const { port, brokerUrl, topicPrefix, username, password } = req.body;
  const newPort = port ? parseInt(port) : null;
  const portChanged = newPort && newPort !== config.port;
  if (newPort) config.port = newPort;
  if (brokerUrl) config.brokerUrl = brokerUrl;
  if (topicPrefix) config.topicPrefix = topicPrefix;
  if (username !== undefined) config.username = username;
  if (password !== undefined) config.password = password;
  connectMqtt();
  connectEchoClient();
  res.json({ ok: true, config });
  if (portChanged) {
    setTimeout(() => {
      httpServer.close(() => {
        httpServer = app.listen(config.port, () => {
          console.log(`[MAPI UI] 포트 변경: ${config.port}`);
        });
      });
    }, 500);
  }
});

app.get('/api/devices', (req, res) => res.json(Object.fromEntries(devices)));

app.get('/api/log', (req, res) => res.json(msgLog.slice(-50)));

app.post('/api/send', async (req, res) => {
  const { deviceId, action, params } = req.body;
  try {
    const result = await sendCommand(deviceId, action || 'echo', params || {});
    res.json(result);
  } catch (e) {
    res.status(504).json({ success: false, error: e.message });
  }
});

// ── HTML ──
app.get('/', (req, res) => res.send(HTML));

const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MAPI 대시보드</title>
<style>
  :root { --bg: #0f172a; --surface: #1e293b; --border: #334155; --card: #334155; --text: #e2e8f0; --muted: #94a3b8; --blue: #2563eb; --green: #22c55e; --red: #ef4444; --yellow: #eab308; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }

  /* 헤더 */
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 24px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .topbar h1 { font-size: 18px; font-weight: 700; }
  .topbar .badge { padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge.on { background: #064e3b; color: var(--green); }
  .badge.off { background: #450a0a; color: var(--red); }

  /* 탭 */
  .tabs { display: flex; gap: 0; background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 24px; }
  .tab { padding: 10px 20px; cursor: pointer; font-size: 13px; color: var(--muted); border-bottom: 2px solid transparent; transition: all 0.2s; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--blue); border-bottom-color: var(--blue); }

  /* 패널 */
  .panels { padding: 20px 24px; }
  .panel { display: none; }
  .panel.active { display: block; }

  /* 설정 */
  .config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 700px; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .field input { width: 100%; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 14px; outline: none; }
  .field input:focus { border-color: var(--blue); }
  .field.full { grid-column: 1 / -1; }
  .btn { padding: 10px 24px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
  .btn-primary { background: var(--blue); color: white; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-sm { padding: 6px 14px; font-size: 12px; }
  .config-actions { margin-top: 16px; display: flex; gap: 8px; align-items: center; }
  .config-msg { font-size: 13px; color: var(--green); }

  /* 모니터링 */
  .monitor-grid { display: grid; grid-template-columns: 280px 1fr; gap: 20px; height: calc(100vh - 140px); }
  .stat-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .stat-card { background: var(--card); border-radius: 8px; padding: 14px; }
  .stat-card .label { font-size: 11px; color: var(--muted); text-transform: uppercase; }
  .stat-card .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .stat-card .value.blue { color: #38bdf8; }
  .stat-card .value.green { color: var(--green); }
  .stat-card .value.red { color: var(--red); }
  .stat-card .value.yellow { color: var(--yellow); }

  .device-panel h3 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
  .device-item { background: var(--card); border-radius: 8px; padding: 12px; margin-bottom: 8px; border-left: 3px solid var(--border); }
  .device-item.online { border-left-color: var(--green); }
  .device-item .name { font-weight: 600; font-size: 14px; }
  .device-item .meta { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .no-device { color: var(--muted); font-size: 13px; padding: 20px 0; text-align: center; }

  /* 로그 */
  .log-panel { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; height: 100%; display: flex; flex-direction: column; }
  .log-header { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .log-header h3 { font-size: 13px; color: var(--muted); text-transform: uppercase; }
  .log-body { flex: 1; overflow-y: auto; padding: 8px 14px; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 12px; line-height: 1.8; }
  .log-entry { display: flex; gap: 8px; }
  .log-entry .ts { color: #475569; min-width: 80px; }
  .log-entry .tag { min-width: 44px; font-weight: 600; }
  .tag-cmd { color: #38bdf8; }
  .tag-res { color: var(--green); }
  .tag-status { color: var(--yellow); }
  .tag-error { color: var(--red); }
  .tag-system { color: #a78bfa; }
  .log-entry .body { color: var(--muted); }

  /* 테스트 */
  .test-area { max-width: 700px; }
  .test-row { display: grid; grid-template-columns: 160px 160px 1fr auto; gap: 10px; align-items: end; }
  .test-params { margin-top: 12px; }
  .test-params textarea { width: 100%; height: 60px; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-family: monospace; font-size: 13px; outline: none; resize: vertical; }
  .test-params textarea:focus { border-color: var(--blue); }
  .test-result { margin-top: 16px; background: var(--card); border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; }

  /* 채팅 */
  .chat-area { max-width: 700px; display: flex; flex-direction: column; height: calc(100vh - 180px); }
  .chat-messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 16px 0; }
  .chat-msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; }
  .chat-msg.sent { align-self: flex-end; background: var(--blue); border-bottom-right-radius: 4px; }
  .chat-msg.recv { align-self: flex-start; background: var(--card); border-bottom-left-radius: 4px; }
  .chat-msg.error { align-self: flex-start; background: #7f1d1d; }
  .chat-msg .time { font-size: 10px; color: var(--muted); margin-top: 4px; }
  .chat-input { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
  .chat-input input { flex: 1; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 14px; outline: none; }
  .chat-input input:focus { border-color: var(--blue); }
  .chat-did { width: 130px; flex: none; }
</style>
</head>
<body>

<!-- 헤더 -->
<div class="topbar">
  <h1>MAPI Dashboard</h1>
  <span class="badge off" id="mqttBadge">MQTT 연결 중...</span>
</div>

<!-- 탭 -->
<div class="tabs">
  <div class="tab active" onclick="switchTab('monitor')">모니터링</div>
  <div class="tab" onclick="switchTab('config')">설정</div>
  <div class="tab" onclick="switchTab('test')">명령 테스트</div>
  <div class="tab" onclick="switchTab('chat')">채팅 에코</div>
</div>

<!-- 패널: 모니터링 -->
<div class="panels">
<div class="panel active" id="panel-monitor">
  <div class="monitor-grid">
    <div class="device-panel">
      <div class="stat-cards">
        <div class="stat-card"><div class="label">전송</div><div class="value blue" id="sCnt">0</div></div>
        <div class="stat-card"><div class="label">응답</div><div class="value green" id="rCnt">0</div></div>
        <div class="stat-card"><div class="label">실패</div><div class="value red" id="fCnt">0</div></div>
        <div class="stat-card"><div class="label">평균 응답</div><div class="value yellow" id="aMs">-</div></div>
      </div>
      <h3>장비 목록</h3>
      <div id="deviceList"><div class="no-device">장비 대기 중...</div></div>
    </div>
    <div class="log-panel">
      <div class="log-header"><h3>실시간 로그</h3><button class="btn btn-sm btn-primary" onclick="clearLog()">지우기</button></div>
      <div class="log-body" id="logBody"></div>
    </div>
  </div>
</div>

<!-- 패널: 설정 -->
<div class="panel" id="panel-config">
  <div class="config-grid">
    <div class="field">
      <label>MQTT 브로커 URL</label>
      <input id="cfgBroker" placeholder="mqtt://host:port">
    </div>
    <div class="field">
      <label>웹 서버 포트</label>
      <input id="cfgPort" type="number" placeholder="3800">
    </div>
    <div class="field">
      <label>토픽 Prefix</label>
      <input id="cfgPrefix" placeholder="mapi">
    </div>
    <div class="field">
      <label>Username</label>
      <input id="cfgUser" placeholder="smart">
    </div>
    <div class="field">
      <label>Password</label>
      <input id="cfgPass" type="password" placeholder="korea">
    </div>
  </div>
  <div class="config-actions">
    <button class="btn btn-primary" onclick="saveConfig()">연결 / 저장</button>
    <span class="config-msg" id="cfgMsg"></span>
  </div>
</div>

<!-- 패널: 명령 테스트 -->
<div class="panel" id="panel-test">
  <div class="test-area">
    <div class="test-row">
      <div class="field"><label>장비 ID</label><input id="testDid" value="server-001"></div>
      <div class="field"><label>Action</label><input id="testAction" value="api"></div>
      <div class="field"><label>Params (JSON)</label><input id="testParams" value='{"method":"GET","path":"/"}'>
      </div>
      <button class="btn btn-primary" onclick="sendTest()" id="testBtn">전송</button>
    </div>
    <div id="testResult"></div>
  </div>
</div>

<!-- 패널: 채팅 에코 -->
<div class="panel" id="panel-chat">
  <div class="chat-area">
    <div class="chat-messages" id="chatMsgs"></div>
    <div class="chat-input">
      <input class="chat-did" id="chatDid" value="echo-001" placeholder="장비 ID">
      <input id="chatInput" placeholder="메시지를 입력하세요..." autofocus>
      <button class="btn btn-primary" onclick="sendChat()" id="chatBtn">전송</button>
    </div>
  </div>
</div>
</div>

<script>
// ── 탭 ──
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', t.textContent.includes({monitor:'모니터링',config:'설정',test:'명령',chat:'채팅'}[name])));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
}

// ── 상태 ──
const stats = { sent: 0, recv: 0, fail: 0, totalMs: 0 };
const deviceMap = {};

// ── SSE ──
const es = new EventSource('/events');
es.addEventListener('mqtt', e => {
  const d = JSON.parse(e.data);
  const b = document.getElementById('mqttBadge');
  b.className = 'badge ' + (d.connected ? 'on' : 'off');
  b.textContent = d.connected ? 'MQTT 연결됨' : d.info;
});
es.addEventListener('status', e => {
  const d = JSON.parse(e.data);
  deviceMap[d.deviceId] = d;
  renderDevices();
});
es.addEventListener('log', e => {
  const d = JSON.parse(e.data);
  appendLog(d);
});
es.addEventListener('devices', e => { Object.keys(deviceMap).forEach(k => delete deviceMap[k]); renderDevices(); });

// ── 장비 목록 ──
function renderDevices() {
  const el = document.getElementById('deviceList');
  const ids = Object.keys(deviceMap);
  if (!ids.length) { el.innerHTML = '<div class="no-device">장비 대기 중...</div>'; return; }
  el.innerHTML = ids.map(id => {
    const d = deviceMap[id];
    return '<div class="device-item ' + (d.online ? 'online' : '') + '">' +
      '<div class="name">' + id + '</div>' +
      '<div class="meta">' + (d.online ? '온라인' : '오프라인') + ' &middot; ' +
      new Date(d.lastSeen).toLocaleTimeString() + '</div></div>';
  }).join('');
}

// ── 로그 ──
function appendLog(d) {
  const el = document.getElementById('logBody');
  const ts = new Date(d.ts).toLocaleTimeString();
  const tag = d.type;
  let body = '';
  if (tag === 'cmd') body = d.deviceId + ' ← ' + d.action + ' [' + d.requestId + ']';
  else if (tag === 'res') body = d.deviceId + ' → ' + (d.success ? 'OK' : 'FAIL') + ' [' + d.requestId + ']';
  else if (tag === 'status') body = d.deviceId + ' ' + (d.online ? '온라인' : '오프라인');
  else body = d.message || '';
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = '<span class="ts">' + ts + '</span><span class="tag tag-' + tag + '">' + tag.toUpperCase() + '</span><span class="body">' + body + '</span>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function clearLog() { document.getElementById('logBody').innerHTML = ''; }

// ── 통계 ──
function updateStats() {
  document.getElementById('sCnt').textContent = stats.sent;
  document.getElementById('rCnt').textContent = stats.recv;
  document.getElementById('fCnt').textContent = stats.fail;
  document.getElementById('aMs').textContent = stats.recv ? Math.round(stats.totalMs / stats.recv) + 'ms' : '-';
}

// ── 설정 ──
fetch('/api/config').then(r => r.json()).then(c => {
  document.getElementById('cfgPort').value = c.port;
  document.getElementById('cfgBroker').value = c.brokerUrl;
  document.getElementById('cfgPrefix').value = c.topicPrefix;
  document.getElementById('cfgUser').value = c.username;
  document.getElementById('cfgPass').value = c.password;
});

function saveConfig() {
  const newPort = document.getElementById('cfgPort').value;
  const body = {
    port: newPort,
    brokerUrl: document.getElementById('cfgBroker').value,
    topicPrefix: document.getElementById('cfgPrefix').value,
    username: document.getElementById('cfgUser').value,
    password: document.getElementById('cfgPass').value
  };
  const portChanged = newPort != location.port;
  fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
    .then(r => r.json()).then(() => {
      if (portChanged) {
        document.getElementById('cfgMsg').textContent = '포트 변경됨, 새 주소로 이동 중...';
        setTimeout(() => { location.href = location.protocol + '//' + location.hostname + ':' + newPort; }, 2000);
      } else {
        document.getElementById('cfgMsg').textContent = '저장 완료, 재연결 중...';
        setTimeout(() => document.getElementById('cfgMsg').textContent = '', 3000);
      }
    });
}

// ── 명령 테스트 ──
async function sendTest() {
  const did = document.getElementById('testDid').value.trim();
  const action = document.getElementById('testAction').value.trim();
  let params;
  try { params = JSON.parse(document.getElementById('testParams').value || '{}'); } catch { params = {}; }
  document.getElementById('testBtn').disabled = true;
  stats.sent++; updateStats();
  const t0 = Date.now();
  try {
    const res = await fetch('/api/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ deviceId: did, action, params }) });
    const data = await res.json();
    const ms = Date.now() - t0;
    if (data.success !== false) { stats.recv++; stats.totalMs += ms; }
    else stats.fail++;
    document.getElementById('testResult').innerHTML = '<div class="test-result">' + JSON.stringify(data, null, 2) + '\\n\\n응답시간: ' + ms + 'ms</div>';
  } catch (e) {
    stats.fail++;
    document.getElementById('testResult').innerHTML = '<div class="test-result" style="color:var(--red)">오류: ' + e.message + '</div>';
  }
  document.getElementById('testBtn').disabled = false;
  updateStats();
}

// ── 채팅 에코 ──
async function sendChat() {
  const msg = document.getElementById('chatInput').value.trim();
  const did = document.getElementById('chatDid').value.trim();
  if (!msg || !did) return;
  document.getElementById('chatInput').value = '';
  addChat(msg, 'sent');
  document.getElementById('chatBtn').disabled = true;
  stats.sent++; updateStats();
  const t0 = Date.now();
  try {
    const res = await fetch('/api/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ deviceId: did, action: 'echo', params: { message: msg } }) });
    const data = await res.json();
    const ms = Date.now() - t0;
    if (data.success) { addChat(data.data.echo, 'recv', ms); stats.recv++; stats.totalMs += ms; }
    else { addChat('오류: ' + (data.error || ''), 'error'); stats.fail++; }
  } catch (e) { addChat('전송 실패: ' + e.message, 'error'); stats.fail++; }
  document.getElementById('chatBtn').disabled = false;
  updateStats();
  document.getElementById('chatInput').focus();
}

function addChat(text, type, ms) {
  const el = document.createElement('div');
  el.className = 'chat-msg ' + type;
  el.innerHTML = text + '<div class="time">' + new Date().toLocaleTimeString() + (ms ? ' &middot; ' + ms + 'ms' : '') + '</div>';
  const c = document.getElementById('chatMsgs');
  c.appendChild(el); c.scrollTop = c.scrollHeight;
}

document.getElementById('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

// ── 초기 로그/장비 로드 ──
fetch('/api/log').then(r => r.json()).then(logs => logs.forEach(appendLog));
fetch('/api/devices').then(r => r.json()).then(data => {
  Object.entries(data).forEach(([id, d]) => { deviceMap[id] = d; });
  renderDevices();
});
</script>
</body>
</html>`;

// ── 내장 에코 클라이언트 ──
const DEVICE_ID = process.env.DEVICE_ID || 'echo-001';
let echoClient = null;

function connectEchoClient() {
  if (echoClient) { echoClient.end(true); echoClient = null; }

  echoClient = mqtt.connect(config.brokerUrl, {
    username: config.username,
    password: config.password,
    clientId: `mapi-echo-${DEVICE_ID}`,
    will: {
      topic: `${config.topicPrefix}/${DEVICE_ID}/status`,
      payload: JSON.stringify({ online: false, timestamp: new Date().toISOString() }),
      qos: 0, retain: true
    }
  });

  echoClient.on('connect', () => {
    console.log(`[Echo Client] ${DEVICE_ID} 연결 완료`);
    echoClient.subscribe(`${config.topicPrefix}/${DEVICE_ID}/cmd`, { qos: 1 });
    echoClient.publish(`${config.topicPrefix}/${DEVICE_ID}/status`,
      JSON.stringify({ online: true, timestamp: new Date().toISOString() }), { qos: 0 });
  });

  echoClient.on('message', (topic, payload) => {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    const { requestId, action, params } = msg;
    let result;
    if (action === 'echo') {
      result = { requestId, success: true, data: { echo: `[에코] ${params.message}` } };
    } else if (action === 'getData') {
      result = { requestId, success: true, data: { value: (20 + Math.random() * 10).toFixed(1), unit: '°C' } };
    } else {
      result = { requestId, success: false, error: `알 수 없는 명령: ${action}` };
    }
    echoClient.publish(`${config.topicPrefix}/${DEVICE_ID}/res`, JSON.stringify(result), { qos: 1 });
  });
}

// ── 서버 시작 ──
httpServer = app.listen(config.port, () => {
  console.log(`[MAPI UI] http://localhost:${config.port}`);
  console.log(`[MAPI UI] 내장 에코 클라이언트: ${DEVICE_ID}`);
  connectMqtt();
  connectEchoClient();
});
