import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import {
  AUTOMOD_RULES_PER_WORKSPACE_MAX,
  type AutoModAction,
  type AutoModMatch,
  type AutoModRule,
  type CreateAutoModRuleRequest,
  type ListAutoModRulesResponse,
  type UpdateAutoModRuleRequest,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { AuditService, AuditAction } from '../../common/audit/audit.service';
import { ModerationService } from '../moderation/moderation.service';

/**
 * FR-RM10a (063 / ADR E3·E5): AutoMod 키워드 모더레이션 서비스.
 *
 * 두 책임을 갖는다:
 *   1) ADMIN 의 규칙 CRUD(생성/목록/수정/삭제 + AuditService 기록 + 캐시 무효화).
 *   2) 메시지 send/edit hook 의 check() — enabled KEYWORD 규칙들을 contentPlain 에 대해
 *      ★리터럴 매칭(정규식 없음 — ReDoS 회피, ADR E1)으로 평가하고 첫 매칭 액션을 반환.
 *
 * 캐시: 워크스페이스별 enabled 규칙 평가 결과를 in-memory Map 에 짧은 TTL 로 둔다(hot
 * send-path 의 per-message DB 조회 제거). CRUD 시 해당 워크스페이스 캐시를 즉시 무효화하고,
 * TTL 은 다중 노드의 stale 윈도를 상한한다(다른 노드의 무효화는 TTL 만료로 수렴).
 */
@Injectable()
export class AutoModService {
  private readonly logger = new Logger(AutoModService.name);

  /** check() 안전 상한 — 콘텐츠/키워드 길이 cap(bounded 매칭 · DoS 방어). */
  private static readonly MAX_CONTENT_SCAN_LEN = 16_000;

  /** 워크스페이스별 enabled 규칙 캐시(in-memory). TTL 로 다중 노드 stale 윈도 상한. */
  private static readonly CACHE_TTL_MS = 10_000;
  private readonly cache = new Map<string, { rules: CachedRule[]; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    // TIMEOUT 액션이 tx 후 작성자 타임아웃을 적용한다. ModerationService 는 같은
    // WorkspacesModule 내 provider 라 직접 주입(순환 없음). best-effort 호출.
    @Inject(forwardRef(() => ModerationService))
    private readonly moderation: ModerationService,
  ) {}

  // ── CRUD ───────────────────────────────────────────────────────────────────

  /** FR-RM10a: 워크스페이스 AutoMod 규칙 목록(ADMIN). 생성 최신순. */
  async list(workspaceId: string): Promise<ListAutoModRulesResponse> {
    const rows = await this.prisma.autoModRule.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return { rules: rows.map(toDto) };
  }

  /** FR-RM10a: 규칙 생성. 키워드는 소문자 정규화·중복 제거 후 저장. AuditLog 필수. */
  async create(
    workspaceId: string,
    actorId: string,
    input: CreateAutoModRuleRequest,
  ): Promise<AutoModRule> {
    // 워크스페이스당 규칙 수 cap(과다 규칙 hot-path 보호).
    const count = await this.prisma.autoModRule.count({ where: { workspaceId } });
    if (count >= AUTOMOD_RULES_PER_WORKSPACE_MAX) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        `workspace already has the maximum of ${AUTOMOD_RULES_PER_WORKSPACE_MAX} AutoMod rules`,
      );
    }
    const keywords = normalizeKeywords(input.keywords);
    // ★F3 (보안): exempt 역할/채널 ID 가 모두 본 워크스페이스 소속인지 검증한다(타 워크스페이스
    // UUID 주입 차단). 무효 ID 가 있으면 400 으로 거부한다.
    await this.assertExemptOwnership(workspaceId, input.exemptRoleIds, input.exemptChannelIds);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.autoModRule.create({
        data: {
          workspaceId,
          name: input.name,
          triggerType: 'KEYWORD',
          keywords,
          matchMode: input.matchMode,
          action: input.action,
          timeoutSeconds: input.action === 'TIMEOUT' ? (input.timeoutSeconds ?? null) : null,
          exemptRoleIds: input.exemptRoleIds ?? [],
          exemptChannelIds: input.exemptChannelIds ?? [],
          enabled: input.enabled ?? true,
          createdBy: actorId,
        },
      });
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: AuditAction.AUTOMOD_RULE_CREATE,
          targetId: null,
          details: { ruleId: row.id, name: row.name, action: row.action, matchMode: row.matchMode },
        },
        tx,
      );
      return row;
    });
    this.invalidate(workspaceId);
    return toDto(created);
  }

  /** FR-RM10a: 규칙 수정(부분). 키워드 변경 시 소문자 정규화. AuditLog 필수. */
  async update(
    workspaceId: string,
    actorId: string,
    ruleId: string,
    input: UpdateAutoModRuleRequest,
  ): Promise<AutoModRule> {
    // 본 워크스페이스 소유 규칙인지 확인(타 워크스페이스 누출 방지).
    const existing = await this.prisma.autoModRule.findFirst({
      where: { id: ruleId, workspaceId },
      select: { id: true },
    });
    if (!existing) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'AutoMod rule not found');
    }
    // ★F3 (보안): 수정 요청에 exempt 가 오면 본 워크스페이스 소속인지 검증한다(타 워크스페이스
    // UUID 주입 차단). undefined(미변경)면 검증 생략.
    await this.assertExemptOwnership(workspaceId, input.exemptRoleIds, input.exemptChannelIds);
    const data: Prisma.AutoModRuleUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.keywords !== undefined) data.keywords = normalizeKeywords(input.keywords);
    if (input.matchMode !== undefined) data.matchMode = input.matchMode;
    if (input.action !== undefined) {
      data.action = input.action;
      // 액션이 TIMEOUT 이 아니면 timeoutSeconds 를 null 로 정리한다(정합).
      if (input.action !== 'TIMEOUT') data.timeoutSeconds = null;
    }
    if (input.timeoutSeconds !== undefined) data.timeoutSeconds = input.timeoutSeconds;
    if (input.exemptRoleIds !== undefined) data.exemptRoleIds = input.exemptRoleIds;
    if (input.exemptChannelIds !== undefined) data.exemptChannelIds = input.exemptChannelIds;
    if (input.enabled !== undefined) data.enabled = input.enabled;

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.autoModRule.update({ where: { id: ruleId }, data });
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: AuditAction.AUTOMOD_RULE_UPDATE,
          targetId: null,
          details: { ruleId: row.id, name: row.name, action: row.action, enabled: row.enabled },
        },
        tx,
      );
      return row;
    });
    this.invalidate(workspaceId);
    return toDto(updated);
  }

  /** FR-RM10a: 규칙 삭제. AuditLog 필수. */
  async remove(workspaceId: string, actorId: string, ruleId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.autoModRule.deleteMany({ where: { id: ruleId, workspaceId } });
      if (result.count === 0) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'AutoMod rule not found');
      }
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: AuditAction.AUTOMOD_RULE_DELETE,
          targetId: null,
          details: { ruleId },
        },
        tx,
      );
    });
    this.invalidate(workspaceId);
  }

  /**
   * ★FR-RM10a (리뷰 F3 · 보안): exempt 역할/채널 ID 가 전부 본 워크스페이스 소속인지 검증한다.
   * 종전엔 검증이 없어 타 워크스페이스 UUID 를 주입할 수 있었다(정보 노출/규칙 오작동). 각
   * 목록을 `findMany({where:{workspaceId, id:{in:[...]}}})` 로 조회해 발견 수가 요청 수와
   * 다르면(= 하나라도 타 워크스페이스/존재하지 않음) 어느 ID 가 무효인지 명시해 400 으로 거부한다.
   * undefined(미변경/미제공)이거나 빈 배열이면 검증을 생략한다.
   */
  private async assertExemptOwnership(
    workspaceId: string,
    exemptRoleIds: string[] | undefined,
    exemptChannelIds: string[] | undefined,
  ): Promise<void> {
    if (exemptRoleIds !== undefined && exemptRoleIds.length > 0) {
      const ids = [...new Set(exemptRoleIds)];
      const found = await this.prisma.role.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true },
      });
      if (found.length !== ids.length) {
        const foundSet = new Set(found.map((r) => r.id));
        const invalid = ids.filter((id) => !foundSet.has(id));
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          `exemptRoleIds contains roles not in this workspace: ${invalid.join(', ')}`,
        );
      }
    }
    if (exemptChannelIds !== undefined && exemptChannelIds.length > 0) {
      const ids = [...new Set(exemptChannelIds)];
      const found = await this.prisma.channel.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true },
      });
      if (found.length !== ids.length) {
        const foundSet = new Set(found.map((c) => c.id));
        const invalid = ids.filter((id) => !foundSet.has(id));
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          `exemptChannelIds contains channels not in this workspace: ${invalid.join(', ')}`,
        );
      }
    }
  }

  // ── check (send/edit hook) ──────────────────────────────────────────────────

  /**
   * FR-RM10a (ADR E3): 메시지 send/edit hook 평가. enabled KEYWORD 규칙들을 순서대로
   * 평가해 첫 매칭의 {action, rule, keyword} 를 반환한다(매칭 없으면 null).
   *
   * 각 규칙: 채널 exempt(channelId ∈ exemptChannelIds) 또는 역할 exempt(actorRoleIds ∩
   * exemptRoleIds) 면 건너뛴다 → ★리터럴 매칭(contentPlain 소문자 vs keywords·정규식 없음).
   * DM(workspaceId=null)은 워크스페이스 규칙이 없으므로 즉시 null. 콘텐츠/키워드 길이는
   * cap 해 매칭 비용을 bounded 로 둔다.
   *
   * ★FR-RM10a (리뷰 F1 · 보안): AutoMod 집행은 **OWNER/ADMIN 작성자에게 적용하지 않는다**
   * (모더레이터 면제 — 룰을 통제·신뢰하는 주체이며 Discord AutoMod parity). 이로써 악의적
   * ADMIN 이 'OWNER 가 쓰는 단어'를 키워드 등록해 OWNER 를 자동 타임아웃(락아웃)하는 계층
   * 방어 우회를 막는다. actorRole 은 send/edit 컨트롤러가 이미 로드(m.role)해 전달하며,
   * 누락 시(actorRole=undefined) 본 서비스가 작성자의 WorkspaceMember.role 을 조회해 판정한다.
   */
  async check(args: {
    workspaceId: string | null;
    channelId: string;
    authorId: string;
    actorRoleIds: string[];
    contentPlain: string;
    /** 작성자의 시스템 역할 enum(없으면 서비스가 조회). OWNER/ADMIN 이면 집행 skip. */
    actorRole?: WorkspaceRole;
  }): Promise<{
    action: AutoModAction;
    rule: { id: string; name: string };
    keyword: string;
    timeoutSeconds: number | null;
  } | null> {
    // DM(워크스페이스 없음) 또는 빈 본문은 평가 대상이 아니다.
    if (args.workspaceId === null) return null;
    // ★F1: OWNER/ADMIN 작성자는 AutoMod 비대상(모더레이터 면제). 컨트롤러가 actorRole 을
    // 넘기면 그것을, 아니면 작성자 멤버십을 조회해 판정한다(자기역할 self-exempt 우려 무의미).
    if (await this.isModeratorExempt(args.workspaceId, args.authorId, args.actorRole)) return null;
    const rules = await this.loadEnabledRules(args.workspaceId);
    if (rules.length === 0) return null;

    const haystack = args.contentPlain.slice(0, AutoModService.MAX_CONTENT_SCAN_LEN).toLowerCase();
    if (haystack.length === 0) return null;
    const actorRoleSet = new Set(args.actorRoleIds);

    for (const rule of rules) {
      // 채널 면제.
      if (rule.exemptChannelIds.includes(args.channelId)) continue;
      // 역할 면제(actorRoleIds ∩ exemptRoleIds).
      if (rule.exemptRoleIds.some((rid) => actorRoleSet.has(rid))) continue;
      const matched = matchKeyword(haystack, rule.keywords, rule.matchMode);
      if (matched !== null) {
        return {
          action: rule.action,
          rule: { id: rule.id, name: rule.name },
          keyword: matched,
          timeoutSeconds: rule.timeoutSeconds,
        };
      }
    }
    return null;
  }

  /**
   * ★FR-RM10a (리뷰 F1 · 보안): 작성자가 OWNER/ADMIN 이면 AutoMod 집행 비대상(true).
   * 컨트롤러가 actorRole 을 넘기면 그대로 쓰고(추가 조회 없음 — hot-path), 미지정이면
   * WorkspaceMember.role 을 1회 조회한다. 멤버가 아니면(레이스) 면제하지 않는다(false →
   * 규칙 평가 진행하되 후속 단계가 비멤버를 자연히 처리). 모더레이터는 룰을 통제·신뢰하는
   * 주체라 면제한다(Discord AutoMod parity).
   */
  private async isModeratorExempt(
    workspaceId: string,
    authorId: string,
    actorRole?: WorkspaceRole,
  ): Promise<boolean> {
    if (actorRole !== undefined) {
      return actorRole === WorkspaceRole.OWNER || actorRole === WorkspaceRole.ADMIN;
    }
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: authorId } },
      select: { role: true },
    });
    if (!member) return false;
    return member.role === WorkspaceRole.OWNER || member.role === WorkspaceRole.ADMIN;
  }

  /**
   * FR-RM10a (ADR E3): TIMEOUT 액션의 tx-후 작성자 타임아웃(best-effort). self-timeout
   * 방어는 호출부에서 author=actor 이므로 ModerationService 의 self 가드를 우회하기 위해
   * actorId 를 워크스페이스 OWNER 등으로 둘 수 없다 — 대신 system actor 가 아니라 규칙
   * 적용 결과로서 작성자 본인을 타임아웃해야 하므로, ModerationService.timeout 의 self
   * 가드를 피하려 별도 시스템 경로 대신 직접 mutedUntil 업데이트 + 감사를 수행한다.
   */
  /**
   * @returns true 면 타임아웃 적용 성공, false 면 실패(흡수됨). 리뷰 F2/F7: 호출부가 실패
   * 여부로 관측 메트릭/감사 보완을 결정할 수 있게 boolean 을 반환한다(종전 void → silent).
   */
  async applyTimeout(args: {
    workspaceId: string;
    authorId: string;
    timeoutSeconds: number;
    ruleName: string;
  }): Promise<boolean> {
    try {
      await this.moderation.timeoutBySystem({
        workspaceId: args.workspaceId,
        targetUserId: args.authorId,
        durationSeconds: args.timeoutSeconds,
        reason: `AutoMod: ${args.ruleName}`,
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `[automod] timeout apply failed ws=${args.workspaceId} author=${args.authorId}: ${String(err).slice(0, 160)}`,
      );
      return false;
    }
  }

  // ── 캐시 ─────────────────────────────────────────────────────────────────────

  /** 워크스페이스의 enabled 규칙 로드(캐시 read-through). */
  private async loadEnabledRules(workspaceId: string): Promise<CachedRule[]> {
    const now = Date.now();
    const hit = this.cache.get(workspaceId);
    if (hit && hit.expiresAt > now) return hit.rules;
    const rows = await this.prisma.autoModRule.findMany({
      where: { workspaceId, enabled: true, triggerType: 'KEYWORD' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        keywords: true,
        matchMode: true,
        action: true,
        timeoutSeconds: true,
        exemptRoleIds: true,
        exemptChannelIds: true,
      },
    });
    const rules: CachedRule[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      keywords: r.keywords,
      matchMode: r.matchMode,
      action: r.action,
      timeoutSeconds: r.timeoutSeconds,
      exemptRoleIds: r.exemptRoleIds,
      exemptChannelIds: r.exemptChannelIds,
    }));
    this.cache.set(workspaceId, { rules, expiresAt: now + AutoModService.CACHE_TTL_MS });
    return rules;
  }

  /** CRUD 시 해당 워크스페이스 규칙 캐시를 즉시 무효화한다(로컬 노드). */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }
}

