/**
 * MAPI Server - REST API → MQTT 브릿지
 *
 * 기존 HTTP API 서버(예: localhost:4000)를 MQTT로 래핑하여
 * 장비 IP 없이 MQTT만으로 API를 호출할 수 있게 합니다.
 *
 * 토픽 구조:
 *   mapi/{deviceId}/cmd    - 클라이언트 → 서버 (API 호출 요청)
 *   mapi/{deviceId}/res    - 서버 → 클라이언트 (API 응답)
 *   mapi/{deviceId}/status - 서버 상태 (온라인/오프라인)
 *
 * 명령 형식:
 *   action: "api"
 *   params: { method: "GET", path: "/api/xxx", body: {} }
 *
 * 환경변수:
 *   BROKER_URL   - MQTT 브로커 (기본: mqtt://mqtt.hdeng.net:1883)
 *   TOPIC_PREFIX - 토픽 네임스페이스 (기본: mapi)
 *   DEVICE_ID    - 이 서버의 장비 ID (기본: server-001)
 *   API_HOST     - 래핑 대상 API 호스트 (기본: localhost)
 *   API_PORT     - 래핑 대상 API 포트 (기본: 3000)
 *   MQTT_USER    - MQTT 인증 사용자 (기본: smart)
 *   MQTT_PASS    - MQTT 인증 비밀번호 (기본: korea)
 */

const mqtt = require('mqtt');
const http = require('http');

const BROKER_URL = process.env.BROKER_URL || 'mqtt://mqtt.hdeng.net:1883';
const TOPIC_PREFIX = process.env.TOPIC_PREFIX || 'mapi';
const DEVICE_ID = process.env.DEVICE_ID || 'server-001';
const API_HOST = process.env.API_HOST || 'localhost';
const API_PORT = parseInt(process.env.API_PORT) || 3000;

// ── MQTT 연결 ──
const client = mqtt.connect(BROKER_URL, {
  username: process.env.MQTT_USER || 'smart',
  password: process.env.MQTT_PASS || 'korea',
  will: {
    topic: `${TOPIC_PREFIX}/${DEVICE_ID}/status`,
    payload: JSON.stringify({ online: false, timestamp: new Date().toISOString() }),
    qos: 0, retain: true
  }
});

// 연결된 외부 클라이언트의 응답 대기 (서버가 직접 명령을 보낼 때)
const pending = new Map();

client.on('connect', () => {
  console.log(`[MAPI Server] MQTT 연결 완료 (${BROKER_URL})`);
  console.log(`[MAPI Server] API 대상: http://${API_HOST}:${API_PORT}`);
  console.log(`[MAPI Server] 장비 ID: ${DEVICE_ID}`);

  // 이 장비로 들어오는 명령 구독
  client.subscribe(`${TOPIC_PREFIX}/${DEVICE_ID}/cmd`, { qos: 1 });
  // 다른 장비의 응답 구독 (서버가 명령을 보낼 때)
  client.subscribe(`${TOPIC_PREFIX}/+/res`, { qos: 1 });
  client.subscribe(`${TOPIC_PREFIX}/+/status`, { qos: 0 });

  // 온라인 상태 발행
  client.publish(`${TOPIC_PREFIX}/${DEVICE_ID}/status`,
    JSON.stringify({ online: true, timestamp: new Date().toISOString() }), { qos: 0 });
});

// ── 메시지 수신 ──
client.on('message', (topic, payload) => {
  const [, deviceId, type] = topic.split('/');
  let msg;
  try { msg = JSON.parse(payload.toString()); } catch { return; }

  if (type === 'cmd' && deviceId === DEVICE_ID) {
    handleCommand(msg);
  } else if (type === 'res') {
    const p = pending.get(msg.requestId);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.requestId);
      p.resolve(msg);
    }
  } else if (type === 'status') {
    console.log(`[장비 ${deviceId}] ${msg.online ? '온라인' : '오프라인'}`);
  }
});

// ── 명령 처리: MQTT → HTTP API 호출 ──
async function handleCommand(msg) {
  const { requestId, action, params } = msg;

  if (action === 'api') {
    // REST API 프록시
    const { method = 'GET', path = '/', body } = params || {};
    console.log(`[API] ${method} ${path}`);

    try {
      const result = await httpRequest(method, path, body);
      client.publish(`${TOPIC_PREFIX}/${DEVICE_ID}/res`,
        JSON.stringify({ requestId, success: true, data: result }), { qos: 1 });
    } catch (e) {
      client.publish(`${TOPIC_PREFIX}/${DEVICE_ID}/res`,
        JSON.stringify({ requestId, success: false, error: e.message }), { qos: 1 });
    }
  } else if (action === 'ping') {
    client.publish(`${TOPIC_PREFIX}/${DEVICE_ID}/res`,
      JSON.stringify({ requestId, success: true, data: { pong: true, ts: Date.now() } }), { qos: 1 });
  } else {
    client.publish(`${TOPIC_PREFIX}/${DEVICE_ID}/res`,
      JSON.stringify({ requestId, success: false, error: `알 수 없는 action: ${action}` }), { qos: 1 });
  }
}

// ── HTTP 요청 헬퍼 ──
function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path,
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' }
    };
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('API 요청 시간 초과')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// ── 외부에서 다른 장비에 명령 보내기 ──
function sendCommand(deviceId, action, params = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = `${deviceId}-${Date.now()}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`응답 시간 초과 (${deviceId}/${action})`));
    }, timeout);
    pending.set(requestId, { resolve, timer });
    client.publish(`${TOPIC_PREFIX}/${deviceId}/cmd`,
      JSON.stringify({ requestId, action, params }), { qos: 1 });
  });
}

// ── 종료 시 오프라인 ──
process.on('SIGINT', () => {
  client.publish(`${TOPIC_PREFIX}/${DEVICE_ID}/status`,
    JSON.stringify({ online: false, timestamp: new Date().toISOString() }));
  setTimeout(() => process.exit(), 500);
});

module.exports = { sendCommand, client, DEVICE_ID };

if (require.main === module) {
  console.log('[MAPI Server] 시작됨 - MQTT 명령 대기 중...');
}
