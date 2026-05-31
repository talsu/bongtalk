/**
 * ADR-11 · BigInt 직렬화 단일 헬퍼.
 *
 * 응답 DTO 의 allow/deny 등 모든 BigInt 는 String 으로 직렬화합니다. NestJS
 * 글로벌 인터셉터(apps/api BigIntSerializationInterceptor)가 본 헬퍼를 재사용
 * 하며, 개별 DTO/엔티티에서 직렬화 로직을 별도 구현하지 않습니다. 수신 시에는
 * 서비스 레이어에서 BigInt(str) 로 역변환합니다. DTO 타입 표기는
 * `string (BigInt as string)`.
 *
 * JSON.stringify 의 number 정밀도 한계(2^53)를 우회하기 위해 stringify 가 아닌
 * 구조 순회로 변환하므로 ADMINISTRATOR(1n<<63n) 비트도 손실 없이 직렬화됩니다.
 */

/** JSON.stringify replacer: bigint → 10진 string. */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * 응답 객체/배열을 깊이 순회하며 bigint 값을 string 으로 치환한 새 구조를
 * 반환합니다. Date / 기타 클래스 인스턴스는 재귀하지 않고 그대로 보존합니다
 * (인터셉터가 직렬화 직전에만 호출하므로 원본 변형은 일어나지 않습니다).
 *
 * 순환참조 방어(reviewer S01 MAJOR): plain object/array 는 WeakSet 으로
 * 방문 추적하여 cycle 진입 시 원본 노드를 그대로 반환합니다(무한 재귀 →
 * RangeError 방지). Prisma 관계 객체처럼 양방향 참조가 섞여도 안전합니다.
 */
export function serializeBigInts<T>(value: T): unknown {
  return serializeNode(value, new WeakSet<object>());
}

function serializeNode(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Date / Buffer / 기타 비-plain 객체는 그대로 통과 — 순회 대상은 plain
  // object 와 배열뿐. (응답 DTO 는 plain object 트리라는 가정.)
  const isArray = Array.isArray(value);
  if (!isArray) {
    const proto = Object.getPrototypeOf(value as object);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
  }
  // cycle 진입 가드 — 이미 방문한 plain 노드는 더 내려가지 않고 원본 반환.
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  if (isArray) {
    return (value as unknown[]).map((item) => serializeNode(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = serializeNode(v, seen);
  }
  return out;
}

/**
 * 페이로드 트리에 bigint 가 하나라도 있는지 얕은-우선 깊이 탐색으로 판정.
 * 인터셉터 핫패스(메시지 목록 등)에서 bigint 가 없으면 deep-copy 를
 * 건너뛰고 원본을 그대로 반환하기 위한 early-exit 용도입니다.
 */
export function hasBigInt(value: unknown): boolean {
  return hasBigIntNode(value, new WeakSet<object>());
}

function hasBigIntNode(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === 'bigint') {
    return true;
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const isArray = Array.isArray(value);
  if (!isArray) {
    const proto = Object.getPrototypeOf(value as object);
    if (proto !== Object.prototype && proto !== null) {
      return false;
    }
  }
  if (seen.has(value as object)) {
    return false;
  }
  seen.add(value as object);
  if (isArray) {
    return (value as unknown[]).some((item) => hasBigIntNode(item, seen));
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (hasBigIntNode(v, seen)) {
      return true;
    }
  }
  return false;
}
