/**
 * Deterministic seed — uuid v5 with fixed namespace.
 * Same inputs always yield same IDs across machines and runs.
 * Passwords are argon2id-hashed at seed time from a fixed plaintext ("Password1!"),
 * so hashes themselves are nondeterministic — we upsert by id so the row survives
 * repeated runs regardless.
 */
import { PrismaClient, WorkspaceRole, ChannelType } from '@prisma/client';
import { v5 as uuidv5 } from 'uuid';
import { hash as argon2Hash } from '@node-rs/argon2';

const NAMESPACE = process.env.SEED_NAMESPACE ?? '00000000-0000-0000-0000-000000000000';

const id = (kind: string, key: string) => uuidv5(`${kind}:${key}`, NAMESPACE);

const prisma = new PrismaClient();

async function hashSeedPassword(plain: string): Promise<string> {
  return argon2Hash(plain, {
    memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 19456),
    timeCost: Number(process.env.ARGON2_TIME_COST ?? 2),
    parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
  });
}

async function main() {
  const aliceId = id('user', 'alice');
  const bobId = id('user', 'bob');
  const seedPasswordHash = await hashSeedPassword('Password1!');

  // S72 (D13 / FR-W15): 익명화 대상 시스템 사용자(SYSTEM_ANON). 워크스페이스 30일 grace
  // purge 시 Message.authorId 를 이 사용자로 익명화한다(내용 보존, 작성자만 마스킹). FK
  // (Message.authorId → User)가 유효하려면 이 행이 반드시 존재해야 하므로 seed 와
  // purge.sh 가 선행 idempotent insert 로 보장한다. ID 는 env ANON_AUTHOR_UUID 우선,
  // 미설정 시 결정론 uuid v5(user:system-anon). emailVerified 는 게이트 우회용으로 true.
  // 멤버십이 없어 어떤 워크스페이스에도 보이지 않는 placeholder 다.
  //
  // S72 fix-forward (security HIGH = #5): passwordHash 를 argon2 해시가 아니라
  // 비-argon2 sentinel('x-no-login-<anonId>')로 저장한다. 종전엔
  // hashSeedPassword('anon-${anonId}-no-login') 의 실제 argon2 해시를 썼는데, 그 평문은
  // .env.example 의 공개 SEED_NAMESPACE + ANON_AUTHOR_UUID 에서 결정론적으로 유도 가능해
  // dev/staging 에서 SYSTEM_ANON 으로 로그인이 가능했다. argon2 verify() 는 sentinel
  // 문자열을 구조적으로 파싱 실패하므로(어떤 평문도 매칭 불가), 로그인 불가가 *구조로*
  // 보장된다. purge.sh 의 SYSTEM_ANON insert 와 동일한 sentinel 형식으로 통일한다.
  const anonId = process.env.ANON_AUTHOR_UUID ?? id('user', 'system-anon');
  const anonSentinelHash = `x-no-login-${anonId}`;
  await prisma.user.upsert({
    where: { id: anonId },
    update: { passwordHash: anonSentinelHash },
    create: {
      id: anonId,
      email: 'anon@system.qufox',
      username: 'deleted-user',
      passwordHash: anonSentinelHash,
      emailVerified: true,
    },
  });
  const wsId = id('workspace', 'acme');
  const generalChannelId = id('channel', 'acme:general');
  const randomChannelId = id('channel', 'acme:random');

  // S66 (D13 / FR-W05a/W05b): 시드 사용자는 emailVerified=true 로 생성한다 — dev 에서
  // 워크스페이스 진입·메시지 전송 게이트(EMAIL_NOT_VERIFIED)에 막히지 않도록. 신규 가입
  // 경로(signup)는 default false 로 시작하고 verify-email 로 전환된다.
  await prisma.user.upsert({
    where: { id: aliceId },
    update: { emailVerified: true },
    create: {
      id: aliceId,
      email: 'alice@qufox.dev',
      username: 'alice',
      passwordHash: seedPasswordHash,
      emailVerified: true,
    },
  });
  await prisma.user.upsert({
    where: { id: bobId },
    update: { emailVerified: true },
    create: {
      id: bobId,
      email: 'bob@qufox.dev',
      username: 'bob',
      passwordHash: seedPasswordHash,
      emailVerified: true,
    },
  });

  await prisma.workspace.upsert({
    where: { id: wsId },
    update: {},
    create: { id: wsId, name: 'Acme', slug: 'acme', ownerId: aliceId },
  });

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: wsId, userId: aliceId } },
    update: {},
    create: { workspaceId: wsId, userId: aliceId, role: WorkspaceRole.OWNER },
  });
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: wsId, userId: bobId } },
    update: {},
    create: { workspaceId: wsId, userId: bobId, role: WorkspaceRole.MEMBER },
  });

  await prisma.channel.upsert({
    where: { id: generalChannelId },
    update: {},
    create: {
      id: generalChannelId,
      workspaceId: wsId,
      name: 'general',
      type: ChannelType.TEXT,
      position: '1000000000.0000000000',
    },
  });
  await prisma.channel.upsert({
    where: { id: randomChannelId },
    update: {},
    create: {
      id: randomChannelId,
      workspaceId: wsId,
      name: 'random',
      type: ChannelType.TEXT,
      position: '2000000000.0000000000',
    },
  });

  const messages = [
    { key: 'm1', author: aliceId, ch: generalChannelId, content: 'welcome to qufox' },
    { key: 'm2', author: bobId, ch: generalChannelId, content: 'hey alice' },
    { key: 'm3', author: aliceId, ch: generalChannelId, content: 'first channel is set' },
    { key: 'm4', author: bobId, ch: randomChannelId, content: 'random chatter' },
    { key: 'm5', author: aliceId, ch: randomChannelId, content: 'seeded.' },
  ];
  for (const m of messages) {
    const mid = id('message', m.key);
    await prisma.message.upsert({
      where: { id: mid },
      update: {},
      create: {
        id: mid,
        channelId: m.ch,
        authorId: m.author,
        content: m.content,
        contentPlain: m.content,
      },
    });
  }

  console.log('[seed] deterministic seed applied');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
