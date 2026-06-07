import { useCallback, useEffect, useState } from 'react';
import { useNotifications } from '../../stores/notification-store';
import { enablePush, resolvePushPermission, type PushPermissionState } from './webPush';

/**
 * S86 (FR-MN-15): 설정 "알림" 탭의 브라우저 알림 권한 UX.
 *
 * 첫 진입 자동 요청 금지 — 권한 요청(requestPermission)은 "브라우저 알림 허용하기" 버튼 클릭
 * 시에만 호출한다(enablePush 내부). 상태별 분기:
 *   - unsupported: 미지원 안내(버튼 숨김).
 *   - default:     "브라우저 알림 허용하기" 버튼.
 *   - granted:     허용됨 안내.
 *   - denied:      차단 안내 카피 + "알림 설정 방법 보기" 링크(브라우저 사이트 설정 안내).
 *
 * userAgent 분기 없이 동일 카피(PRD). DS qf-* + 토큰만 사용한다(raw hex/px 금지).
 */
export function PushPermissionSection(): JSX.Element {
  const notify = useNotifications((s) => s.push);
  const [state, setState] = useState<PushPermissionState>('default');
  const [busy, setBusy] = useState(false);

  // 마운트 시 현재 권한을 *읽기만* 한다(요청 아님 — 자동 요청 금지).
  useEffect(() => {
    setState(resolvePushPermission());
  }, []);

  const onEnable = useCallback(async () => {
    setBusy(true);
    try {
      const { outcome } = await enablePush();
      // 요청 직후 실제 권한을 다시 읽어 UI 를 동기화한다.
      setState(resolvePushPermission());
      if (outcome === 'subscribed') {
        notify({ variant: 'success', title: '브라우저 알림이 켜졌습니다' });
      } else if (outcome === 'denied') {
        notify({
          variant: 'danger',
          title: '브라우저 알림이 거부되었습니다',
          body: '브라우저 사이트 권한 설정에서 알림을 허용한 후 다시 시도해 주세요.',
        });
      } else if (outcome === 'no-key') {
        notify({
          variant: 'danger',
          title: '알림을 켤 수 없습니다',
          body: '서버에 푸시 키가 설정되어 있지 않습니다. 관리자에게 문의해 주세요.',
        });
      }
    } catch (err) {
      notify({
        variant: 'danger',
        title: '브라우저 알림 설정 실패',
        body: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }, [notify]);

  return (
    <section
      className="mb-[var(--s-6)] rounded-[var(--r-xl)] border border-border bg-bg-surface p-[var(--s-5)]"
      data-testid="push-permission-section"
      aria-labelledby="push-permission-heading"
    >
      <h2
        id="push-permission-heading"
        className="mb-[var(--s-1)] text-[length:var(--fs-16)] font-semibold text-text-strong"
      >
        브라우저 알림
      </h2>
      <p className="mb-[var(--s-4)] text-[length:var(--fs-12)] text-text-muted">
        멘션 등 중요한 알림을 브라우저 푸시로 받습니다. 탭을 닫아도 알림이 도착합니다.
      </p>

      {state === 'unsupported' && (
        <p className="text-[length:var(--fs-14)] text-text-muted" data-testid="push-unsupported">
          이 브라우저는 푸시 알림을 지원하지 않습니다.
        </p>
      )}

      {state === 'default' && (
        <button
          type="button"
          className="qf-btn qf-btn--primary qf-btn--md"
          data-testid="push-enable-button"
          disabled={busy}
          onClick={() => void onEnable()}
        >
          브라우저 알림 허용하기
        </button>
      )}

      {state === 'granted' && (
        <p className="text-[length:var(--fs-14)] text-text-strong" data-testid="push-granted">
          브라우저 알림이 허용되어 있습니다.
        </p>
      )}

      {state === 'denied' && (
        <div data-testid="push-denied">
          <p className="mb-[var(--s-2)] text-[length:var(--fs-14)] text-text-strong">
            브라우저 알림이 차단되어 있습니다. 사이트 권한 설정에서 알림을 허용한 후 새로고침해
            주세요.
          </p>
          <a
            className="qf-btn--link text-[length:var(--fs-13)]"
            href="https://support.google.com/chrome/answer/3220216"
            target="_blank"
            rel="noreferrer"
            data-testid="push-denied-help"
          >
            알림 설정 방법 보기
          </a>
        </div>
      )}
    </section>
  );
}
