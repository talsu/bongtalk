/**
 * S56 (D11) — re-export shim. 구현은 features/attachments/AttachmentsList 로 이동했고
 * 캐논 AttachmentLite 는 @qufox/shared-types 가 단일 출처입니다. 기존 import 경로
 * 무회귀를 위해 얇은 재노출만 남깁니다.
 */
export { AttachmentsList } from '../attachments/AttachmentsList';
export type { AttachmentLite } from '@qufox/shared-types';
