# MAPI - MQTT 기반 IoT 장비 통신 래퍼

## 이 프로젝트가 해결하는 문제

기존 REST API로 IoT 장비와 통신하려면:
- 장비의 **IP 주소를 알아야** 함 → 공유기(NAT) 뒤의 장비는 접근 불가
- 장비마다 **개별 연결**이 필요 → 수십~수백 대 관리 어려움
- 장비가 **방화벽 뒤**에 있으면 서버에서 접근 불가

**MAPI는 이 문제를 해결합니다:**
- 장비의 **ID만 알면** IP 없이 통신 가능
- MQTT 브로커가 중계하므로 **NAT/방화벽 무관**
- Pub/Sub 패턴으로 **장비 추가 시 서버 코드 변경 불필요**

---

## 프로젝트 구조

```
mapi/
├── server/              ← 프로덕션 서버 (장비 관리, 명령 전송)
│   ├── mapiserver.js
│   └── package.json
├── mapi_ui/             ← 웹 대시보드 + 내장 테스트 클라이언트
│   ├── mapi_ui.js
│   └── package.json
├── GUIDE.md             ← 이 문서
└── plan.md
```

| 폴더 | 역할 | 실행 위치 |
|------|------|-----------|
| `server/` | 장비에 명령을 보내고 응답을 받는 서버 모듈 | 우분투 서버 (프로덕션) |
| `mapi_ui/` | 설정/모니터링/테스트 웹 UI (에코 클라이언트 내장) | 개발 PC 또는 서버 |

---

## 동작 원리

### 전체 흐름

```
[장비/센서]                      [MQTT 브로커]                        [서버]
  장비 프로그램     ── mqtt ──>   mqtt.hdeng.net:1883   <── mqtt ──   mapiserver.js
  (명령 수신/응답)                  (메시지 중계)                      (명령 전송/응답 수신)
```

1. **서버**가 `mapi/{deviceId}/cmd` 토픽에 명령을 발행(publish)
2. **브로커**가 해당 토픽을 구독(subscribe)한 장비에 전달
3. **장비**가 명령을 처리하고 `mapi/{deviceId}/res` 토픽에 응답을 발행
4. **서버**가 응답을 수신

> 핵심: 서버와 장비가 서로의 IP를 몰라도 브로커를 통해 통신합니다.

### 토픽 구조

| 토픽 | 방향 | 용도 | QoS |
|------|------|------|-----|
| `mapi/{deviceId}/cmd` | 서버 → 장비 | 명령 전송 | 1 (유실 방지) |
| `mapi/{deviceId}/res` | 장비 → 서버 | 응답 반환 | 1 (유실 방지) |
| `mapi/{deviceId}/status` | 장비 → 서버 | 온라인/오프라인 | 0 (가볍게) |

> `{deviceId}`에 장비 고유 ID가 들어갑니다. 예: `mapi/sensor-001/cmd`

### 메시지 형식 (JSON)

**명령 (서버 → 장비):**
```json
{
  "requestId": "sensor-001-1712345678",
  "action": "getData",
  "params": { "type": "temperature" }
}
```
- `requestId`: 요청/응답 매칭용 고유 ID (자동 생성)
- `action`: 장비가 수행할 동작 이름
- `params`: 동작에 필요한 파라미터

**응답 (장비 → 서버):**
```json
{
  "requestId": "sensor-001-1712345678",
  "success": true,
  "data": { "value": "25.3", "unit": "°C" }
}
```

**상태 (장비 → 서버):**
```json
{ "online": true, "timestamp": "2026-04-10T05:00:00.000Z" }
```
- 장비가 비정상 종료되면 MQTT LWT(Last Will and Testament)로 브로커가 자동으로 `online: false` 발행

---

## 빠른 시작

### 1. 대시보드로 바로 테스트하기 (가장 쉬운 방법)

```bash
cd mapi_ui
npm install
npm start
```

브라우저에서 `http://localhost:3000` 접속하면 바로 사용 가능합니다.
에코 클라이언트(echo-001)가 내장되어 있어 **별도 장비 없이** 테스트할 수 있습니다.

대시보드 기능:
- **모니터링 탭**: 장비 온/오프라인 상태, 전송/응답/실패 통계, 실시간 로그
- **설정 탭**: 브로커 URL, 토픽 prefix, 인증 정보를 웹에서 변경
- **명령 테스트 탭**: 장비 ID, action, params를 자유롭게 지정하여 명령 전송
- **채팅 에코 탭**: 메시지 에코 테스트

### 2. 서버 모듈을 내 프로젝트에서 사용하기

```bash
cd server
npm install
```

**명령 전송:**
```js
const { sendCommand, getDevices } = require('./server/mapiserver');

// 장비에 온도 데이터 요청 (Promise 기반, await 사용)
const result = await sendCommand('sensor-001', 'getData', { type: 'temperature' });
console.log(result.data);  // { value: "25.3", unit: "°C" }

// 현재 연결된 장비 목록 조회
console.log(getDevices());
// { "sensor-001": { online: true, lastSeen: "2026-04-10T..." } }
```

