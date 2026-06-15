/**
 * mint-mcp-token.ts — Owner-run CLI to mint a prod (or dev) MCP token.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json scripts/mint-mcp-token.ts \
 *     --env prod \
 *     --owner <discordUserId> \
 *     --label "Claude Desktop – prod"
 *
 * The plaintext token is printed ONCE to stdout and never stored.
 * Only the SHA-256 hash is persisted in the DB.
 *
 * Must be run against the target environment's backend (i.e. with the
 * prod DATABASE_URL loaded). The user identified by --owner must already
 * exist in the DB (they must have logged in at least once).
 */

import '../src/config/environment'; // loads .env / .env.local
import { mintToken } from '../src/services/mcpTokenService';
import prisma from '../src/config/prisma';

function parseArgs(): { env: 'dev' | 'prod'; owner: string; label: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const env = get('--env');
  const owner = get('--owner');
  const label = get('--label') ?? '';

  if (!env || (env !== 'dev' && env !== 'prod')) {
    console.error('Error: --env must be "dev" or "prod"');
    process.exit(1);
  }
  if (!owner || owner.trim() === '') {
    console.error('Error: --owner <discordUserId> is required');
    process.exit(1);
  }

  return { env, owner: owner.trim(), label };
}

async function main(): Promise<void> {
  const { env, owner, label } = parseArgs();

  // Verify the user exists
  const user = await prisma.user.findUnique({
    where: { id: owner },
    select: { id: true, username: true },
  });

  if (!user) {
    console.error(`Error: No user found with id "${owner}". They must have logged in first.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const { id, token, expiresAt } = await mintToken(owner, env, label || undefined);

  console.log('\n=== MCP Token Minted ===');
  console.log(`Token ID  : ${id}`);
  console.log(`Owner     : ${user.username} (${user.id})`);
  console.log(`Env       : ${env}`);
  console.log(`Label     : ${label || '(none)'}`);
  console.log(`Expires   : ${expiresAt.toISOString()}`);
  console.log(`\nToken (copy now — shown once):\n\n  ${token}\n`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err);
  prisma.$disconnect().catch(() => {});
  process.exit(1);
});
