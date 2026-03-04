---
name: bt-bug-report
description: BT(Bluetooth) 버그 리포트 작성 시 사용. 재현 방법, 로그 포맷, Jira 이슈 생성까지 포함.
---

# BT 버그 리포트 작성 방법

## 1. 필수 정보 수집
- **재현 환경**: 펌웨어 버전, 칩셋 모델, OS/호스트 플랫폼
- **재현율**: 항상 / 간헐적 (N회 중 M회)
- **회귀 여부**: 이전 정상 버전 명시

## 2. 로그 수집 형식
```
[HCI] <timestamp> <direction> <packet_type> <ogf> <ocf> <payload_hex>
[L2CAP] <timestamp> <channel_id> <data_hex>
[RFCOMM] <timestamp> <dlci> <data_ascii>
```

## 3. Jira 이슈 생성 규칙
- **프로젝트**: BT 또는 WLAN (담당 팀에 맞게)
- **이슈 타입**: Bug
- **제목 형식**: `[BT][컴포넌트] 현상 요약 (FW: x.x.x)`
  - 예: `[BT][HCI] ACL 연결 후 2초 내 끊김 발생 (FW: 3.4.1)`
- **우선순위**: Blocker / Critical / Major / Minor / Trivial
- **레이블**: `bt-bug`, `regression` (회귀 시), `customer` (고객 이슈 시)

## 4. 재현 스텝 작성
```
1. 기기 A와 기기 B를 페어링
2. A에서 HFP 연결 수립
3. 통화 중 B에서 특정 동작 수행
4. → 현상 발생 확인
```

## 5. 첨부 파일
- HCI snooplog (btsnoop_hci.log)
- Kernel dmesg (`dmesg | grep -i bluetooth`)
- 해당 구간 스크린샷 또는 영상

## 주의사항
- 개인정보(MAC 주소, 전화번호)는 마스킹 처리: `XX:XX:XX:XX:XX:XX`
- 사내 RAG에서 유사 이슈 먼저 검색 후 중복 여부 확인
