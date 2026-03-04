---
name: gerrit-review
description: Gerrit 코드 리뷰 요청(CL) 작성 및 리뷰 코멘트 작성 시 사용.
---

# Gerrit 코드 리뷰 작성 방법

## 1. CL 제목(Commit Message) 규칙
```
[컴포넌트] 변경 요약 (50자 이하)

본문: 변경 이유, 영향 범위, 테스트 방법
이슈: BT-1234 (Jira 이슈 번호)

Change-Id: I...
```
- 컴포넌트 예시: `[BT/HCI]`, `[WiFi/MLME]`, `[BT/A2DP]`

## 2. 리뷰 코멘트 작성 원칙
- **구체적**: "이 부분 이상함" ❌ → "L42: null 체크 없이 역참조 시 크래시 가능" ✅
- **건설적**: 문제 지적 + 대안 제시
- **Vote 기준**:
  - `+2`: 머지 가능, 주요 리뷰어 필수
  - `+1`: 문제 없음, 최종 승인 권한 없음
  - `-1`: 수정 필요, 머지 불가
  - `-2`: 심각한 문제, 즉시 머지 중단

## 3. 리뷰 요청 시 포함 사항
- 변경 목적 및 배경
- 테스트 완료 항목 (unit test, integration test, HW 테스트)
- 알려진 제한사항 또는 후속 작업

## 4. 코드 리뷰 체크리스트
- [ ] 메모리 누수 없음 (alloc/free 짝 확인)
- [ ] 인터럽트 컨텍스트에서 sleep 없음
- [ ] 에러 코드 전파 누락 없음
- [ ] Magic number → #define 또는 enum 사용
- [ ] 멀티스레드 접근 시 lock 적용
- [ ] 로그 레벨 적절 (DEBUG/INFO/WARN/ERROR)

## 5. Gerrit MCP tool 활용
- `gerrit_list_changes`: 미리뷰 CL 목록 조회
- `gerrit_get_change`: 특정 CL 상세 조회
- `gerrit_review`: 코드 리뷰 코멘트 및 vote 제출
