import { z } from 'zod';

/**
 * S70 (D13 / FR-W06·W06a·W12): 가입 신청(APPLY 모드) 컨트랙트.
 *
 * APPLY 모드 워크스페이스에 신청자가 커스텀 질문(최대 5개) 응답과 함께 제출하고,
 * ADMIN+ 가 승인/인터뷰·MODERATOR+ 가 거절을 처리한다. 신청자는 대기 화면에서
 * ws:application_reviewed(또는 30초 polling fallback)로 결과를 받는다. 와이어 상태
 * 문자열(approved/rejected/interview)은 Prisma enum(APPROVED/...)과 별개의 소문자
 * 표현으로, member:kicked 등 기존 콜론 wire 와 동일한 외부 노출 규약을 따른다.
 */

// Prisma ApplicationStatus enum 과 1:1 동기. 본인 상태 조회(me)·ADMIN 목록 응답에 쓴다.
export const ApplicationStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'INTERVIEW',
  'WITHDRAWN',
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

// FR-W06: 신청자 1명이 응답할 수 있는 커스텀 질문 최대 개수.
export const APPLICATION_MAX_ANSWERS = 5;
// 응답 1건의 본문 길이 상한(reviewNote·메시지 길이 정책과 보수적으로 정렬).
export const APPLICATION_ANSWER_MAX_LEN = 2000;
// FR-W06a: REJECTED 후 재신청 쿨다운(24h). 서비스가 createdAt 기준으로 검사한다.
export const APPLICATION_REAPPLY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * 단일 질문 응답. questionId 는 질문 카탈로그(OnboardingQuestion, carryover) 도입 전까지
 * 자유형 문자열로 둔다(S70 은 answers 를 저장만 하고 카탈로그 검증은 하지 않는다).
 */
export const ApplicationAnswerSchema = z.object({
  questionId: z.string().min(1).max(128),
  answer: z.string().max(APPLICATION_ANSWER_MAX_LEN),
});
export type ApplicationAnswer = z.infer<typeof ApplicationAnswerSchema>;

// FR-W06: 신청 제출. answers 는 최대 5개(빈 배열 허용 — 질문 미설정 워크스페이스).
export const SubmitApplicationRequestSchema = z.object({
  answers: z.array(ApplicationAnswerSchema).max(APPLICATION_MAX_ANSWERS).default([]),
});
export type SubmitApplicationRequest = z.infer<typeof SubmitApplicationRequestSchema>;

// FR-W06: 신청 처리. approve/interview 는 ADMIN+, reject 는 MODERATOR+(서비스 게이트).
// reviewNote 는 reject(거절 사유 노출)에 주로 쓰이며 ≤500자(DB VarChar(500) 정합).
export const ProcessApplicationActionSchema = z.enum(['approve', 'reject', 'interview']);
export type ProcessApplicationAction = z.infer<typeof ProcessApplicationActionSchema>;

export const ProcessApplicationRequestSchema = z.object({
  action: ProcessApplicationActionSchema,
  reviewNote: z.string().max(500).optional(),
});
export type ProcessApplicationRequest = z.infer<typeof ProcessApplicationRequestSchema>;

/**
 * 신청 1건 응답 shape. ADMIN 목록 행 + 본인 상태(me) 조회가 공유한다. applicant 표시
 * 정보는 best-effort 조인(없으면 null). interviewChannelId 는 INTERVIEW 전환 후에만 채워진다.
 */
export const WorkspaceMemberApplicationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  applicantId: z.string().uuid(),
  status: ApplicationStatusSchema,
  answers: z.array(ApplicationAnswerSchema),
  reviewedById: z.string().uuid().nullable(),
  reviewNote: z.string().nullable(),
  interviewChannelId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // 목록 표시용 신청자 프로필(best-effort 조인). 본인 상태(me) 조회에서는 생략 가능.
  applicant: z.object({ id: z.string().uuid(), username: z.string() }).nullable().optional(),
});
export type WorkspaceMemberApplication = z.infer<typeof WorkspaceMemberApplicationSchema>;

// ADMIN 목록 응답.
export const ListApplicationsResponseSchema = z.object({
  applications: z.array(WorkspaceMemberApplicationSchema),
});
export type ListApplicationsResponse = z.infer<typeof ListApplicationsResponseSchema>;

// 본인 상태(me) 조회 응답. 신청 이력이 없으면 application=null(폴링이 404 대신 빈 상태 수신).
export const MyApplicationResponseSchema = z.object({
  application: WorkspaceMemberApplicationSchema.nullable(),
});
export type MyApplicationResponse = z.infer<typeof MyApplicationResponseSchema>;
