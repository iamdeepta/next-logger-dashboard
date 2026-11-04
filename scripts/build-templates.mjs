/**
 * Generate the JavaScript template variants from the TypeScript sources.
 *
 * The templates are authored once, in real TypeScript. Host projects
 * type-check scaffolded files, so JSDoc-typed JavaScript does not work
 * (its annotations are ignored in .ts files). For JavaScript projects
 * the same sources are transpiled to .js/.jsx with the TypeScript
 * compiler — types stripped, JSX preserved, comments kept — so both
 * project kinds get files that parse and run cleanly.
 *
 * Runs as part of `npm run build` (and `prepack`), before tsc compiles
 * the CLI. The generated files are shipped in templates/.
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const templatesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'templates',
);

for (const file of fs.readdirSync(templatesDir)) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const srcPath = path.join(templatesDir, file);
  const src = fs.readFileSync(srcPath, 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
    },
    fileName: file,
  });
  const jsName = file.replace(/\.tsx$/, '.jsx').replace(/\.ts$/, '.js');
  fs.writeFileSync(path.join(templatesDir, jsName), out.outputText);
  console.log(`templates: ${file} -> ${jsName}`);
}
