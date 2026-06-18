import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// admin-dashboard/index.html is the document shipped to crawlers and browsers.
// These tests guard the SEO markup added for search/social previews AND the
// fix for the self-redirecting <noscript> meta-refresh (which trapped no-JS
// crawlers in an infinite reload loop because the page IS the apex origin).
const INDEX_HTML_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../index.html');
const ORIGIN = 'https://falloutchatmod.com';

let html: string;
let doc: Document;

beforeAll(() => {
  html = readFileSync(INDEX_HTML_PATH, 'utf-8');
  doc = new DOMParser().parseFromString(html, 'text/html');
});

describe('index.html <noscript> fallback (security/availability fix)', () => {
  it('does NOT contain a meta-refresh that redirects the apex origin to itself', () => {
    // The bug: <meta http-equiv="refresh" content="0; url=https://falloutchatmod.com">
    // inside <noscript>. The page is served AT that origin, so the refresh redirects
    // the page to itself => infinite reload loop for the no-JS crawlers it targets.
    const refreshMetas = Array.from(doc.querySelectorAll('meta[http-equiv]')).filter(
      (m) => (m.getAttribute('http-equiv') || '').toLowerCase() === 'refresh',
    );

    for (const meta of refreshMetas) {
      const content = (meta.getAttribute('content') || '').toLowerCase();
      // A refresh pointing at the apex origin (with or without trailing path) is the loop.
      expect(content).not.toContain(ORIGIN.toLowerCase());
    }

    // Stronger guard: there must be no http-equiv="refresh" inside <noscript> at all,
    // since any self-targeted refresh from the apex is a loop and an absolute external
    // redirect would defeat the indexable fallback. Match the raw source so the test
    // fails if the meta-refresh is reintroduced regardless of where it sits.
    expect(html).not.toMatch(/<noscript>[\s\S]*http-equiv\s*=\s*["']refresh["'][\s\S]*<\/noscript>/i);
  });

  it('keeps the descriptive no-JS fallback text for crawlers', () => {
    // jsdom parses <noscript> content as inert text, so read the raw source block
    // rather than the live DOM to inspect what crawlers actually receive.
    const match = html.match(/<noscript>([\s\S]*?)<\/noscript>/i);
    expect(match).not.toBeNull();
    const inner = match?.[1] ?? '';
    expect(inner).toContain('Fallout Chat Mod');
    // Strip tags to assert real descriptive prose, not just markup.
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(text.length).toBeGreaterThan(80);
  });
});

describe('index.html SEO markup', () => {
  it('has a descriptive, non-placeholder <title>', () => {
    const title = doc.querySelector('title')?.textContent ?? '';
    expect(title).toContain('Fallout Chat Mod');
    expect(title).not.toBe('FCM');
  });

  it('has a meta description', () => {
    const desc = doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
    expect(desc.length).toBeGreaterThan(50);
  });

  it('declares a canonical URL at the apex origin', () => {
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
    expect(canonical).toBe(ORIGIN);
  });

  it('has Open Graph title/description/url/image', () => {
    const og = (prop: string) =>
      doc.querySelector(`meta[property="og:${prop}"]`)?.getAttribute('content') ?? '';
    expect(og('title')).toContain('Fallout Chat Mod');
    expect(og('description').length).toBeGreaterThan(20);
    expect(og('url')).toBe(ORIGIN);
    expect(og('image')).toMatch(/^https:\/\//);
  });

  it('has a Twitter summary_large_image card', () => {
    const card = doc.querySelector('meta[name="twitter:card"]')?.getAttribute('content');
    expect(card).toBe('summary_large_image');
  });

  it('embeds valid SoftwareApplication JSON-LD', () => {
    const ld = doc.querySelector('script[type="application/ld+json"]')?.textContent ?? '';
    expect(ld.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(ld);
    expect(parsed['@context']).toBe('https://schema.org');
    expect(parsed['@type']).toBe('SoftwareApplication');
    expect(parsed.name).toBe('Fallout Chat Mod');
    expect(parsed.url).toBe(ORIGIN);
  });
});
