/**
 * Turns Vite's built index.html into one self-contained page for a private claude.ai Artifact.
 * The Artifact host supplies <!doctype>, <html>, <head> and <body> itself and blocks external
 * files, so the output is: <title>, viewport meta, inline <style>, page body, inline <script>.
 */

export type AssetLookup = (href: string) => string | undefined;

const STYLESHEET_LINK = /<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi;
const MODULE_SCRIPT = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi;
const HREF = /\bhref=["']([^"']+)["']/i;

function lookupOrThrow(lookup: AssetLookup, ref: string): string {
  const content = lookup(ref);
  if (content === undefined) throw new Error(`Artifact build: asset "${ref}" referenced by index.html was not found`);
  return content;
}

export function inlineArtifactHtml(html: string, lookup: AssetLookup): string {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  if (!title) throw new Error('Artifact build: index.html has no <title>');

  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (!bodyMatch?.[1]) throw new Error('Artifact build: index.html has no <body>');

  const styles: string[] = [];
  for (const tag of html.match(STYLESHEET_LINK) ?? []) {
    const href = HREF.exec(tag)?.[1];
    if (!href) throw new Error(`Artifact build: stylesheet link without href: ${tag}`);
    styles.push(lookupOrThrow(lookup, href));
  }

  const scripts: string[] = [];
  for (const match of html.matchAll(MODULE_SCRIPT)) {
    scripts.push(lookupOrThrow(lookup, match[1] as string));
  }
  if (scripts.length === 0) throw new Error('Artifact build: no module script found in index.html');

  const body = bodyMatch[1].replace(MODULE_SCRIPT, '').trim();
  if (/\b(?:src|href)=["'][^"']*\/assets\//i.test(body)) {
    throw new Error('Artifact build: body still references an external /assets/ file');
  }

  // Stop inlined code from closing its own tag early.
  const css = styles.join('\n').replace(/<\/style/gi, '<\\/style');
  const js = scripts.join('\n').replace(/<\/script/gi, '<\\/script');

  return [
    `<title>${title}</title>`,
    '<meta name="claude:viewport-fit-sides" content="cover">',
    `<style>\n${css}\n</style>`,
    body,
    `<script type="module">\n${js}\n</script>`,
    '',
  ].join('\n');
}
