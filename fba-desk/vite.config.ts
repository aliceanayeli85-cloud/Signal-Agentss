import { defineConfig, type Plugin } from 'vite';
import { inlineArtifactHtml } from './src/build/artifact-html';

/** `vite build --mode artifact`: emit a single self-contained page for a private claude.ai Artifact. */
function artifactSingleFile(): Plugin {
  return {
    name: 'fba-desk-artifact-single-file',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') throw new Error('Artifact build: index.html missing from bundle');

      const used = new Set<string>();
      const lookup = (href: string) => {
        const name = href.replace(/^\.?\//, '');
        const item = bundle[name];
        if (!item) return undefined;
        used.add(name);
        return item.type === 'chunk' ? item.code : String(item.source);
      };
      html.source = inlineArtifactHtml(String(html.source), lookup);
      for (const name of used) delete bundle[name];
    },
  };
}

export default defineConfig(({ mode }) =>
  mode === 'artifact'
    ? { plugins: [artifactSingleFile()], build: { outDir: 'dist-artifact', modulePreload: false } }
    : {},
);
