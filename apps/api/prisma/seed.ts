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
  const wsId = id('workspace', 'acme');
  const generalChannelId = id('channel', 'acme:general');
  const randomChannelId = id('channel', 'acme:random');

  await prisma.user.upsert({
    where: { id: aliceId },
    update: {},
    create: {
      id: aliceId,
      email: 'alice@qufox.dev',
      username: 'alice',
      passwordHash: seedPasswordHash,
    },
  });
  await prisma.user.upsert({
    where: { id: bobId },
    update: {},
    create: {
      id: bobId,
      email: 'bob@qufox.dev',
      username: 'bob',
      passwordHash: seedPasswordHash,
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
