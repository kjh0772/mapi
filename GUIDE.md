# MAPI - MQTT 기반 IoT 장비 통신 래퍼

## 설계 배경

기존 REST API 방식의 한계:
- 장비의 IP 주소를 알아야 통신 가능
- 다수 장비를 동시에 관리하기 어려움
- 방화벽/NAT 환경에서 직접 접근 불가

MQTT 방식의 장점:
- **장비 ID만 알면 통신 가능** (IP 불필요)
- 브로커 기반이므로 NAT/방화벽 무관
- Pub/Sub 패턴으로 다중 장비 확장 용이

---

## 아키텍처

```
[장비/센서]                    [MQTT 브로커]                    [서버]
mapiclient.js  ── ws ──>  mqtt.agro24.com:8083  <── ws ──  mapiserver.js
```

### 토픽 구조

| 토픽 | 방향 | 용도 |
|------|------|------|
| `mapi/{deviceId}/cmd` | 서버 → 장비 | 명령 전송 |
| `mapi/{deviceId}/res` | 장비 → 서버 | 응답 반환 |
| `mapi/{deviceId}/status` | 장비 → 서버 | 온라인/오프라인 상태 |

### 메시지 형식

**명령 (cmd):**
```json
{ "requestId": "sensor-001-1712345678", "action": "getData", "params": { "type": "temperature" } }
```

**응답 (res):**
```json
{ "requestId": "sensor-001-1712345678", "success": true, "data": { "value": "25.3", "unit": "°C" } }
```

**상태 (status):**
```json
{ "online": true, "timestamp": "2026-04-04T05:00:00.000Z" }
```

---

## 사용법

### 1. 설치

```bash
cd server && npm install
cd client && npm install
```

### 2. 서버 실행

```bash
cd server && npm start
```

### 3. 클라이언트(장비) 실행

```bash
cd client && DEVICE_ID=sensor-001 npm start
```

### 4. 다른 프로젝트에서 모듈로 사용

**서버 측:**
```js
const { sendCommand, getDevices } = require('./server/mapiserver');

// 장비에 명령 전송
const result = await sendCommand('sensor-001', 'getData', { type: 'temperature' });
console.log(result.data); // { value: "25.3", unit: "°C" }

// 연결된 장비 목록
console.log(getDevices());
```

**클라이언트 측:**
```js
const { registerHandler } = require('./client/mapiclient');

// 커스텀 명령 핸들러 등록
registerHandler('getData', (params) => {
  return { value: readSensor(params.type) };
});

registerHandler('control', (params) => {
  setActuator(params.target, params.value);
  return { ok: true };
});
```

---

## 다른 프로젝트에 적용하기

1. `server/`, `client/` 폴더 복사
2. `npm install mqtt`
3. `BROKER_URL` 수정 (필요시)
4. `TOPIC_PREFIX` 수정 (프로젝트별 네임스페이스 분리)
5. 클라이언트에 필요한 핸들러 등록
6. 서버에서 `sendCommand()`로 장비 제어

---

## 확장 포인트

- **인증**: MQTT 브로커의 username/password 옵션 추가
- **DB 연동**: `handleResponse()`에서 수신 데이터를 DB에 저장
- **REST API 연동**: Express 등으로 HTTP → MQTT 브릿지 구성
- **그룹 명령**: `mapi/group/{groupId}/cmd` 토픽으로 그룹 브로드캐스트
