/**
 * MAPI Client - MQTT 기반 장비/센서 클라이언트
 *
 * 사용법: DEVICE_ID=sensor-001 node mapiclient.js
 */

const mqtt = require('mqtt');

const BROKER_URL = process.env.BROKER_URL || 'mqtt://mqtt.hdeng.net:1883';
const TOPIC_PREFIX = process.env.TOPIC_PREFIX || 'mapi';
const DEVICE_ID = process.env.DEVICE_ID || 'sensor-001';

// LWT: 비정상 종료 시 브로커가 자동으로 오프라인 상태 발행
const client = mqtt.connect(BROKER_URL, {
  will: {
    topic: `${TOPIC_PREFIX}/${DEVICE_ID}/status`,
    payload: JSON.stringify({ online: false, timestamp: new Date().toISOString() }),
    qos: 0,
    retain: true
  }
});

// ── 명령 핸들러 등록 { action: handler(params) => result } ──
const handlers = {};

function registerHandler(action, handler) {
  handlers[action] = handler;
}

// ── 연결 ──
client.on('connect', () => {
  console.log(`[MAPI Client ${DEVICE_ID}] 연결 완료`);

  // 내 장비의 명령 토픽 구독 (QoS 1: 명령 유실 방지)
  client.subscribe(`${TOPIC_PREFIX}/${DEVICE_ID}/cmd`, { qos: 1 });

  // 온라인 상태 알림
  publishStatus(true);
});

// ── 명령 수신 및 처리 ──
client.on('message', async (topic, payload) => {
  let msg;
  try { msg = JSON.parse(payload.toString()); } catch { return; }

  const { requestId, action, params } = msg;
  console.log(`[수신] action=${action}`, params);

  const handler = handlers[action];
  let result;

  if (handler) {
    try {
      result = { requestId, success: true, data: await handler(params) };
    } catch (e) {
      result = { requestId, success: false, error: e.message };
    }
  } else {
    result = { requestId, success: false, error: `알 수 없는 명령: ${action}` };
  }

  // 응답 전송 (QoS 1)
  client.publish(`${TOPIC_PREFIX}/${DEVICE_ID}/res`, JSON.stringify(result), { qos: 1 });
});

// ── 상태 발행 ──
function publishStatus(online) {
  client.publish(
    `${TOPIC_PREFIX}/${DEVICE_ID}/status`,
    JSON.stringify({ online, timestamp: new Date().toISOString() })
  );
}

// ── 종료 시 오프라인 알림 ──
process.on('SIGINT', () => {
  publishStatus(false);
  setTimeout(() => process.exit(), 500);
});

module.exports = { registerHandler, client, DEVICE_ID };

// ── 직접 실행 시 기본 핸들러 등록 (데모) ──
if (require.main === module) {
  // 예시 핸들러: 온도 데이터 반환
  registerHandler('getData', (params) => {
    if (params.type === 'temperature') {
      return { value: (20 + Math.random() * 10).toFixed(1), unit: '°C' };
    }
    return { value: null };
  });

  // 예시 핸들러: 장비 제어
  registerHandler('control', (params) => {
    console.log(`[제어] ${params.target} = ${params.value}`);
    return { ok: true };
  });

  // 에코 핸들러: 채팅 테스트용
  registerHandler('echo', (params) => {
    return { echo: `[에코] ${params.message}` };
  });

  console.log(`[MAPI Client] 장비 ID: ${DEVICE_ID} - 명령 대기 중...`);
}
