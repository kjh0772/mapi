# MAPI ↔ Next.js / 외부 서버 통합 가이드

> 이 문서는 **Claude Code가 읽고 직접 실행할 수 있는 작업 지시서**이자 **개발자가 읽고 이해할 수 있는 가이드**입니다.
>
> 다루는 범위:
> 1. **Next.js 프로젝트에 MAPI 모듈 내장** (시나리오 A, B) — 섹션 1~4
> 2. **Next.js 외 외부 클라이언트 서버에서 MAPI 장비 호출** (Node.js / Python / mosquitto) — 섹션 5

---

## 0. 작업 시작 전 확인 (Claude Code 지시)

작업을 시작하기 전에 다음을 확인하세요:

1. **현재 디렉터리가 Next.js 프로젝트인지 확인**
   - `package.json`에 `"next"` 의존성이 있는지 확인
   - `app/` (App Router) 또는 `pages/` (Pages Router) 디렉터리 구조 파악
2. **사용자에게 물어볼 것 (auto 모드여도 한 번은 물어봐야 함):**
   - **통합 시나리오**: Next.js가 (A) MQTT로 장비/원격 API를 호출하는 쪽인지, (B) 자체 API를 MQTT로 외부에 노출하는 쪽인지
   - **장비 ID 또는 대상 장비 ID 목록**
   - **MQTT 브로커 URL** (기본값 `mqtt://mqtt.hdeng.net:1883` 사용 여부)

> 사용자가 답하지 않으면 시나리오 A + 기본 브로커로 진행하고, 마지막에 변경 방법을 안내하세요.

---

## 1. MAPI가 무엇인가 (배경 지식)

| 기존 방식의 문제 | MAPI의 해결 방식 |
|---|---|
| 장비/원격 서버 IP를 알아야 함 | 장비 ID만 알면 됨 |
| NAT/방화벽 뒤 장비 접근 불가 | 브로커가 중계해서 무관 |
| 장비마다 개별 연결 관리 | Pub/Sub 패턴으로 N:N |

**핵심 토픽:**
- `mapi/{deviceId}/cmd` — 명령 전송 (Next.js → 장비)
- `mapi/{deviceId}/res` — 응답 수신 (장비 → Next.js)
- `mapi/{deviceId}/status` — 장비 온라인/오프라인

**메시지 형식:**
```json
// 명령
{ "requestId": "x-1712345678", "action": "api", "params": { "method": "GET", "path": "/api/sensor/realtime" } }
// 응답
{ "requestId": "x-1712345678", "success": true, "data": { ... } }
```

---

## 2. 통합 시나리오

### 시나리오 A: Next.js가 장비/원격 API를 호출 (대부분의 경우)

```
[브라우저]                         [Next.js 서버]                      [원격 장비/API서버]
React 컴포넌트  ── fetch ──>   API Route (lib/mapi.ts)   ── MQTT cmd ──>  mapiserver
                                       │                                       │
                                       └── MQTT res ◀──────────────────────────┘
```

이 시나리오에서는 **Next.js 서버 측에 MQTT 클라이언트 1개**를 띄워두고, API Route에서 `sendCommand()` 함수로 명령을 보내고 응답을 await하는 구조입니다.

### 시나리오 B: Next.js의 API를 MQTT로 외부에 노출

이 경우 Next.js 코드는 변경하지 않고, 같은 머신에서 `mapiserver.js`를 별도로 실행합니다. 본 가이드의 **부록 B** 참고.

---

## 3. 시나리오 A 구현 (Claude Code 작업 지시)

### 3-1. 의존성 설치

```bash
npm install mqtt
```

> TypeScript 프로젝트라도 `mqtt` 패키지에 타입 정의가 포함되어 있어 별도 `@types` 불필요.

### 3-2. 환경변수 설정

프로젝트 루트의 `.env.local`에 다음을 추가하세요. **이미 존재하면 중복 추가하지 말고 누락된 항목만 보강**하세요.

```env
# MAPI 설정
MAPI_BROKER_URL=mqtt://mqtt.hdeng.net:1883
MAPI_TOPIC_PREFIX=mapi
MAPI_USER=smart
MAPI_PASS=korea
MAPI_DEVICE_ID=nextjs-001
```

> **보안 주의**: `MAPI_PASS`는 서버 환경변수입니다. 절대 `NEXT_PUBLIC_` 접두사를 붙이지 마세요. 클라이언트로 노출됩니다.

