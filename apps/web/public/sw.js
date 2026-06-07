/* S86 (FR-MN-15): qufox Web Push Service Worker.
 *
 * 두 가지 이벤트만 처리한다(앱 셸 캐싱/오프라인은 본 슬라이스 밖):
 *   - push:               서버가 web-push 로 보낸 PushNotificationPayload(JSON)를 파싱해
 *                         showNotification(제목/본문/아이콘/data.url)으로 알림을 띄운다.
 *   - notificationclick:  알림 클릭 시 이미 열린 같은-origin 탭이 있으면 focus,
 *                         없으면 data.url(채널/메시지 딥링크)로 openWindow 한다.
 *
 * 페이로드가 비거나 JSON 이 아니어도 사용자에게 일반 알림을 띄운다(안전 폴백). 실 전송/실동작은
 * e2e·수동 검증 대상이며(단위 게이트 밖), 본 파일은 표준 Web Push SW 패턴을 따른다.
 */

self.addEventListener('install', (event) => {
  // 새 SW 를 즉시 활성화(대기 없이 교체).
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 모든 클라이언트를 즉시 이 SW 통제 하에 둔다.
  event.waitUntil(self.clients.claim());
});

function parsePayload(event) {
  if (!event.data) {
    return { title: '새 알림', body: '새 알림이 도착했습니다.' };
  }
  try {
    const data = event.data.json();
    return {
      title: typeof data.title === 'string' && data.title ? data.title : '새 알림',
      body: typeof data.body === 'string' ? data.body : '',
      icon: typeof data.icon === 'string' ? data.icon : '/brand-assets/icon-192.png',
      url: typeof data.url === 'string' ? data.url : '/',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
    };
  } catch (_err) {
    // JSON 이 아니면 평문 본문으로 폴백.
    return { title: '새 알림', body: event.data.text(), url: '/' };
  }
}

self.addEventListener('push', (event) => {
  const payload = parsePayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      tag: payload.tag,
      data: { url: payload.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // 같은 origin 의 열린 탭이 있으면 focus 후 라우팅(navigate 가능하면 이동).
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client && targetUrl) {
            return client.navigate(targetUrl).catch(() => undefined);
          }
          return undefined;
        }
      }
      // 열린 탭이 없으면 새 창을 연다.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
