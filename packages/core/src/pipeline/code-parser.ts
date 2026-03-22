/**
 * Code parser — splits source code into semantic chunks.
 *
 * Strategy: regex-based heuristic parsing for common languages.
 * This is the fallback when tree-sitter is not available.
 * tree-sitter integration can be added as an enhancement.
 */

import { createHash } from 'node:crypto';
import type { Chunk, ChunkMetadata, ChunkType, CodeChunkKind, ProviderType } from '../types/index.js';

export interface ParseContext {
  project: string;
  provider: ProviderType;
  branch: string;
  filePath: string;
  language: string;
  commitSha?: string;
}

export function parseCode(content: string, ctx: ParseContext): Chunk[] {
  const lines = content.split('\n');

  // For small files, treat as a single chunk
  if (lines.length <= 50) {
    return [makeChunk(content, ctx, 'module', ctx.filePath, 1, lines.length)];
  }

  // Try language-specific parsing
  switch (ctx.language) {
    case 'java':
    case 'kotlin':
    case 'csharp':
      return parseJavaLike(content, lines, ctx);
    case 'go':
      return parseGo(content, lines, ctx);
    case 'python':
      return parsePython(content, lines, ctx);
    case 'javascript':
    case 'typescript':
    case 'vue':
    case 'svelte':
      return parseJsTs(content, lines, ctx);
    default:
      return parseFallback(content, lines, ctx);
  }
}

// ─── Java/Kotlin/C# parser ────────────────────────────────────

