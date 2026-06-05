import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateCustomCommandRequest,
  CustomActionParams,
  HandlerType,
  ResponseType,
  SlashCommandItem,
  UpdateCustomCommandRequest,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { BUILTIN_COMMAND_NAMES } from './builtin-commands';

/**
 * S81c (D15 / FR-SC-09·10) — 워크스페이스 커스텀 슬래시 커맨드 CRUD 서비스.
 *
 * 워크스페이스 관리자(ADMIN+)가 커스텀 커맨드를 등록·수정·삭제한다. 컨트롤러가 가드
 * (ADMIN·@Roles)와 rate 를 처리하고, 이 서비스는 도메인 규칙(빌트인명 충돌 방지·중복 방지·
 * actionType→responseType 도출·소유 워크스페이스 스코프)을 담당한다.
 *
 * ★ 실행은 NestJS 내부 핸들러(configurable action)로만 한다 — 외부 URL/webhook 호출은 절대
 *   없다(PRD·SSRF 회피). handler URL 필드를 두지 않는다. 따라서 등록 시점에 actionType 으로부터
 *   responseType/handlerType 을 결정적으로 도출해 저장한다(목록/실행 라운드트립 정합).
 */
@Injectable()
export class CustomSlashCommandService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 등록(FR-SC-09). name 은 소문자 normalize·빌트인 충돌 차단·워크스페이스 내 중복 차단. */
  async create(
    workspaceId: string,
    createdBy: string,
    req: CreateCustomCommandRequest,
  ): Promise<SlashCommandItem> {
    const name = normalizeName(req.name);
    assertNotBuiltinName(name);
    const { responseType, handlerType } = deriveTypes(req.action);
    try {
      const row = await this.prisma.slashCommand.create({
        data: {
          workspaceId,
          createdBy,
          name,
          description: req.description ?? '',
          usageHint: req.usageHint ?? '',
          responseType,
          handlerType,
          actionType: req.action.actionType,
          actionParams: actionToParams(req.action),
          enabled: req.enabled ?? true,
        },
        select: SELECT_ITEM,
      });
      return toItem(row);
    } catch (err) {
      throw mapUniqueViolation(err);
    }
  }

  /** 수정(FR-SC-09). 본 워크스페이스 소유 커스텀만(빌트인은 DB 행 없어 404). 부분 갱신. */
  async update(
    workspaceId: string,
    cmdId: string,
    req: UpdateCustomCommandRequest,
  ): Promise<SlashCommandItem> {
    const data: Prisma.SlashCommandUpdateManyMutationInput = {};
    if (req.name !== undefined) {
      const name = normalizeName(req.name);
      assertNotBuiltinName(name);
      data.name = name;
    }
    if (req.description !== undefined) data.description = req.description;
    if (req.usageHint !== undefined) data.usageHint = req.usageHint;
    if (req.enabled !== undefined) data.enabled = req.enabled;
    if (req.action !== undefined) {
      const { responseType, handlerType } = deriveTypes(req.action);
      data.responseType = responseType;
      data.handlerType = handlerType;
      data.actionType = req.action.actionType;
      data.actionParams = actionToParams(req.action);
    }

    // S81c 리뷰 fix-forward(security/perf #5): 종전 findFirst({id,workspaceId}) 후
    // update({where:{id}}) 는 두 쿼리 사이에 워크스페이스 스코프가 풀려 TOCTOU 가 있었다
    // (Prisma update 는 비-unique 복합 where 미지원). remove() 의 deleteMany 선례처럼
    // updateMany({where:{id,workspaceId}}) 단일 원자 쿼리로 소유 스코프 안에서만 갱신하고,
    // count===0 → NOT_FOUND(IDOR 방지 — 타 워크스페이스 행은 존재 누출 없이 404).
    let res: Prisma.BatchPayload;
    try {
      res = await this.prisma.slashCommand.updateMany({
        where: { id: cmdId, workspaceId },
        data,
      });
    } catch (err) {
      throw mapUniqueViolation(err);
    }
    if (res.count === 0) {
      throw new DomainError(
        ErrorCode.SLASH_COMMAND_NOT_FOUND,
        '대상 커스텀 커맨드를 찾을 수 없습니다',
      );
    }
    // 갱신된 행을 재조회해 read DTO 를 돌려준다(원자 갱신은 위 updateMany 가 이미 보장 —
    // 이 시점엔 본 워크스페이스 소유가 확정된 행이므로 단순 findUnique 로 충분).
    const row = await this.prisma.slashCommand.findUnique({
      where: { id: cmdId },
      select: SELECT_ITEM,
    });
    if (!row) {
      throw new DomainError(
        ErrorCode.SLASH_COMMAND_NOT_FOUND,
        '대상 커스텀 커맨드를 찾을 수 없습니다',
      );
    }
    return toItem(row);
  }

  /** 삭제(FR-SC-09). 본 워크스페이스 소유 커스텀만. 멱등(없으면 404). */
  async remove(workspaceId: string, cmdId: string): Promise<void> {
    const res = await this.prisma.slashCommand.deleteMany({
      where: { id: cmdId, workspaceId },
    });
    if (res.count === 0) {
      throw new DomainError(
        ErrorCode.SLASH_COMMAND_NOT_FOUND,
        '대상 커스텀 커맨드를 찾을 수 없습니다',
      );
    }
  }
}

