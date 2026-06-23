// task-078 (Family SSO / OIDC IdP): oidc-provider 용 Redis 어댑터.
//
// panva 공식 Redis 어댑터 예제를 우리 ioredis 클라이언트(@Global RedisModule, keyPrefix
// 'qufox:')로 클로저 주입하도록 포팅한다. oidc-provider 가 `new this.Adapter(name)` 로
// 모델별 인스턴스를 만들기 때문에, redis 핸들을 캡처한 *클래스* 를 팩토리로 돌려준다(버전
// 무관하게 동작). 모든 키는 'oidc:' 서브프리픽스를 붙여 메인 앱 키와 분리한다(최종 키 =
// qufox:oidc:<Model>:<id>). 휘발성 자산만 다루므로 영속 저장(Postgres)과 무관하다.
//
// consumable = 1회용(소모 표시) 모델, grantable = grantId 로 묶어 일괄 폐기되는 토큰류.
import type { Redis } from 'ioredis';

const PREFIX = 'oidc:';
const consumable = new Set([
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode',
  'BackchannelAuthenticationRequest',
]);
const grantable = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode',
  'BackchannelAuthenticationRequest',
]);

export type OidcAdapterCtor = new (name: string) => unknown;

export function makeRedisAdapter(redis: Redis): OidcAdapterCtor {
  const grantKeyFor = (id: string): string => `${PREFIX}grant:${id}`;
  const userCodeKeyFor = (userCode: string): string => `${PREFIX}userCode:${userCode}`;
  const uidKeyFor = (uid: string): string => `${PREFIX}uid:${uid}`;

  return class RedisAdapter {
    private readonly name: string;

    constructor(name: string) {
      this.name = name;
    }

    private key(id: string): string {
      return `${PREFIX}${this.name}:${id}`;
    }

    async upsert(id: string, payload: Record<string, any>, expiresIn: number): Promise<void> {
      const key = this.key(id);
      const multi = redis.multi();
      if (consumable.has(this.name)) {
        multi.hmset(key, { payload: JSON.stringify(payload) });
      } else {
        multi.set(key, JSON.stringify(payload));
      }
      if (expiresIn) {
        multi.expire(key, expiresIn);
      }
      if (grantable.has(this.name) && payload.grantId) {
        // grant 키는 같은 grant 에 속한 토큰 키들을 모은 리스트 — revokeByGrantId 로 일괄 폐기.
        const grantKey = grantKeyFor(payload.grantId);
        multi.rpush(grantKey, key);
        const ttl = await redis.ttl(grantKey);
        if (expiresIn > ttl) {
          multi.expire(grantKey, expiresIn);
        }
      }
      if (payload.userCode) {
        const userCodeKey = userCodeKeyFor(payload.userCode);
        multi.set(userCodeKey, id);
        if (expiresIn) multi.expire(userCodeKey, expiresIn);
      }
      // findByUid 는 Session 에서만 호출된다(provider.js). Session 외 모델(Interaction 도
      // uid 보유)에 대해 역인덱스를 쓰면 낭비 + 단일 네임스페이스 공유다 — Session 으로 한정.
      if (this.name === 'Session' && payload.uid) {
        const uidKey = uidKeyFor(payload.uid);
        multi.set(uidKey, id);
        if (expiresIn) multi.expire(uidKey, expiresIn);
      }
      await multi.exec();
    }

    async find(id: string): Promise<any> {
      const data = consumable.has(this.name)
        ? await redis.hgetall(this.key(id))
        : await redis.get(this.key(id));
      if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
        return undefined;
      }
      if (typeof data === 'string') {
        return JSON.parse(data);
      }
      const { payload, ...rest } = data as Record<string, string>;
      return { ...rest, ...JSON.parse(payload) };
    }

    async findByUid(uid: string): Promise<any> {
      const id = await redis.get(uidKeyFor(uid));
      return id ? this.find(id) : undefined;
    }

    async findByUserCode(userCode: string): Promise<any> {
      const id = await redis.get(userCodeKeyFor(userCode));
      return id ? this.find(id) : undefined;
    }

    async destroy(id: string): Promise<void> {
      await redis.del(this.key(id));
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      const grantKey = grantKeyFor(grantId);
      const tokens = await redis.lrange(grantKey, 0, -1);
      const multi = redis.multi();
      tokens.forEach((token) => multi.del(token));
      multi.del(grantKey);
      await multi.exec();
    }

    async consume(id: string): Promise<void> {
      await redis.hset(this.key(id), 'consumed', Math.floor(Date.now() / 1000));
    }
  };
}
