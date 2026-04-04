/**
 * MAPI Server - MQTT 기반 다중 장비 관리 서버
 *
 * 토픽 구조:
 *   mapi/{deviceId}/cmd    - 서버 → 장비 (명령 전송)
 *   mapi/{deviceId}/res    - 장비 → 서버 (응답 수신)
 *   mapi/{deviceId}/status - 장비 → 서버 (온라인/오프라인)
 */

const mqtt = require('mqtt');

const BROKER_URL = process.env.BROKER_URL || 'mqtt://mqtt.hdeng.net:1883';
const TOPIC_PREFIX = process.env.TOPIC_PREFIX || 'mapi';

// 연결된 장비 목록 { deviceId: { online, lastSeen, ... } }
const devices = new Map();

// 명령 응답 대기 콜백 { requestId: { resolve, timer } }
const pending = new Map();

const client = mqtt.connect(BROKER_URL, {
  username: process.env.MQTT_USER || 'smart',
  password: process.env.MQTT_PASS || 'korea'
});

// ── 연결 ──
client.on('connect', () => {
  console.log('[MAPI Server] MQTT 브로커 연결 완료');
  // 응답 구독 (QoS 1: 유실 방지), 상태 구독 (QoS 0: 센서값 수준)
  client.subscribe(`${TOPIC_PREFIX}/+/res`, { qos: 1 });
  client.subscribe(`${TOPIC_PREFIX}/+/status`, { qos: 0 });
});

// ── 메시지 수신 ──
client.on('message', (topic, payload) => {
  const parts = topic.split('/');
  const deviceId = parts[1];
  const type = parts[2]; // res | status

  let msg;
  try { msg = JSON.parse(payload.toString()); } catch { return; }

  if (type === 'status') {
    handleStatus(deviceId, msg);
  } else if (type === 'res') {
    handleResponse(deviceId, msg);
  }
});

// ── 장비 상태 처리 ──
function handleStatus(deviceId, msg) {
  const prev = devices.get(deviceId);
  devices.set(deviceId, { online: msg.online, lastSeen: new Date() });
  console.log(`[장비 ${deviceId}] ${msg.online ? '온라인' : '오프라인'}`);
}

// ── 응답 처리 ──
function handleResponse(deviceId, msg) {
  console.log(`[장비 ${deviceId}] 응답:`, msg);
  const p = pending.get(msg.requestId);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(msg.requestId);
    p.resolve(msg);
  }
}

// ── 명령 전송 (Promise 기반) ──
function sendCommand(deviceId, action, params = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = `${deviceId}-${Date.now()}`;
    const message = JSON.stringify({ requestId, action, params });

    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`[장비 ${deviceId}] 응답 시간 초과 (${action})`));
    }, timeout);

    pending.set(requestId, { resolve, timer });
    client.publish(`${TOPIC_PREFIX}/${deviceId}/cmd`, message, { qos: 1 });
    console.log(`[장비 ${deviceId}] 명령 전송: ${action}`);
  });
}

// ── 장비 목록 조회 ──
function getDevices() {
  return Object.fromEntries(devices);
}

// ── API: 외부에서 사용할 인터페이스 ──
module.exports = { sendCommand, getDevices, client, devices };

// ── 직접 실행 시 데모 ──
if (require.main === module) {
  // 예시: 5초 후 'sensor-001' 장비에 데이터 요청
  setTimeout(async () => {
    try {
      const res = await sendCommand('sensor-001', 'getData', { type: 'temperature' });
      console.log('결과:', res);
    } catch (e) {
      console.error(e.message);
    }
  }, 5000);
}