/** check 에 필요한 최소 규칙 형태(캐시 저장 단위). */
interface CachedRule {
  id: string;
  name: string;
  keywords: string[];
  matchMode: AutoModMatch;
  action: AutoModAction;
  timeoutSeconds: number | null;
  exemptRoleIds: string[];
  exemptChannelIds: string[];
}

/**
 * ★ADR E1: 리터럴 키워드 매칭(정규식 없음). SUBSTRING 은 includes, WORD 는 매칭 위치의
 * 앞뒤가 단어문자(영숫자/언더스코어)가 아닌지 확인한다. haystack 은 이미 소문자다 —
 * 키워드도 normalizeKeywords 가 소문자로 저장하므로 둘 다 소문자 비교(대소문자 무시).
 * 첫 매칭 키워드를 반환(없으면 null).
 */
function matchKeyword(haystack: string, keywords: string[], mode: AutoModMatch): string | null {
  for (const kw of keywords) {
    if (kw.length === 0) continue;
    if (mode === 'SUBSTRING') {
      if (haystack.includes(kw)) return kw;
      continue;
    }
    // WORD: 모든 출현 위치를 훑어 단어 경계인 출현이 하나라도 있으면 매칭.
    let from = 0;
    for (;;) {
      const idx = haystack.indexOf(kw, from);
      if (idx === -1) break;
      const before = idx === 0 ? '' : haystack[idx - 1];
      const after = idx + kw.length >= haystack.length ? '' : haystack[idx + kw.length];
      if (!isWordChar(before) && !isWordChar(after)) return kw;
      from = idx + 1;
    }
  }
  return null;
}