### 3-3. MAPI 모듈 작성

`lib/mapi.ts` 파일을 생성하세요 (JS 프로젝트면 `lib/mapi.js`).

이 모듈의 핵심 설계:
- **싱글톤 MQTT 클라이언트** — Next.js dev 모드의 hot reload에서도 중복 연결되지 않도록 `globalThis`에 캐싱
- **Promise 기반 `sendCommand`** — `requestId`로 요청/응답 매칭
- **타임아웃 처리** — 응답 미수신 시 reject

```ts
// lib/mapi.ts
import mqtt, { MqttClient } from 'mqtt';

const BROKER_URL = process.env.MAPI_BROKER_URL || 'mqtt://mqtt.hdeng.net:1883';
const TOPIC_PREFIX = process.env.MAPI_TOPIC_PREFIX || 'mapi';
const USER = process.env.MAPI_USER || 'smart';
const PASS = process.env.MAPI_PASS || 'korea';
const DEVICE_ID = process.env.MAPI_DEVICE_ID || 'nextjs-001';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

interface MapiState {
  client: MqttClient;
  pending: Map<string, Pending>;
  devices: Map<string, { online: boolean; lastSeen: string }>;
}

declare global {
  // eslint-disable-next-line no-var
  var __mapi: MapiState | undefined;
}

function init(): MapiState {
  const pending = new Map<string, Pending>();
  const devices = new Map<string, { online: boolean; lastSeen: string }>();

  const client = mqtt.connect(BROKER_URL, {
    username: USER,
    password: PASS,
    clientId: `nextjs-${DEVICE_ID}-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    console.log('[MAPI] connected:', BROKER_URL);
    client.subscribe(`${TOPIC_PREFIX}/+/res`, { qos: 1 });
    client.subscribe(`${TOPIC_PREFIX}/+/status`, { qos: 0 });
  });

  client.on('message', (topic, payload) => {
    const [, deviceId, type] = topic.split('/');
    let msg: any;
    try { msg = JSON.parse(payload.toString()); } catch { return; }

    if (type === 'res') {
      const p = pending.get(msg.requestId);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.requestId);
        p.resolve(msg);
      }
    } else if (type === 'status') {
      devices.set(deviceId, { online: !!msg.online, lastSeen: new Date().toISOString() });
    }
  });

  client.on('error', (err) => console.error('[MAPI] error:', err.message));

  return { client, pending, devices };
}

const state: MapiState = globalThis.__mapi ?? (globalThis.__mapi = init());