---

## 환경변수

모든 설정은 환경변수로 오버라이드할 수 있습니다. 설정하지 않으면 기본값을 사용합니다.

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| `BROKER_URL` | `mqtt://mqtt.hdeng.net:1883` | MQTT 브로커 주소 |
| `TOPIC_PREFIX` | `mapi` | 토픽 네임스페이스 (프로젝트별 분리용) |
| `MQTT_USER` | `smart` | MQTT 인증 사용자명 |
| `MQTT_PASS` | `korea` | MQTT 인증 비밀번호 |
| `DEVICE_ID` | `echo-001` | 내장 에코 클라이언트 장비 ID |
| `PORT` | `3800` | 대시보드 웹서버 포트 |

사용 예:
```bash
BROKER_URL=mqtt://my-broker:1883 TOPIC_PREFIX=farm node mapi_ui.js
```

---

## 실제 장비에 MAPI 적용하기

장비 측에서는 MQTT 클라이언트로 토픽을 구독/발행하면 됩니다.
Node.js 외에도 Python, C, Arduino 등 MQTT를 지원하는 모든 언어에서 사용 가능합니다.

### 장비 측 구현 순서

1. MQTT 브로커에 연결 (`mqtt://mqtt.hdeng.net:1883`)
2. `mapi/{내장비ID}/cmd` 토픽 구독 (QoS 1)
3. 명령 수신 시 action에 따라 처리 후 `mapi/{내장비ID}/res`에 응답 발행
4. 연결 시 `mapi/{내장비ID}/status`에 `{ online: true }` 발행
5. LWT 설정: 비정상 종료 시 자동으로 `{ online: false }` 발행되도록

### Node.js 장비 예시

```js
const mqtt = require('mqtt');

const DEVICE_ID = 'sensor-001';
const client = mqtt.connect('mqtt://mqtt.hdeng.net:1883', {
  username: 'smart',
  password: 'korea',
  will: {  // 비정상 종료 시 브로커가 자동 발행
    topic: `mapi/${DEVICE_ID}/status`,
    payload: JSON.stringify({ online: false }),
    qos: 0
  }
});

client.on('connect', () => {
  client.subscribe(`mapi/${DEVICE_ID}/cmd`, { qos: 1 });
  client.publish(`mapi/${DEVICE_ID}/status`, JSON.stringify({ online: true }));
});

client.on('message', (topic, payload) => {
  const { requestId, action, params } = JSON.parse(payload.toString());

  // action에 따라 처리
  let data;
  if (action === 'getData') {
    data = { value: readSensor(params.type) };  // 센서 읽기
  } else if (action === 'control') {
    setActuator(params.target, params.value);    // 장비 제어
    data = { ok: true };
  }

  // 응답 전송
  client.publish(`mapi/${DEVICE_ID}/res`,
    JSON.stringify({ requestId, success: true, data }), { qos: 1 });
});
```

### Python 장비 예시

```python
import paho.mqtt.client as mqtt
import json

DEVICE_ID = "sensor-001"

def on_connect(client, userdata, flags, rc):
    client.subscribe(f"mapi/{DEVICE_ID}/cmd", qos=1)
    client.publish(f"mapi/{DEVICE_ID}/status", json.dumps({"online": True}))

def on_message(client, userdata, msg):
    cmd = json.loads(msg.payload)
    # action에 따라 처리
    result = {"requestId": cmd["requestId"], "success": True, "data": {"value": 25.3}}
    client.publish(f"mapi/{DEVICE_ID}/res", json.dumps(result), qos=1)

client = mqtt.Client()
client.username_pw_set("smart", "korea")
client.will_set(f"mapi/{DEVICE_ID}/status", json.dumps({"online": False}))
client.on_connect = on_connect
client.on_message = on_message
client.connect("mqtt.hdeng.net", 1883)
client.loop_forever()
```

---

## 다른 프로젝트에 적용하기

1. `server/` 폴더 복사
2. `npm install mqtt` 실행
3. 환경변수로 `BROKER_URL`, `TOPIC_PREFIX` 설정 (프로젝트별 네임스페이스 분리)
4. 서버에서 `sendCommand(deviceId, action, params)`로 장비 제어
5. 장비 측에서 위 예시 코드 참고하여 구현

---

## 보안 참고사항

- 현재 MQTT 인증은 **최소 보안** 수준 (모든 장비가 동일 계정 사용)
- 프로덕션 배포 시 장비별 개별 인증 또는 TLS 클라이언트 인증서 적용 권장
- 브로커 측에서 ACL(접근 제어 목록)로 토픽별 접근 권한 제한 가능

---

## 기술 스택

- **Node.js** + **mqtt.js** — 서버/클라이언트 MQTT 통신
- **Express** — 대시보드 웹서버
- **SSE (Server-Sent Events)** — 실시간 모니터링 업데이트
- **MQTT QoS 1** — 명령/응답 메시지 유실 방지
- **MQTT LWT** — 장비 비정상 종료 자동 감지
