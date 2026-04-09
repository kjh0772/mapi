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
- 기존 REST API 서버를 **MQTT로 래핑**하여 원격 접근 가능

---

## 프로젝트 구조

```
mapi/
├── server/              ← REST API → MQTT 브릿지 (프로덕션)
│   ├── mapiserver.js
│   └── package.json
├── mapi_ui/             ← 웹 대시보드 + 내장 에코 클라이언트
│   ├── mapi_ui.js
│   └── package.json
├── GUIDE.md             ← 이 문서
└── plan.md
```

| 폴더 | 역할 | 실행 위치 |
|------|------|-----------|
| `server/` | 기존 HTTP API를 MQTT로 래핑하는 브릿지 서버 | API 서버와 같은 머신 |
| `mapi_ui/` | 설정/모니터링/명령테스트/채팅 웹 UI | 개발 PC 또는 어디서든 |

---

## 동작 원리

### 1. 기본 흐름 (장비 직접 통신)

```
[장비/센서]                      [MQTT 브로커]                        [서버]
  장비 프로그램     ── mqtt ──>   mqtt.hdeng.net:1883   <── mqtt ──   mapiserver.js
  (명령 수신/응답)                  (메시지 중계)                      (명령 전송/응답 수신)
```

### 2. REST API 래핑 흐름 (핵심 기능)

기존에 HTTP API로 동작하는 서버가 있을 때, mapiserver.js를 함께 실행하면
외부에서 MQTT만으로 해당 API를 호출할 수 있습니다.

```
[내 PC]                    [MQTT 브로커]              [배포 서버]
 mapi_ui (localhost:3800)                              mapiserver.js
      │                                                     │
      ├── MQTT cmd ──────> mqtt.hdeng.net ──────> MQTT cmd ──┤
      │   action: "api"                                      │
      │   path: "/api/sensor/realtime"                       ├── HTTP GET localhost:4000
      │                                                      │   /api/sensor/realtime
      │                                                      │
      ├── MQTT res <────── mqtt.hdeng.net <────── MQTT res ──┤
      │   { temperature: 25.3, ... }                         │
```

> **핵심**: 내 PC와 배포 서버가 서로의 IP를 몰라도, 같은 MQTT 브로커에 연결되어 있으면 장비 ID만으로 통신됩니다.

### 토픽 구조

| 토픽 | 방향 | 용도 | QoS |
|------|------|------|-----|
| `mapi/{deviceId}/cmd` | 요청자 → 서버 | 명령/API 호출 | 1 (유실 방지) |
| `mapi/{deviceId}/res` | 서버 → 요청자 | 응답 반환 | 1 (유실 방지) |
| `mapi/{deviceId}/status` | 서버 → 전체 | 온라인/오프라인 | 0 (가볍게) |

> `{deviceId}`에 장비 고유 ID가 들어갑니다. 예: `mapi/smartfarm-001/cmd`

### 메시지 형식 (JSON)

**API 호출 명령:**
```json
{
  "requestId": "smartfarm-001-1712345678",
  "action": "api",
  "params": {
    "method": "GET",
    "path": "/api/sensor/realtime"
  }
}
```

**POST 요청 예시:**
```json
{
  "requestId": "smartfarm-001-1712345679",
  "action": "api",
  "params": {
    "method": "POST",
    "path": "/api/vent/control",
    "body": { "ventId": 1, "action": "open" }
  }
}
```

**응답:**
```json
{
  "requestId": "smartfarm-001-1712345678",
  "success": true,
  "data": {
    "success": true,
    "data": { "2": { "temperature": 25.3, "humidity": 60.1 } }
  }
}
```

**상태:**
```json
{ "online": true, "timestamp": "2026-04-10T05:00:00.000Z" }
```
- 장비가 비정상 종료되면 MQTT LWT로 브로커가 자동으로 `online: false` 발행

---

## 빠른 시작

### 1. 대시보드로 바로 테스트하기 (가장 쉬운 방법)

```bash
cd mapi_ui
npm install
npm start
```

브라우저에서 `http://localhost:3800` 접속하면 바로 사용 가능합니다.
에코 클라이언트(echo-001)가 내장되어 있어 **별도 장비 없이** 테스트할 수 있습니다.

대시보드 기능:
- **모니터링 탭**: 장비 온/오프라인 상태, 전송/응답/실패 통계, 실시간 로그
- **설정 탭**: 브로커 URL, 웹 포트, 토픽 prefix, 인증 정보를 웹에서 변경 (런타임 변경 가능)
- **명령 테스트 탭**: 장비 ID, action, params를 자유롭게 지정하여 API 호출
- **채팅 에코 탭**: 내장 에코 클라이언트로 메시지 왕복 테스트

### 2. 기존 REST API 서버를 MQTT로 래핑하기

