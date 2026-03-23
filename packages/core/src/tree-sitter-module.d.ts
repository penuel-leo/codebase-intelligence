/**
 * TypeScript-only shim for the optional npm package `tree-sitter`.
 *
 * AST paths use dynamic `import('tree-sitter')`; when optional native deps are not
 * installed or the package has no bundled types, tsc still needs a resolvable module name.
 */
declare module 'tree-sitter';
