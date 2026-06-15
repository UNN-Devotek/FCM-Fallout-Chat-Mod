/**
 * regenerateAliases — rebuild auto-generated wiki_aliases from current entry
 * names using generateAliases(). DB-only (no Fandom calls). Preserves any
 * source='curated' aliases. Run after changing generateAliases().
 *   npx tsx src/scripts/regenerateAliases.ts
 */
import prisma from '../config/prisma';
import { generateAliases } from '../services/wikiIngestionService';

(async () => {
  const entries = await prisma.wikiEntry.findMany({
    where: { isStale: false },
    select: { id: true, name: true },
  });
  let aliasCount = 0;
  let i = 0;
  for (const e of entries) {
    const aliases = generateAliases(e.name);
    await prisma.wikiAlias.deleteMany({ where: { wikiEntryId: e.id, source: 'auto' } });
    if (aliases.length) {
      await prisma.wikiAlias.createMany({
        data: aliases.map(a => ({ wikiEntryId: e.id, alias: a, source: 'auto' })),
        skipDuplicates: true,
      });
      aliasCount += aliases.length;
    }
    if (++i % 1000 === 0) console.log(`  ...${i}/${entries.length}`);
  }
  console.log(`regenerated aliases for ${entries.length} entries; ${aliasCount} auto-aliases written`);
  process.exit(0);
})().catch(err => { console.error('ERR', err); process.exit(1); });
