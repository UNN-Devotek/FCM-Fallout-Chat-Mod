// Dev-only: ingest a targeted set of wiki pages directly (bypasses HTTP auth).
// Usage: npx tsx src/scripts/devIngest.ts "Toilet paper" "The Fixer" ...
import { runWikiIngestion } from '../services/wikiIngestionService';

const titles = process.argv.slice(2);
runWikiIngestion(titles.length ? titles : undefined)
  .then((r) => { console.log('INGEST RESULT:', JSON.stringify(r)); process.exit(0); })
  .catch((e) => { console.error('INGEST ERROR:', e); process.exit(1); });