API 서버가 실행 중인 머신에서:

```bash
cd server
npm install

# 환경변수로 대상 API 서버 지정
DEVICE_ID=smartfarm-001 API_PORT=4000 node mapiserver.js
```

이후 어디서든 MQTT로 해당 API를 호출할 수 있습니다:
- 대시보드 명령 테스트 탭에서 장비 ID `smartfarm-001`, Action `api` 선택
- Params에 `{"method":"GET","path":"/api/sensor/realtime"}` 입력 후 전송

### 3. PM2로 프로덕션 배포하기

```bash
# API 브릿지 서버 등록
DEVICE_ID=smartfarm-001 API_PORT=4000 pm2 start mapiserver.js --name mapi-server

# 대시보드 등록 (선택)
pm2 start mapi_ui.js --name mapi-ui

# 재부팅 시 자동 시작
pm2 save
pm2 startup
```

---

## 환경변수

### mapiserver.js (브릿지 서버)

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| `BROKER_URL` | `mqtt://mqtt.hdeng.net:1883` | MQTT 브로커 주소 |
| `TOPIC_PREFIX` | `mapi` | 토픽 네임스페이스 (프로젝트별 분리용) |
| `MQTT_USER` | `smart` | MQTT 인증 사용자명 |
| `MQTT_PASS` | `korea` | MQTT 인증 비밀번호 |
| `DEVICE_ID` | `server-001` | 이 서버의 장비 ID |
| `API_HOST` | `localhost` | 래핑 대상 API 호스트 |
| `API_PORT` | `3000` | 래핑 대상 API 포트 |

### mapi_ui.js (대시보드)

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| `BROKER_URL` | `mqtt://mqtt.hdeng.net:1883` | MQTT 브로커 주소 |
| `TOPIC_PREFIX` | `mapi` | 토픽 네임스페이스 |
| `MQTT_USER` | `smart` | MQTT 인증 사용자명 |
| `MQTT_PASS` | `korea` | MQTT 인증 비밀번호 |
| `DEVICE_ID` | `echo-001` | 내장 에코 클라이언트 장비 ID |
| `PORT` | `3800` | 웹서버 포트 (설정 탭에서 런타임 변경 가능) |

---

## 실제 장비에 MAPI 적용하기

장비 측에서는 MQTT 클라이언트로 토픽을 구독/발행하면 됩니다.
Node.js 외에도 Python, C, Arduino 등 MQTT를 지원하는 모든 언어에서 사용 가능합니다.

### 장비 측 구현 순서

1. MQTT 브로커에 연결 (`mqtt://mqtt.hdeng.net:1883`, 인증: smart/korea)
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

  let data;
  if (action === 'getData') {
    data = { value: readSensor(params.type) };
  } else if (action === 'control') {
    setActuator(params.target, params.value);
    data = { ok: true };
  }

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

### 새 REST API 서버를 MQTT로 래핑하기

1. `server/` 폴더 복사 → API 서버와 같은 머신에 배치
2. `npm install` 실행
3. 환경변수 설정:
   ```bash
   DEVICE_ID=my-project-001  # 이 서버의 고유 ID
   API_PORT=8080             # 래핑할 API 서버 포트
   TOPIC_PREFIX=myproject    # 다른 프로젝트와 토픽 분리
   ```
4. `node mapiserver.js` 실행
5. 어디서든 MQTT로 `my-project-001`에 API 호출 가능

### 대시보드로 테스트/모니터링

1. `mapi_ui/` 폴더 복사 → 개발 PC에 배치
2. `npm install && npm start`
3. 브라우저에서 명령 테스트 탭 → 장비 ID에 `my-project-001` 입력
4. Action: `api`, Params: `{"method":"GET","path":"/api/xxx"}`

---

## 보안 참고사항

- 현재 MQTT 인증은 **최소 보안** 수준 (모든 장비가 동일 계정 `smart`/`korea` 사용)
- 프로덕션 배포 시 장비별 개별 인증 또는 TLS 클라이언트 인증서 적용 권장
- 브로커 측에서 ACL(접근 제어 목록)로 토픽별 접근 권한 제한 가능
- `TOPIC_PREFIX`를 프로젝트별로 다르게 설정하면 토픽 충돌 방지

---

## 기술 스택

| 기술 | 용도 |
|------|------|
| **Node.js** + **mqtt.js** | MQTT 통신 |
| **Express** | 대시보드 웹서버 |
| **SSE (Server-Sent Events)** | 실시간 모니터링 |
| **MQTT QoS 1** | 명령/응답 유실 방지 |
| **MQTT LWT** | 비정상 종료 자동 감지 |
| **HTTP 프록시** | REST API → MQTT 브릿지 |
| **PM2** | 프로덕션 프로세스 관리 |