/**
 * 단어 문자 판정 — 빈 문자열(경계)은 false.
 *
 * FR-RM10a (리뷰 F4): 종전 ASCII-only(`[0-9A-Za-z_]`) 판정은 한국어/CJK WORD 룰을
 * SUBSTRING 으로 degrade 시켰다(예: '욕설' WORD 룰이 '욕설쟁이' 를 매칭 = 과차단). 한국어가
 * 주 사용자이므로 인접 코드포인트를 ★유니코드 문자/숫자(+언더스코어)로 판정한다. 입력은
 * 항상 단일 문자(고정 길이)라 `/u` 정규식이라도 ReDoS 가 없다(역추적 입력 비종속).
 */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
function isWordChar(ch: string): boolean {
  if (ch.length === 0) return false;
  return WORD_CHAR_RE.test(ch);
}

/** 키워드 정규화 — trim · 소문자 · 빈 제거 · 중복 제거(순서 보존). */
function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const k = raw.trim().toLowerCase();
    if (k.length === 0 || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Prisma row → 응답 DTO. */
function toDto(row: {
  id: string;
  workspaceId: string;
  name: string;
  triggerType: string;
  keywords: string[];
  matchMode: string;
  action: string;
  timeoutSeconds: number | null;
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}): AutoModRule {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    triggerType: row.triggerType as AutoModRule['triggerType'],
    keywords: row.keywords,
    matchMode: row.matchMode as AutoModMatch,
    action: row.action as AutoModAction,
    timeoutSeconds: row.timeoutSeconds,
    exemptRoleIds: row.exemptRoleIds,
    exemptChannelIds: row.exemptChannelIds,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
