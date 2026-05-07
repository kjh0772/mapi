# MAPI ↔ Next.js 통합 가이드

> 이 문서는 **Claude Code가 읽고 직접 실행할 수 있는 작업 지시서**이자 **개발자가 읽고 이해할 수 있는 가이드**입니다.
> Next.js 프로젝트에 MAPI(MQTT 기반 IoT 통신 래퍼)를 내장하여, 장비 IP 없이 장비/원격 API를 호출할 수 있게 만듭니다.

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