function parseJavaLike(content: string, lines: string[], ctx: ParseContext): Chunk[] {
  const chunks: Chunk[] = [];
  const classRegex = /^\s*(public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*(class|interface|enum|record)\s+(\w+)/;
  const methodRegex = /^\s*(public|private|protected|static|\s)*([\w<>\[\]]+)\s+(\w+)\s*\(/;
  const packageRegex = /^\s*package\s+([\w.]+)/;
  const importRegex = /^\s*import\s+/;

  let currentPackage = '';
  let currentClass = '';
  let classLine = '';
  let blockStart = 0;
  let braceCount = 0;
  let inMethod = false;
  let methodName = '';
  let methodStart = 0;

  // Collect file-level context: package + imports + class declaration
  const fileHeader: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const line = lines[i];
    if (line.match(packageRegex) || line.match(importRegex)) {
      fileHeader.push(line);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const pkgMatch = line.match(packageRegex);
    if (pkgMatch) currentPackage = pkgMatch[1];

    const classMatch = line.match(classRegex);
    if (classMatch) {
      currentClass = classMatch[3];
      classLine = line.trim();
    }

    const methodMatch = line.match(methodRegex);
    if (methodMatch && !inMethod && line.includes('(')) {
      inMethod = true;
      methodName = methodMatch[3];
      methodStart = i;
      braceCount = 0;
    }

    if (inMethod) {
      for (const ch of line) {
        if (ch === '{') braceCount++;
        if (ch === '}') braceCount--;
      }

      if (braceCount <= 0 && line.includes('}')) {
        const methodBody = lines.slice(methodStart, i + 1).join('\n');

        // Prepend class-level context so each chunk is self-contained
        const contextHeader = buildClassContext(
          ctx.filePath, currentPackage, currentClass, classLine, fileHeader,
        );
        const enrichedContent = contextHeader + methodBody;

        chunks.push(makeChunk(
          enrichedContent, ctx, 'method',
          methodName, methodStart + 1, i + 1,
          currentClass, currentPackage,
        ));
        inMethod = false;
      }
    }
  }

  // If no methods found, chunk the whole file as a class
  if (chunks.length === 0) {
    chunks.push(makeChunk(content, ctx, currentClass ? 'class' : 'module',
      currentClass || ctx.filePath, 1, lines.length, currentClass, currentPackage));
  }

  return chunks;
}

// ─── Go parser ────────────────────────────────────────────────

function parseGo(content: string, lines: string[], ctx: ParseContext): Chunk[] {
  const chunks: Chunk[] = [];
  const funcRegex = /^func\s+(\([\w\s*]+\)\s+)?(\w+)\s*\(/;
  const typeRegex = /^type\s+(\w+)\s+(struct|interface)\s*\{/;

  let blockStart = -1;
  let braceCount = 0;
  let symbolName = '';
  let chunkKind: CodeChunkKind = 'function';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (blockStart === -1) {
      const funcMatch = line.match(funcRegex);
      const typeMatch = line.match(typeRegex);

      if (funcMatch) {
        blockStart = i;
        symbolName = funcMatch[2];
        chunkKind = 'function';
        braceCount = 0;
      } else if (typeMatch) {
        blockStart = i;
        symbolName = typeMatch[1];
        chunkKind = 'struct';
        braceCount = 0;
      }
    }

    if (blockStart !== -1) {
      for (const ch of line) {
        if (ch === '{') braceCount++;
        if (ch === '}') braceCount--;
      }

      if (braceCount <= 0 && line.includes('}')) {
        const blockContent = lines.slice(blockStart, i + 1).join('\n');
        chunks.push(makeChunk(blockContent, ctx, chunkKind, symbolName, blockStart + 1, i + 1));
        blockStart = -1;
      }
    }
  }

  if (chunks.length === 0) {
    chunks.push(makeChunk(content, ctx, 'module', ctx.filePath, 1, lines.length));
  }

  return chunks;
}

// ─── Python parser ────────────────────────────────────────────

function parsePython(content: string, lines: string[], ctx: ParseContext): Chunk[] {
  const chunks: Chunk[] = [];
  const defRegex = /^(\s*)(def|async\s+def)\s+(\w+)\s*\(/;
  const classRegex = /^(\s*)class\s+(\w+)/;

  let currentIndent = 0;
  let blockStart = -1;
  let symbolName = '';
  let chunkKind: CodeChunkKind = 'function';
  let className = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const classMatch = line.match(classRegex);
    if (classMatch && classMatch[1].length === 0) {
      className = classMatch[2];
    }

    const defMatch = line.match(defRegex);
    if (defMatch) {
      // End previous block
      if (blockStart !== -1) {
        const blockContent = lines.slice(blockStart, i).join('\n');
        chunks.push(makeChunk(blockContent, ctx, chunkKind, symbolName, blockStart + 1, i, className));
      }

      blockStart = i;
      currentIndent = defMatch[1].length;
      symbolName = defMatch[3];
      chunkKind = 'function';
    }
  }

  // Last block
  if (blockStart !== -1) {
    const blockContent = lines.slice(blockStart).join('\n');
    chunks.push(makeChunk(blockContent, ctx, chunkKind, symbolName, blockStart + 1, lines.length, className));
  }

  if (chunks.length === 0) {
    chunks.push(makeChunk(content, ctx, 'module', ctx.filePath, 1, lines.length));
  }

  return chunks;
}

// ─── JS/TS parser ─────────────────────────────────────────────

function parseJsTs(content: string, lines: string[], ctx: ParseContext): Chunk[] {
  const chunks: Chunk[] = [];
  const funcRegex = /^(?:export\s+)?((?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=]+)=>)/;
  const classRegex = /^(?:export\s+)?class\s+(\w+)/;

  let blockStart = -1;
  let braceCount = 0;
  let symbolName = '';
  let chunkKind: CodeChunkKind = 'function';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart();

    if (blockStart === -1) {
      const classMatch = lines[i].match(classRegex);
      const funcMatch = lines[i].match(funcRegex);

      if (classMatch) {
        blockStart = i;
        symbolName = classMatch[1];
        chunkKind = 'class';
        braceCount = 0;
      } else if (funcMatch) {
        blockStart = i;
        symbolName = funcMatch[2] || funcMatch[3] || funcMatch[4] || 'anonymous';
        chunkKind = 'function';
        braceCount = 0;
      }
    }

    if (blockStart !== -1) {
      for (const ch of lines[i]) {
        if (ch === '{') braceCount++;
        if (ch === '}') braceCount--;
      }

      if (braceCount <= 0 && (lines[i].includes('}') || lines[i].includes(';'))) {
        const blockContent = lines.slice(blockStart, i + 1).join('\n');
        if (blockContent.trim().length > 0) {
          chunks.push(makeChunk(blockContent, ctx, chunkKind, symbolName, blockStart + 1, i + 1));
        }
        blockStart = -1;
      }
    }
  }

  if (chunks.length === 0) {
    chunks.push(makeChunk(content, ctx, 'module', ctx.filePath, 1, lines.length));
  }

  return chunks;
}

// ─── Fallback parser ──────────────────────────────────────────

function parseFallback(content: string, lines: string[], ctx: ParseContext): Chunk[] {
  // Split into ~100 line chunks with overlap
  const chunkSize = 100;
  const overlap = 10;
  const chunks: Chunk[] = [];

  for (let i = 0; i < lines.length; i += chunkSize - overlap) {
    const end = Math.min(i + chunkSize, lines.length);
    const chunkContent = lines.slice(i, end).join('\n');
    chunks.push(makeChunk(chunkContent, ctx, 'module', ctx.filePath, i + 1, end));
  }

  return chunks;
}

// ─── Helper ───────────────────────────────────────────────────

function makeChunk(
  content: string,
  ctx: ParseContext,
  kind: CodeChunkKind,
  symbolName: string,
  lineStart: number,
  lineEnd: number,
  className?: string,
  packageName?: string,
): Chunk {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const id = `${ctx.project}__${className || ''}__${symbolName}__${hash}`;

  return {
    content,
    metadata: {
      id,
      source: ctx.provider,
      project: ctx.project,
      branch: ctx.branch,
      type: 'code',
      chunkKind: kind,
      language: ctx.language,
      filePath: ctx.filePath,
      lineStart,
      lineEnd,
      symbolName,
      className: className || undefined,
      packageName: packageName || undefined,
      contentHash: hash,
      commitSha: ctx.commitSha,
      indexedAt: new Date().toISOString(),
    },
  };
}

/**
 * Build a concise class-level context header for method chunks.
 * Prepended to each method so every chunk is self-contained for LLM consumption.
 *
 * Example output:
 *   // File: member-service/src/.../MemberApiDelegateImpl.java
 *   // Package: com.example.member.delegate
 *   // Class: MemberApiDelegateImpl
 *   // Imports: MemberResponse, GetMemberRequest, ...
 *   // ---
 */
function buildClassContext(
  filePath: string,
  packageName: string,
  className: string,
  classLine: string,
  fileHeader: string[],
): string {
  const parts: string[] = [];

  parts.push(`// File: ${filePath}`);
  if (packageName) parts.push(`// Package: ${packageName}`);
  if (className) parts.push(`// Class: ${className}`);
  if (classLine && classLine !== className) parts.push(`// ${classLine}`);

  // Extract meaningful imports (skip java.util, java.lang, etc.)
  const imports = fileHeader
    .filter(l => l.trim().startsWith('import'))
    .map(l => l.trim().replace(/^import\s+(static\s+)?/, '').replace(/;$/, ''))
    .filter(imp =>
      !imp.startsWith('java.util.') &&
      !imp.startsWith('java.lang.') &&
      !imp.startsWith('java.io.') &&
      !imp.startsWith('lombok.')
    );

  if (imports.length > 0) {
    const shown = imports.length <= 8 ? imports : [...imports.slice(0, 8), `... +${imports.length - 8} more`];
    parts.push(`// Imports: ${shown.join(', ')}`);
  }

  parts.push('// ---');
  return parts.join('\n') + '\n';
}
