/**
 * TypeScript-only shim for the optional npm package `chromadb`.
 *
 * - Does NOT select your vector backend. That is `storage.vector.provider` in config,
 *   implemented in store-factory.ts (`sqlite` default, `chromadb` only loads ChromaDbStore).
 * - ChromaDbStore uses dynamic `import('chromadb')`; when the package is not installed,
 *   tsc still needs a module name it can resolve — this declaration satisfies that.
 */
declare module 'chromadb';
