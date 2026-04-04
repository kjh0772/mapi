당신은 IoT 및 MQTT 시스템을 전문으로 하는 시니어 C# 백엔드 엔지니어입니다.

아래 MQTT Helper 코드를 **확장 가능하고 유지보수성이 높은 프로덕션 수준 구조로 리팩토링**하세요.

---

## 목표

* 기존 api의 한계(상대 ip주소 모르면 통신 불가, 다수 기기 처리하기 어려움)를 극복하기 위한 mqtt wrapper project
* 다중 장비 확장 가능한 구조 설계
* 책임 분리 (MQTT / 명령 처리 / 데이터 모델 / DB API)

---

## 요구사항

### 1. node.js, mqtt 사용
### 2. mapiserver.js(메인서버용), mapiclient.js(클라이언트) 각각 하나의 파일만 생성
### 3. 최대한 간결한 코드로 작성

## FLOW

###  mapiclient.js[node(센서 또는 장비)] <-> mapiserver.js[우분투서버, mqtt서버+mapiserver.js]

## 실제 메인 mqtt서버
const mqtt = require('mqtt');

const client = mqtt.connect('ws://mqtt.agro24.com:8083/mqtt');

client.on('connect', function () {
  console.log('connected via websocket');
  client.publish('jet/test', 'hello websocket!');
});

## 장비 또는 센서의 id만 알면 기존 api 코드로 동작하던 코드가 mqtt로 동작합니다.

코드의 설계과정을 문서로 남기고 다른 프로젝트에 적용할 수 있도록 가이드 문서도 만들어 주세요.