export function sendCommand<T = any>(
  deviceId: string,
  action: string,
  params: Record<string, any> = {},
  timeoutMs = 10000,
): Promise<{ success: boolean; data?: T; error?: string }> {
  return new Promise((resolve, reject) => {
    if (!state.client.connected) return reject(new Error('MQTT not connected'));
    const requestId = `${deviceId}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      reject(new Error(`MAPI timeout: ${deviceId}/${action}`));
    }, timeoutMs);
    state.pending.set(requestId, { resolve, reject, timer });
    state.client.publish(
      `${TOPIC_PREFIX}/${deviceId}/cmd`,
      JSON.stringify({ requestId, action, params }),
      { qos: 1 },
    );
  });
}

/** 원격 API 호출 헬퍼 (mapiserver가 wrapping한 HTTP API 호출용) */
export function callApi<T = any>(
  deviceId: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: any,
  timeoutMs = 10000,
) {
  return sendCommand<T>(deviceId, 'api', { method, path, body }, timeoutMs);
}

export function listDevices() {
  return Object.fromEntries(state.devices);
}
```

### 3-4. API Route 작성

App Router 사용 시 `app/api/mapi/[deviceId]/[...path]/route.ts`:

```ts
// app/api/mapi/[deviceId]/[...path]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { callApi } from '@/lib/mapi';

export const dynamic = 'force-dynamic';

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string; path: string[] }> },
) {
  const { deviceId, path } = await params;
  const targetPath = '/' + path.join('/');
  const method = req.method as 'GET' | 'POST' | 'PUT' | 'DELETE';
  const body = ['POST', 'PUT'].includes(method) ? await req.json().catch(() => undefined) : undefined;

  try {
    const result = await callApi(deviceId, method, targetPath, body);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 504 });
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };
```

> Pages Router를 사용 중이면 `pages/api/mapi/[deviceId]/[...path].ts`로 작성하고 위 로직을 default export 하세요.

### 3-5. 클라이언트에서 사용

```tsx
// app/sensors/page.tsx (서버 컴포넌트 예시)
import { callApi } from '@/lib/mapi';

export default async function SensorsPage() {
  const result = await callApi('smartfarm-001', 'GET', '/api/sensor/realtime');
  return <pre>{JSON.stringify(result, null, 2)}</pre>;
}
```

또는 클라이언트 컴포넌트에서 위에서 만든 프록시 라우트로 fetch:

```tsx
'use client';
import { useEffect, useState } from 'react';

export default function SensorsClient() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    fetch('/api/mapi/smartfarm-001/api/sensor/realtime')
      .then(r => r.json())
      .then(setData);
  }, []);
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
```

### 3-6. 검증

작업 완료 후 다음을 실행하여 동작을 확인하세요:

1. `npm run dev`로 Next.js 실행
2. 별도 터미널에서:
   ```bash
   curl http://localhost:3000/api/mapi/smartfarm-001/api/sensor/realtime
   ```
3. 응답에 `{"success": true, "data": ...}` 형태가 오면 정상

문제 진단:
- **`MQTT not connected`** — 브로커 URL/계정 확인, 방화벽 확인
- **`MAPI timeout`** — 대상 장비(`deviceId`)가 실제로 동작 중인지 확인 (`mapi/{deviceId}/status` 구독)
- **개발 중 hot reload로 연결 폭주** — `lib/mapi.ts`의 `globalThis` 싱글톤이 제대로 동작하는지 확인

---

## 4. 추가 기능

### 4-1. 실시간 장비 상태 SSE 라우트

장비 온/오프라인을 브라우저에서 실시간으로 보고 싶다면:

```ts
// app/api/mapi/events/route.ts
import { NextRequest } from 'next/server';
// state 접근을 위해 mapi 모듈에 내부 export 추가하거나 EventEmitter 패턴으로 확장하세요.
```

> SSE 구현 시 `lib/mapi.ts`에 `EventEmitter`를 추가하여 `client.on('message')`에서 emit하고, SSE 라우트에서 listen하는 패턴을 권장합니다.

### 4-2. 보안 강화

- API Route 앞단에 인증 미들웨어를 두어 인증된 사용자만 호출 가능하도록
- `deviceId` 화이트리스트 검증 (모든 장비를 호출 가능하게 두면 위험)
- Rate limiting 적용

---

## 5. 외부 클라이언트 서버에서 MAPI 장비 접근하기

Next.js와 무관한 **제3의 서버** (예: 다른 회사의 백엔드, 모바일 앱 백엔드, 데이터 분석 서버, 다른 언어/프레임워크의 서비스)에서 MAPI 장비에 접근하는 방법입니다.

### 5-1. 핵심 아이디어

MAPI 장비는 결국 **MQTT 토픽을 구독/발행하는 클라이언트**입니다. 따라서 **MQTT 클라이언트를 가진 어떤 서버든** 다음 4가지만 알면 접근 가능합니다:

| 필요한 정보 | 예시 |
|---|---|
| 브로커 URL | `mqtt://mqtt.hdeng.net:1883` |
| 인증 정보 | `smart` / `korea` |
| 토픽 prefix | `mapi` |
| 대상 장비 ID | `smartfarm-001` |

> 외부 서버는 MAPI 패키지를 설치할 필요가 **없습니다**. 어떤 언어든 MQTT 라이브러리만 있으면 됩니다.

### 5-2. 통신 프로토콜 (외부 서버가 따라야 할 규칙)

**A) 명령 발행 → 응답 수신 패턴 (가장 일반적):**

1. `mapi/{deviceId}/res` 토픽 구독 (응답 수신용)
2. 고유한 `requestId` 생성 (예: `myserver-1712345678`)
3. `mapi/{deviceId}/cmd` 토픽에 명령 JSON 발행 (QoS 1 권장)
4. 구독한 res 토픽에서 같은 `requestId`를 가진 응답을 기다림
5. 타임아웃(예: 10초) 내에 응답이 오지 않으면 실패 처리

**B) 장비 상태 모니터링 패턴:**

1. `mapi/+/status` 토픽을 와일드카드로 구독
2. 모든 장비의 온/오프라인 상태가 들어옴

### 5-3. Node.js 외부 서버 예시

```js
// external-server.js (외부 서버, MAPI 코드 없음)
const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://mqtt.hdeng.net:1883', {
  username: 'smart',
  password: 'korea',
});

const pending = new Map();

client.on('connect', () => {
  client.subscribe('mapi/+/res', { qos: 1 });
  client.subscribe('mapi/+/status');
});

client.on('message', (topic, payload) => {
  const [, deviceId, type] = topic.split('/');
  const msg = JSON.parse(payload.toString());

  if (type === 'res') {
    const p = pending.get(msg.requestId);
    if (p) { clearTimeout(p.timer); pending.delete(msg.requestId); p.resolve(msg); }
  } else if (type === 'status') {
    console.log(`[${deviceId}]`, msg.online ? '온라인' : '오프라인');
  }
});

function callMapi(deviceId, method, path, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = `ext-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('timeout'));
    }, timeoutMs);
    pending.set(requestId, { resolve, timer });
    client.publish(
      `mapi/${deviceId}/cmd`,
      JSON.stringify({ requestId, action: 'api', params: { method, path, body } }),
      { qos: 1 },
    );
  });
}

