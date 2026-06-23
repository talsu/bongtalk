# Iteration 3 — PLAN

## Scope

**@everyone permission gate** — sender 가 OWNER/ADMIN 이 아니면 mentions.everyone 을 silently strip.

> Note: `@here` 는 현재 mention-extractor 가 처리하지 않습니다 — 별도
> follow-up 으로 추가 가능. 본 iteration 은 `@everyone` 만 다룹니다.
> `TODO(task-044-iteration-3-follow-here-mention)`.

## 동작 정의

Discord 정책 (참고):

- Member 가 `@everyone` 입력 시 mention 효과 발생 안 함 (텍스트는 그대로 보임 — fenced 모드에서 전달)
- Slack: workspace admin 이 `@channel`/`@here` 권한을 멤버에게 grant 가능 (우리는 단순 OWNER/ADMIN 만)

우리 정책:

- `@everyone` 텍스트는 그대로 메시지 content 에 보존 (사용자 입력 변형 X)
- `mentions.everyone` 만 silently false 로 강제 — fanout 0
- 응답에는 권한 부족 에러 X (silently downgrade) — Discord 동일

## 구현

### `mentions.gate.ts` (새 파일, apps/api/src/messages/mentions/)

```ts
import type { Mentions } from './mention-extractor';

export type GateActorRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/**
 * task-044-iter3: @everyone 은 OWNER/ADMIN 만 효과. MEMBER 가 작성한
 * `mentions.everyone=true` 는 silently false 로 다운그레이드합니다.
 * mention-extractor 의 순수성 유지를 위해 service 계층 후처리 함수.
 */
export function gateEveryoneMention(mentions: Mentions, actorRole: GateActorRole): Mentions {
  if (!mentions.everyone) return mentions;
  if (actorRole === 'OWNER' || actorRole === 'ADMIN') return mentions;
  return { ...mentions, everyone: false };
}
```

### `messages.service.ts` send + update 수정

- `extractMentions` 직후, `actorRole` 을 알면 `gateEveryoneMention` 통과
- `actorRole` 은 controller 에서 service 호출 시 인자로 전달 (`m.role`)

### Controller

- `messages.controller.ts` 의 `send` / `update` 가 `m.role` 을 service 인자로 전달

## Spec

### Unit

- `mentions/gate.spec.ts`:
  - OWNER → everyone 유지
  - ADMIN → everyone 유지
  - MEMBER → everyone false
  - 이미 false 면 그대로

## DoD

- [ ] `gate.ts` 신규 + spec 신규
- [ ] service.send / service.update 가 gate 적용
- [ ] controller 가 actorRole 전달
- [ ] `pnpm verify` green
- [ ] develop merge → main auto-promote
- [ ] /readyz 200 + idle 30s
- [ ] pane 1 mini-progress forward

## Out of scope

- `@here` mention (mention-extractor 자체에 추가 필요): `TODO(task-044-iteration-3-follow-here-mention)`
- Per-channel grant: `TODO(task-044-follow-channel-mention-grant)`
- Client-side composer warning 표시: `TODO(task-044-follow-composer-warn-everyone)`
