# Iteration 3 — PLAN

## Scope

Channel/DM mute — BE infrastructure 만 (UI affordance 는 follow-up).

## Data model

### Migration: `add_user_channel_mute`

```prisma
model UserChannelMute {
  id          String    @id @default(uuid()) @db.Uuid
  userId      String    @db.Uuid
  channelId   String    @db.Uuid
  // null = indefinite mute. 미래 시점이면 그 시각 까지 mute.
  mutedUntil  DateTime? @db.Timestamptz
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  channel     Channel   @relation(fields: [channelId], references: [id], onDelete: Cascade)

  @@unique([userId, channelId])
  @@index([channelId])
}
```

User + Channel 모델에 backref 추가.

## API

### Endpoints

```
POST   /me/mutes/channels/:channelId        body: { until?: ISO }
DELETE /me/mutes/channels/:channelId
GET    /me/mutes
```

### 동작

- POST: upsert (이미 muted 면 mutedUntil 갱신만)
- DELETE: 행 삭제 (idempotent)
- GET: 본인의 mute 목록 + 만료된 항목 자동 제외

### 권한

- 본인의 channel access 검증: ChannelAccessGuard (workspace channel) 또는 DM channel access
- 단순화: ChannelAccessGuard 만 통과시키면 mute 가능 (DM 채널 access 도 같은 가드 처리)

## Dispatcher 게이트

mention/reply outbox 의 `recipients` 산출 시 mute 된 user 제외:

- `apps/api/src/messages/messages.service.ts` 의 mention 추출 후 — recipients 에서 muted user 빼기
- 같은 채널의 mute 만 적용 (다른 채널의 mention 은 영향 X)

### 헬퍼

```ts
// apps/api/src/messages/mute-filter.ts
async function filterMutedRecipients(
  prisma: PrismaClient,
  channelId: string,
  candidateUserIds: string[],
): Promise<string[]>;
```

만료된 mute (`mutedUntil < now`) 는 자동으로 활성 안 함 — 쿼리에서 `OR mutedUntil > now()` 조건.

## Spec

- `mute.service.spec`: upsert / list / 만료 처리
- `mute-filter.spec`: muted user 제외 검증

## DoD (iteration 3)

- [ ] Migration `add_user_channel_mute` (reversible)
- [ ] Schema 갱신 + Prisma generate
- [ ] mute.service + controller + module
- [ ] mute-filter 헬퍼 + mention/reply 적용
- [ ] Spec
- [ ] `pnpm verify` green
- [ ] DS 4파일 md5 unchanged
- [ ] develop → main auto-promote, /readyz 200 + idle 30s

## Out of scope (이월)

- UI affordance (channel header context menu Mute): `TODO(task-045-follow-mute-ui)`
- 모바일 long-press Mute: `TODO(task-045-follow-mobile-mute)`
- 워크스페이스 단위 일괄 mute: `TODO(task-045-follow-workspace-mute)`
- 시간 기반 quick-mute (8h/24h prefab): `TODO(task-045-follow-mute-quick)`
