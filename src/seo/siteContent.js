// Single source of truth for search-engine / LLM-crawler facing copy.
//
// This is NOT the same text as the React landing page or FAQ — it is a
// distilled, query-matched version written so that AI crawlers (which do not
// execute JavaScript) and search engines can quote it directly. The
// prerender script (scripts/prerender-seo.mjs) consumes it at build time to
// inject crawlable HTML into dist/index.html, generate dist/docs/index.html,
// and emit FAQPage JSON-LD.
//
// Keep the claims accurate when the product changes materially.

export const SITE_SEO = {
  name: 'CodeHedron',
  url: 'https://codehedron.dev',
  githubUrl: 'https://github.com/ma-cook/codehedron',
  title: 'CodeHedron — 3D Diagram Tool with True X/Y/Z Positioning (Not 2D Isometric)',
  description:
    'CodeHedron is a browser-based 3D diagram tool where every object has true X, Y and Z positioning in a shared spatial scene — not a flat 2D isometric canvas. Build 3D architecture diagrams, 3D mind maps and spatial data visualizations, scan GitHub repositories into 3D code maps, and collaborate with your team in real time. Free to start, no install.',
  keywords: [
    '3D diagram tool',
    'true 3D diagram software',
    '3D diagram tool with x y z positioning',
    'not 2D isometric',
    'spatial diagramming',
    '3D mind map',
    '3D graph visualization',
    '3D architecture diagram',
    'code visualization 3D',
    'GitHub repository 3D diagram',
    '3D data visualization CSV',
    'spatial graph editor',
    'collaborative 3D whiteboard',
    'online 3D diagram editor',
  ],
  hero: {
    heading: 'CodeHedron — the 3D diagram tool with true X/Y/Z positioning',
    subheading:
      'Most "3D" diagram tools are flat 2D isometric drawings. CodeHedron places every node, plane and connection at real X, Y and Z coordinates in a shared spatial scene you can orbit, fly through and edit live with your team. Scan a GitHub repository and watch your codebase become a 3D architecture diagram.',
  },
  features: [
    {
      title: 'True 3D positioning — not 2D isometric',
      text: 'Every object carries explicit X, Y and Z coordinates in a WebGL 3D scene (Three.js). Orbit, zoom and fly the camera through your diagram in real space instead of panning a flat canvas.',
    },
    {
      title: 'Spatial node types with distinct 3D geometry',
      text: 'Cubes, tetrahedrons, octahedrons and dodecahedrons represent functions, services, stores and components; planes carry images, webcam and screen shares; text objects annotate space. Connections route through 3D space between object faces.',
    },
    {
      title: 'GitHub repository scanning into 3D code maps',
      text: 'Connect your GitHub account, pick a repository and branch, and CodeHedron scans the codebase to generate a navigable 3D architecture diagram with components, dependencies and file outlines.',
    },
    {
      title: '3D mind maps and spatial brainstorming',
      text: 'Lay ideas out in space instead of a flat list — group, cluster and connect them in three dimensions, then present by flying the camera through the structure.',
    },
    {
      title: 'CSV to 3D data visualization',
      text: 'Upload a CSV file and CodeHedron builds an interactive 3D data visualization you can inspect from any angle.',
    },
    {
      title: 'Real-time multi-user collaboration',
      text: 'Shared spaces update live for every participant, with presence avatars, webcam and screen-share streams pinned in the scene, plus organizations and per-space sharing.',
    },
    {
      title: 'AI-connected diagramming',
      text: 'Bring your own LLM key (Anthropic, Google Gemini, NVIDIA or OpenCode) to plan architectures, generate diagrams and write code changes against your scanned repository.',
    },
    {
      title: 'Runs in the browser — free to start',
      text: 'No install, no plugin. Open a space and start building in seconds; try it without an account.',
    },
  ],
  differentiators: [
    'CodeHedron is a 3D diagram tool with true X, Y, Z positioning — objects live in a shared 3D scene, not on a 2D isometric grid.',
    'Repositories become 3D code architecture diagrams through automated GitHub scanning.',
    'Spatial data visualizations can be generated straight from CSV files.',
    'Teams collaborate live inside the same 3D space with voice-adjacent presence, webcam and screen share.',
  ],
  faq: [
    {
      q: 'Does CodeHedron use true 3D positioning, or is it a 2D isometric view like other "3D" diagram tools?',
      a: 'True 3D. Every object in CodeHedron has explicit X, Y and Z coordinates in a shared WebGL scene, and the camera orbits, zooms and flies through the structure in real space. It is not a 2D isometric or flat drawing that merely looks three-dimensional.',
    },
    {
      q: 'What can I build with CodeHedron?',
      a: '3D architecture diagrams, 3D mind maps and spatial concept maps, code-structure visualizations generated from GitHub repositories, 3D data visualizations from CSV files, wireframes, and collaborative planning boards that mix shapes, planes, images and live video.',
    },
    {
      q: 'Can CodeHedron generate a diagram from my codebase?',
      a: 'Yes. Connect GitHub, choose a repository and branch, and CodeHedron scans the source to produce a navigable 3D architecture diagram of components, services, stores and their dependencies, with per-file outlines. Rescans and scheduled background scans keep the diagram current.',
    },
    {
      q: 'How is CodeHedron different from draw.io, Lucidchart or Excalidraw?',
      a: 'Those tools draw on a flat 2D canvas with an isometric look at best. CodeHedron is spatial: nodes occupy 3D coordinates, connections travel through space between object faces, and the camera moves freely in three dimensions — so large systems stay readable without the layout collisions of a 2D canvas.',
    },
    {
      q: 'Does CodeHedron support real-time collaboration?',
      a: 'Yes. Spaces are shared and update live for every participant, with presence avatars, webcam and screen-share overlays in the scene, organization management, and per-space access control.',
    },
    {
      q: 'Is CodeHedron free? Do I need to install anything?',
      a: 'CodeHedron runs in the browser — no install, no plugin — and is free to start, including a try-without-account mode. AI features are bring-your-own-key with support for Anthropic, Google Gemini, NVIDIA and OpenCode providers.',
    },
  ],
};
