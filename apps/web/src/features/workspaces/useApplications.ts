import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApplicationAnswer,
  ApplicationStatus,
  ProcessApplicationAction,
} from '@qufox/shared-types';
import {
  getMyApplication,
  listApplications,
  processApplication,
  submitApplication,
  withdrawApplication,
} from './api';
import { qk } from '../../lib/query-keys';

/**
 * S70 (D13 / FR-W06·W06a): 가입 신청(APPLY 모드) hooks. 신청 API 는 PRD 정본대로 :slug
 * 라우팅이라 쿼리 키도 slug 로 둔다(워크스페이스 id 쿼리와 별개).
 */

/** FR-W06: ADMIN 신청 목록(status 필터). */
export function useApplications(slug: string, status?: ApplicationStatus, enabled = true) {
  return useQuery({
    queryKey: qk.workspaces.applications(slug, status),
    queryFn: () => listApplications(slug, status),
    enabled: enabled && slug.length > 0,
  });
}

/**
 * FR-W06a: 본인 신청 상태. WS 끊김 시 30초 polling fallback. wsConnected=false 면
 * refetchInterval 을 30초로 켜고(끊김 동안만 폴링), 연결되면 끈다(WS 이벤트가 진실값 —
 * dispatcher 가 이 키를 무효화해 즉시 갱신). 화면 비활성(백그라운드)에서는 폴링하지 않는다.
 */
export function useMyApplication(
  slug: string,
  opts?: { wsConnected?: boolean; enabled?: boolean },
) {
  const wsConnected = opts?.wsConnected ?? true;
  const enabled = opts?.enabled ?? true;
  return useQuery({
    queryKey: qk.workspaces.myApplication(slug),
    queryFn: () => getMyApplication(slug),
    enabled: enabled && slug.length > 0,
    // WS 끊김 시에만 30초 폴링(연결되면 0=비활성 — WS 이벤트가 무효화 트리거).
    refetchInterval: wsConnected ? false : 30_000,
    refetchIntervalInBackground: false,
  });
}

/** FR-W06: 신청 제출. */
export function useSubmitApplication(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (answers: ApplicationAnswer[]) => submitApplication(slug, answers),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaces.myApplication(slug) });
    },
  });
}

/** FR-W06: 신청 처리(approve/reject/interview). */
export function useProcessApplication(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      applicationId: string;
      action: ProcessApplicationAction;
      reviewNote?: string;
    }) => processApplication(slug, vars.applicationId, vars.action, vars.reviewNote),
    onSuccess: () => {
      // 모든 status 필터 변형을 무효화(목록/대기화면 동시 갱신).
      qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === 'workspaces' &&
          q.queryKey[1] === slug &&
          q.queryKey[2] === 'applications',
      });
    },
  });
}

/** FR-W06: 신청 취소(본인, PENDING → WITHDRAWN). */
export function useWithdrawApplication(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (applicationId: string) => withdrawApplication(slug, applicationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaces.myApplication(slug) });
    },
  });
}
