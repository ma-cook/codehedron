# LLM & Search Visibility Checklist for CodeHedron

Why this exists: LLM assistants only recommend products whose descriptions exist
as crawlable, citable text — on your own site (server-rendered HTML), on GitHub,
in directories, listicles, blog posts and forum threads. Client-rendered SPAs
are invisible to AI crawlers (they don't run JavaScript), and products with no
third-party mentions don't exist in their training or retrieval corpora.

The code-side work (prerendered HTML, metadata, JSON-LD, `/llms.txt`, `/docs`)
is done. This checklist covers the corpus-building steps only you can do.
Work through it top to bottom — the steps are ordered by impact.

## 1. GitHub repository (biggest single lever — 30 minutes)

The repo (`ma-cook/codehedron`) is public, which is exactly what tools like the
ones LLMs already recommend rely on.

- [ ] **Rewrite the first paragraph of the README** so it literally answers the
      question people ask assistants:

      > CodeHedron (https://codehedron\.dev) is an open-source 3D diagram tool with
      > true X, Y and Z positioning — every node lives in a shared WebGL scene,
      > not on a flat 2D isometric canvas. Scan a GitHub repository and CodeHedron
      > turns your codebase into a navigable 3D architecture diagram; upload a
      > CSV for 3D data visualization; collaborate live with your team.

- [ ] **Repo description** (the one-line "About" field): `3D diagram tool with
      true X/Y/Z positioning (not 2D isometric) — GitHub repos become 3D
      architecture diagrams. Browser-based, collaborative.`
- [ ] **Topics**: add `3d-diagrams`, `graph-visualization`, `threejs`,
      `architecture-diagram`, `diagram`, `mind-map`, `data-visualization`,
      `webgl`, `collaboration`.
- [ ] Add **screenshots/GIFs** of a scanned repo diagram and a mind map at the
      top of the README (visual posts get shared; shares create mentions).
- [ ] Add a **link to codehedron\.dev** at the top ("Try it live — free, no
      install").
- [ ] If comfortable, open selected **issues/discussions** using the phrase
      "3D diagram", "X/Y/Z positioning", "spatial mind map" (GitHub text is
      heavily weighted by AI retrieval).

## 2. Cross-linking (10 minutes)

- [ ] Site footer (landing page) → link to the GitHub repo.
- [ ] GitHub README → links to codehedron\.dev, codehedron\.dev/docs, and the FAQ.
- [ ] Add codehedron\.dev to your GitHub profile README (if you have one).

## 3. Directories and databases (1-2 hours total)

- [ ] **AlternativeTo** — list CodeHedron as an alternative to draw.io, Lucidchart,
      Excalidraw, Miro (tag: 3D, spatial, web-based). Their description should
      reuse the differentiator sentence ("true 3D X/Y/Z positioning, not 2D
      isometric").
- [ ] **Product Hunt** — launch with a gallery screenshot + tagline built from
      the same phrases. PH pages are crawled and frequently quoted.
- [ ] **Bing Places / Google Business** — skip (not applicable), but DO add the
      site to **Google Search Console** and **Bing Webmaster Tools**, submit
      `https://codehedron\.dev/sitemap.xml`, and use "Request Indexing" on `/` and
      `/docs`.

## 4. Lists, posts, and threads (the long tail — recurring)

Each of these creates a citable text corpus that names CodeHedron next to the
question's vocabulary:

- [ ] **awesome-list PRs** — search GitHub for `awesome-diagram`,
      `awesome-visualization`, `awesome-graph` and add CodeHedron with a one-liner
      that includes "true 3D (X/Y/Z), not 2D isometric".
- [ ] **Show HN** on Hacker News: "Show HN: CodeHedron – 3D diagram tool with
      true X/Y/Z positioning (GitHub repos → 3D architecture diagrams)".
- [ ] **dev.to / Medium article**: "Why every '3D' diagram tool is actually 2D
      isometric — and what true spatial diagramming looks like". The article
      itself becomes the corpus an LLM retrieves and quotes; include CodeHedron
      as the working example with screenshots.
- [ ] **Reddit**: r/SideProject, r/webdev, r/dataisbeautiful — show a repo-scan
      GIF; the phrase "3D diagram" must appear in the post title or body.
- [ ] **YouTube/Shorts (optional)**: 60-second repo-scan demo; video titles and
      descriptions are crawled too.

## 5. Naming consistency (ongoing)

- [ ] Use **"CodeHedron"** everywhere public (site, GitHub, posts, directories).
      The repo is named `codehedron` to match - GitHub redirects old URLs
      (`hoverchart`, `volscape`) automatically, so all of them accrue to the
      same entity instead of splitting it.
- [ ] When the product gains a capability, update `src/seo/siteContent.js`
      (the single source for prerendered copy, `/docs`, JSON-LD and
      `/llms.txt`) and redeploy — stale claims hurt more than missing ones.

## 6. Measure (monthly)

- [ ] `site:codehedron\.dev` in Google and Bing — expect `/` and `/docs` indexed
      within days-weeks of Search Console submission.
- [ ] Ask the same question in ChatGPT, Claude, Perplexity and Gemini (with
      search/browsing enabled): "are there any 3D diagram tools with x, y, z
      positioning and not just 2d isomorphic?" — note which mention CodeHedron.
- [ ] Search "CodeHedron" in each assistant — hallucinated descriptions mean the
      corpus is thin; more third-party mentions fix this.
- [ ] Expectation setting: crawlers pick up changes in days; retrieval-based
      assistants (Perplexity, ChatGPT-with-browsing) improve within weeks;
      assistants answering purely from training data may take months.