// 사용 예
(async () => {
  await new Promise(r => client.once('connect', r));
  const result = await callMapi('smartfarm-001', 'GET', '/api/sensor/realtime');
  console.log(result.data);
})();
```

### 5-4. Python 외부 서버 예시

```python
# external_server.py
import paho.mqtt.client as mqtt
import json, threading, time, uuid

BROKER, PORT = "mqtt.hdeng.net", 1883
USER, PASS = "smart", "korea"

pending = {}  # requestId → threading.Event + result holder

def on_connect(c, userdata, flags, rc):
    c.subscribe("mapi/+/res", qos=1)
    c.subscribe("mapi/+/status")

def on_message(c, userdata, msg):
    parts = msg.topic.split("/")
    device_id, mtype = parts[1], parts[2]
    data = json.loads(msg.payload.decode())
    if mtype == "res":
        slot = pending.get(data["requestId"])
        if slot:
            slot["result"] = data
            slot["event"].set()

client = mqtt.Client()
client.username_pw_set(USER, PASS)
client.on_connect = on_connect
client.on_message = on_message
client.connect(BROKER, PORT)
threading.Thread(target=client.loop_forever, daemon=True).start()
time.sleep(0.5)  # 연결 대기

def call_mapi(device_id, method, path, body=None, timeout=10):
    request_id = f"py-{uuid.uuid4().hex[:8]}"
    event = threading.Event()
    pending[request_id] = {"event": event, "result": None}
    client.publish(
        f"mapi/{device_id}/cmd",
        json.dumps({"requestId": request_id, "action": "api",
                    "params": {"method": method, "path": path, "body": body}}),
        qos=1,
    )
    if event.wait(timeout):
        return pending.pop(request_id)["result"]
    pending.pop(request_id, None)
    raise TimeoutError("MAPI timeout")

# 사용 예
result = call_mapi("smartfarm-001", "GET", "/api/sensor/realtime")
print(result["data"])
```

### 5-5. 명령줄에서 빠른 테스트 (mosquitto)

```bash
# 응답 구독 (별도 터미널)
mosquitto_sub -h mqtt.hdeng.net -p 1883 -u smart -P korea -t 'mapi/smartfarm-001/res'

# 명령 발행
mosquitto_pub -h mqtt.hdeng.net -p 1883 -u smart -P korea \
  -t 'mapi/smartfarm-001/cmd' \
  -m '{"requestId":"manual-1","action":"api","params":{"method":"GET","path":"/api/sensor/realtime"}}'
