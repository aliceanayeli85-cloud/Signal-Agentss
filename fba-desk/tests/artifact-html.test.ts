import { describe, expect, it } from 'vitest';
import { inlineArtifactHtml } from '../src/build/artifact-html';

const BUILT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>FBA Research Desk</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-def.css">
  </head>
  <body>
    <main id="app">Hello</main>
  </body>
</html>`;

const ASSETS: Record<string, string> = {
  '/assets/index-abc.js': 'console.log("hi")',
  '/assets/index-def.css': 'body{color:red}',
};

describe('inlineArtifactHtml', () => {
  it('produces a single page with inline CSS and JS and no document wrapper', () => {
    const out = inlineArtifactHtml(BUILT, (href) => ASSETS[href]);
    expect(out.startsWith('<title>FBA Research Desk</title>')).toBe(true);
    expect(out).toContain('<meta name="claude:viewport-fit-sides" content="cover">');
    expect(out).toContain('<style>\nbody{color:red}\n</style>');
    expect(out).toContain('<main id="app">Hello</main>');
    expect(out).toContain('<script type="module">\nconsole.log("hi")\n</script>');
    expect(out).not.toMatch(/<!doctype|<html|<head|<body|\/assets\//i);
  });

  it('escapes closing tags inside inlined code', () => {
    const out = inlineArtifactHtml(BUILT, (href) =>
      href.endsWith('.js') ? 'const s = "</script>";' : 'a::after{content:"</style>"}',
    );
    expect(out).toContain('const s = "<\\/script>";');
    expect(out).toContain('content:"<\\/style>"');
    expect(out.match(/<\/script>/g)).toHaveLength(1);
  });

  it('fails loudly when a referenced asset is missing', () => {
    expect(() => inlineArtifactHtml(BUILT, () => undefined)).toThrow(/asset "\/assets\/index-def.css".*not found/);
  });

  it('fails loudly without a title or script', () => {
    expect(() => inlineArtifactHtml(BUILT.replace(/<title>.*<\/title>/, ''), (h) => ASSETS[h])).toThrow(/no <title>/);
    expect(() => inlineArtifactHtml(BUILT.replace(/<script[^]*?<\/script>/, ''), (h) => ASSETS[h])).toThrow(
      /no module script/,
    );
  });
});
