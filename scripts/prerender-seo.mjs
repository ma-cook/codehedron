// Build-time prerender for search-engine and LLM-crawler visibility.
//
// AI crawlers (GPTBot, ClaudeBot, PerplexityBot, ...) do not execute
// JavaScript, and codehedron.dev is a client-rendered SPA — without this step
// they see an empty <div id="root"></div>. The script injects crawlable HTML
// (distilled from src/seo/siteContent.js) into the built index.html and emits
// a standalone crawlable /docs page. React's createRoot() replaces the
// injected content on mount, so users still get the app.
//
// Wired into "npm run build" (see package.json).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_SEO } from '../src/seo/siteContent.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(rootDir, 'dist');

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const PAGE_STYLE =
  'max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.55; color: #1c1c1c;';

function renderHero() {
  return [
    `<h1>${escapeHtml(SITE_SEO.hero.heading)}</h1>`,
    `<p><strong>${escapeHtml(SITE_SEO.name)}</strong> (${escapeHtml(SITE_SEO.url)}) — ${escapeHtml(SITE_SEO.hero.subheading)}</p>`,
  ].join('\n      ');
}

function renderFeatures() {
  const items = SITE_SEO.features
    .map((f) => `        <li><strong>${escapeHtml(f.title)}.</strong> ${escapeHtml(f.text)}</li>`)
    .join('\n');
  return `      <h2>What CodeHedron does</h2>\n      <ul>\n${items}\n      </ul>`;
}

function renderDifferentiators() {
  const items = SITE_SEO.differentiators.map((d) => `        <li>${escapeHtml(d)}</li>`).join('\n');
  return `      <h2>How CodeHedron differs from 2D diagram tools</h2>\n      <ul>\n${items}\n      </ul>`;
}

function renderFaqBody() {
  const sections = SITE_SEO.faq
    .map((f) => `      <section>\n        <h3>${escapeHtml(f.q)}</h3>\n        <p>${escapeHtml(f.a)}</p>\n      </section>`)
    .join('\n');
  return `      <h2>Frequently asked questions</h2>\n${sections}`;
}

function renderFaqJsonLd() {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: SITE_SEO.faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
}

function renderStaticContent() {
  return [
    '      <div id="seo-prerendered" style="' + PAGE_STYLE + '">',
    '      ' + renderHero(),
    renderFeatures(),
    renderDifferentiators(),
    renderFaqBody(),
    `      <p>Learn more at <a href="${escapeHtml(SITE_SEO.url)}">${escapeHtml(SITE_SEO.url)}</a> or on GitHub at <a href="${escapeHtml(SITE_SEO.githubUrl)}">${escapeHtml(SITE_SEO.githubUrl)}</a>.</p>`,
    '      </div>',
    '      ' + renderFaqJsonLd(),
  ].join('\n');
}

function injectIntoIndex() {
  const indexPath = join(distDir, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const marker = '<div id="root"></div>';
  if (!html.includes(marker)) {
    throw new Error('prerender-seo: <div id="root"></div> not found in dist/index.html');
  }
  const updated = html.replace(
    marker,
    `<div id="root">\n${renderStaticContent()}\n    </div>`
  );
  writeFileSync(indexPath, updated);
  console.log('[prerender-seo] injected crawlable content into dist/index.html');
}

function renderDocsPage() {
  const sections = SITE_SEO.faq
    .map(
      (f, i) =>
        `    <section>\n      <h2>${i + 1}. ${escapeHtml(f.q)}</h2>\n      <p>${escapeHtml(f.a)}</p>\n    </section>`
    )
    .join('\n');
  const features = SITE_SEO.features
    .map((f) => `      <li><strong>${escapeHtml(f.title)}.</strong> ${escapeHtml(f.text)}</li>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(SITE_SEO.name)} FAQ — 3D diagrams with true X/Y/Z positioning</title>
    <meta name="description" content="${escapeHtml(SITE_SEO.description)}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${escapeHtml(SITE_SEO.url)}/docs" />
    <style>
      body { margin: 0; background: #fafafa; }
      main { ${PAGE_STYLE} }
      h1 { margin-bottom: 4px; }
      .back { margin-bottom: 24px; display: inline-block; }
    </style>
  </head>
  <body>
    <main>
      <a class="back" href="/">← Back to CodeHedron</a>
      <h1>${escapeHtml(SITE_SEO.name)} — Frequently asked questions</h1>
      <p>${escapeHtml(SITE_SEO.hero.subheading)}</p>
      <h2>What CodeHedron does</h2>
      <ul>
${features}
      </ul>
${sections}
    </main>
  </body>
</html>
`;
}

function emitDocsPage() {
  const docsDir = join(distDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, 'index.html'), renderDocsPage());
  console.log('[prerender-seo] wrote dist/docs/index.html');
}

// Some chunks (e.g. the entry, wrapped by the top-level-await plugin) ship a
// .map file without the sourceMappingURL comment, so DevTools cannot resolve
// their freeze stacks. Link every chunk that has a sibling map.
function linkSourcemaps() {
  const assetsDir = join(distDir, 'assets');
  let linked = 0;
  for (const file of readdirSync(assetsDir)) {
    if (!file.endsWith('.js')) continue;
    const mapName = `${file}.map`;
    if (!existsSync(join(assetsDir, mapName))) continue;
    const jsPath = join(assetsDir, file);
    const content = readFileSync(jsPath, 'utf8');
    if (content.includes('sourceMappingURL=')) continue;
    writeFileSync(jsPath, `${content}\n//# sourceMappingURL=${mapName}`);
    linked++;
  }
  console.log(`[prerender-seo] linked ${linked} sourcemap file(s)`);
}

injectIntoIndex();
emitDocsPage();
linkSourcemaps();