```

### 5-6. 설계 패턴 추천

**개별 장비를 자주 호출하는 외부 서비스:**
- 위의 Node.js/Python 예시처럼 **MQTT 클라이언트를 1개 띄우고 모듈화**해서 사용

**다수 장비의 데이터를 수집/분석하는 서비스:**
- `mapi/+/status` + `mapi/+/res` 와일드카드 구독으로 모든 트래픽 모니터링
- 또는 별도의 데이터 토픽(예: `mapi/{deviceId}/data`) 규약을 정해서 장비가 주기적으로 발행

**REST API로 노출하고 싶을 때 (예: 모바일 앱이 호출하는 백엔드):**
- 외부 서버에 위 코드를 넣고 그 위에 Express/FastAPI 등으로 HTTP 엔드포인트 작성
- 즉, **MQTT 래퍼를 한 번 더 HTTP로 다시 래핑**하는 구조

### 5-7. 외부 서버 보안 권고

- 외부 서버용 MQTT 계정을 **장비용과 분리**하는 것을 권장 (예: `external-readonly` 같은 별도 계정)
- 브로커 ACL로 외부 계정은 `mapi/+/res`, `mapi/+/status` 구독만 허용하고 `cmd` 발행은 화이트리스트 장비만 허용
- 외부 서버가 호출 가능한 `deviceId` 목록을 코드 레벨에서 한 번 더 검증
- 민감한 작업(장비 제어 등)은 호출 시점에 추가 인증 토큰을 `params`에 포함하여 장비/MAPI 서버에서 검증

### 5-8. 외부 서버 통합 체크리스트 (Claude Code)

외부 서버에 MAPI 호출 코드를 통합할 때 확인할 사항:

- [ ] 외부 서버가 사용하는 언어의 MQTT 클라이언트 라이브러리 설치 (`mqtt`, `paho-mqtt`, `eclipse/paho.mqtt.golang` 등)
- [ ] 환경변수 또는 시크릿 매니저로 브로커 URL/계정 관리 (하드코딩 금지)
- [ ] 클라이언트 인스턴스를 **싱글톤으로 관리** (요청마다 새로 연결하면 안 됨)
- [ ] `requestId` 충돌 방지 (UUID 또는 충분한 랜덤성)
- [ ] 응답 타임아웃 처리 + pending Map 정리 (메모리 누수 방지)
- [ ] 연결 끊김 시 자동 재연결 + pending 요청 reject 처리
- [ ] 서비스 종료 시 graceful shutdown으로 MQTT 연결 정리

---

## 부록 A: Pages Router용 코드

```ts
// pages/api/mapi/[deviceId]/[...path].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { callApi } from '@/lib/mapi';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { deviceId, path } = req.query as { deviceId: string; path: string[] };
  const targetPath = '/' + (Array.isArray(path) ? path.join('/') : path);
  try {
    const result = await callApi(deviceId, req.method as any, targetPath, req.body);
    res.json(result);
  } catch (e: any) {
    res.status(504).json({ success: false, error: e.message });
  }
}
```

---

## 부록 B: 시나리오 B (Next.js API를 MQTT로 노출)

Next.js 코드 변경 없이, 같은 머신에서 별도 프로세스로 `mapiserver.js`를 실행:

```bash
# Next.js가 3000번 포트에서 실행 중이라고 가정
DEVICE_ID=mywebapp-001 \
API_PORT=3000 \
API_HOST=localhost \
node mapiserver.js
```

이후 외부에서 MQTT로 호출:
- `mapi/mywebapp-001/cmd` 토픽에 `{"action":"api","params":{"method":"GET","path":"/api/users"}}` 발행
- `mapi/mywebapp-001/res` 토픽에서 응답 수신

PM2 등록:
```bash
DEVICE_ID=mywebapp-001 API_PORT=3000 pm2 start mapiserver.js --name mapi-mywebapp
pm2 save
```

---

## 부록 C: Claude Code 실행 체크리스트

작업 완료 시 다음을 모두 충족해야 합니다:

- [ ] `package.json`에 `mqtt` 의존성 추가됨
- [ ] `.env.local`에 MAPI_* 환경변수 추가됨 (이미 있던 항목은 보존)
- [ ] `lib/mapi.ts` (또는 `.js`) 생성됨, 싱글톤 패턴 적용됨
- [ ] App Router면 `app/api/mapi/[deviceId]/[...path]/route.ts` 생성됨
- [ ] Pages Router면 `pages/api/mapi/[deviceId]/[...path].ts` 생성됨
- [ ] 한 페이지에 사용 예시 코드가 추가됨 (또는 README 갱신)
- [ ] `npm run dev`로 실행 시 콘솔에 `[MAPI] connected:` 로그 출력 확인
- [ ] `curl`로 프록시 라우트 호출 테스트 결과를 사용자에게 보고

작업 후 사용자에게 보고할 것:
1. 어느 파일들을 만들었는지/수정했는지 (경로 명시)
2. `MAPI_DEVICE_ID`를 어떤 값으로 설정했는지
3. 실제 호출 가능한 URL 예시 1~2개
4. 이 가이드에서 다루지 않은 추가 작업이 필요하면 무엇인지
