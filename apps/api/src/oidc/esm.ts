// task-078 (Family SSO / OIDC IdP): ESM-only 의존성 로더.
//
// oidc-provider@9 와 jose@6 는 둘 다 `"type":"module"`(ESM 전용)이다. 이 앱은 SWC 로
// CommonJS 빌드되는데, SWC 의 commonjs 변환은 기본적으로 `import()` 를 `require()`+interop
// 으로 바꾼다 — ESM 전용 패키지는 require() 로 못 불러오므로(ERR_REQUIRE_ESM) 런타임에
// 깨진다. 그래서 .swcrc 에 `module.ignoreDynamic: true` 를 켜서 `import()` 를 *네이티브*
// 그대로 보존시킨다(이 앱의 유일한 런타임 동적 import 가 여기뿐이라 전역 영향 없음).
// vitest 는 swc 플러그인이 `module.type: es6` 라 원래 import() 를 보존한다 — 양쪽 동일.
// Node 20/22 의 CJS→ESM 브리지가 런타임에 ESM 을 적재한다.
export function esmImport(specifier: string): Promise<any> {
  return import(specifier);
}
