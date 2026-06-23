# Iteration 5 — PLAN

## Scope

Group DM (3+) — 단독 iteration. createGroupDm + listing only. Member add/remove + UI 는 follow-up.

## Implementation

### Naming convention

- 1:1 DM: `dm:<sortedA>:<sortedB>` (기존 유지)
- Group DM: `gdm:<sortedIds joined by ":"> ` (신규)
  - sortedIds 는 sender 포함 모든 멤버의 user id 를 lexicographic 정렬 후 `:` 로 join.
  - 동일 멤버 집합 → 동일 slug → createOrGet idempotent.

### Channel.type

- `DIRECT` 그대로 사용 (enum 변경 X). naming convention 으로 1:1 vs group 구분.
- Channel.workspaceId nullable — 026 의 global DM 패턴 (workspaceId=null) 으로 통일.
- isPrivate=true.

### Service: DirectMessagesService.createGroupDm

```ts
async createGroupDm(args: {
  workspaceId: string | null;  // null 이면 global DM scope
  meId: string;
  memberIds: string[];          // 본인 제외, 2-9 명
}): Promise<{ channelId: string; created: boolean; memberIds: string[] }>
```

검증:

- memberIds 길이 2 이상 9 이하 (총 인원 3-10)
- 모든 memberIds 가 unique + meId 와 다름
- workspace 단위 DM 이면 모든 멤버가 workspaceMember 여야 함
- 멤버 정렬 후 slug 생성

Tx:

- Channel 1 행 (type=DIRECT, name=gdm:..., workspaceId=null|workspaceId)
- ChannelPermissionOverride N+1 행 (sender + memberIds 각각 USER allow=READ|WRITE|DELETE_OWN|UPLOAD)

### Endpoint

```
POST /me/dms/groups
Body: { memberIds: string[], workspaceId?: string | null }
Response: { channelId, created, memberIds }
```

### Listing

- 기존 `/me/dms` 가 group DM 도 함께 반환하도록 약간만 수정.
  - 현재는 1:1 만 보여줌 → group DM 도 채널 단위 row 로 포함 시켜 표시.
  - 단순화: group DM 의 `otherUserId` 는 첫 번째 (sender 제외) 멤버 — 정확한 group 표시는 UI follow-up.
  - 다른 path: group DM list 만 별도 endpoint. iter 5 에서는 `/me/dms` 포함 여부는 follow-up — group DM 자체 생성만 우선.

## Spec

- createGroupDm.unit.spec: 멤버 수 검증 / 동일 멤버 set idempotent / sender 포함 / channel + permission override 생성 검증

## Out of scope (이월)

- addMember / removeMember endpoint: TODO(task-045-follow-gdm-member-mgmt)
- /me/dms 응답에 group DM 포함: TODO(task-045-follow-gdm-listing)
- UI: group DM 생성 modal / 멤버 picker: TODO(task-045-follow-gdm-ui)
- Group DM 이름 (사용자가 지정 가능): TODO(task-045-follow-gdm-name)
- Group avatar (멤버 avatar 합성): TODO(task-045-follow-gdm-avatar)
- leave DM: TODO(task-045-follow-gdm-leave)

## DoD (iter 5)

- [ ] createGroupDm service 메서드
- [ ] POST /me/dms/groups endpoint (DirectMessagesController 또는 별도 controller)
- [ ] Spec
- [ ] verify green
- [ ] DS md5 unchanged
- [ ] develop → main
- [ ] readyz 200 + idle 30s
- [ ] pane 1 mini-progress