// ── 헬퍼(순수 함수 — 단위 테스트 용이) ──────────────────────────────────────────

const SELECT_ITEM = {
  id: true,
  name: true,
  description: true,
  usageHint: true,
  responseType: true,
  handlerType: true,
} as const;

type ItemRow = {
  id: string;
  name: string;
  description: string;
  usageHint: string;
  responseType: ResponseType;
  handlerType: HandlerType;
};

function toItem(row: ItemRow): SlashCommandItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    usageHint: row.usageHint,
    responseType: row.responseType,
    handlerType: row.handlerType,
    isBuiltin: false,
  };
}

/** 커맨드명 normalize: 좌우 공백 제거 + 소문자. 형식 검증은 Zod(CommandNameSchema)가 한다. */
export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 빌트인 커맨드명과 충돌하면 409(override 금지). GIPHY 게이트와 무관히 전체 빌트인명 집합 대조. */
function assertNotBuiltinName(name: string): void {
  if ((BUILTIN_COMMAND_NAMES as readonly string[]).includes(name)) {
    throw new DomainError(
      ErrorCode.SLASH_COMMAND_BUILTIN_CONFLICT,
      `"${name}" 은 빌트인 커맨드명이라 사용할 수 없습니다`,
    );
  }
}

/**
 * actionType → (responseType, handlerType) 도출. 외부 호출 없는 in-process 액션만:
 *   - EPHEMERAL_TEXT   → EPHEMERAL  / INTERNAL_ACTION
 *   - SEND_TEMPLATE    → IN_CHANNEL / INTERNAL_ACTION
 *   - REDIRECT_CHANNEL → EPHEMERAL  / INTERNAL_ACTION (navigate 동반 — 채널 미게시)
 */
export function deriveTypes(action: CustomActionParams): {
  responseType: ResponseType;
  handlerType: HandlerType;
} {
  const responseType: ResponseType =
    action.actionType === 'SEND_TEMPLATE' ? 'IN_CHANNEL' : 'EPHEMERAL';
  return { responseType, handlerType: 'INTERNAL_ACTION' };
}

/** actionParams discriminated union → DB JSON 컬럼 값(actionType 키 제외 — actionType 은 별도 컬럼). */
export function actionToParams(action: CustomActionParams): Prisma.InputJsonValue {
  switch (action.actionType) {
    case 'EPHEMERAL_TEXT':
      return { text: action.text };
    case 'SEND_TEMPLATE':
      return { template: action.template };
    case 'REDIRECT_CHANNEL':
      return { channelId: action.channelId };
  }
}

/** @@unique([workspaceId, name]) 위반(P2002)을 워크스페이스 내 중복 409 로 매핑. */
function mapUniqueViolation(err: unknown): DomainError {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new DomainError(
      ErrorCode.SLASH_COMMAND_DUPLICATE,
      '이 워크스페이스에 같은 이름의 커맨드가 이미 있습니다',
    );
  }
  if (err instanceof DomainError) return err;
  return new DomainError(ErrorCode.INTERNAL, '커스텀 커맨드 작업에 실패했습니다');
}
