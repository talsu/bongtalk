import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

  // ── check (send/edit hook) ──────────────────────────────────────────────────

  /**
   * FR-RM10a (ADR E3): 메시지 send/edit hook 평가. enabled KEYWORD 규칙들을 순서대로
   * 평가해 첫 매칭의 {action, rule, keyword} 를 반환한다(매칭 없으면 null).
   *
   * 각 규칙: 채널 exempt(channelId ∈ exemptChannelIds) 또는 역할 exempt(actorRoleIds ∩
   * exemptRoleIds) 면 건너뛴다 → ★리터럴 매칭(contentPlain 소문자 vs keywords·정규식 없음).
   * DM(workspaceId=null)은 워크스페이스 규칙이 없으므로 즉시 null. 콘텐츠/키워드 길이는
   * cap 해 매칭 비용을 bounded 로 둔다.
   */
  async check(args: {
    workspaceId: string | null;
    channelId: string;
    authorId: string;
    actorRoleIds: string[];
    contentPlain: string;
  }): Promise<{
    action: AutoModAction;
    rule: { id: string; name: string };
    keyword: string;
    timeoutSeconds: number | null;
  } | null> {
    // DM(워크스페이스 없음) 또는 빈 본문은 평가 대상이 아니다.
    if (args.workspaceId === null) return null;
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
   * FR-RM10a (ADR E3): TIMEOUT 액션의 tx-후 작성자 타임아웃(best-effort). self-timeout
   * 방어는 호출부에서 author=actor 이므로 ModerationService 의 self 가드를 우회하기 위해
   * actorId 를 워크스페이스 OWNER 등으로 둘 수 없다 — 대신 system actor 가 아니라 규칙
   * 적용 결과로서 작성자 본인을 타임아웃해야 하므로, ModerationService.timeout 의 self
   * 가드를 피하려 별도 시스템 경로 대신 직접 mutedUntil 업데이트 + 감사를 수행한다.
   */
  async applyTimeout(args: {
    workspaceId: string;
    authorId: string;
    timeoutSeconds: number;
    ruleName: string;
  }): Promise<void> {
    try {
      await this.moderation.timeoutBySystem({
        workspaceId: args.workspaceId,
        targetUserId: args.authorId,
        durationSeconds: args.timeoutSeconds,
        reason: `AutoMod: ${args.ruleName}`,
      });
    } catch (err) {
      this.logger.warn(
        `[automod] timeout apply failed ws=${args.workspaceId} author=${args.authorId}: ${String(err).slice(0, 160)}`,
      );
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

/** 단어 문자 판정(영숫자 + 언더스코어). 빈 문자열(경계)은 false. */
function isWordChar(ch: string): boolean {
  if (ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 // _
  );
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
