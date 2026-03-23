/**
 * Code parser facade — routes to regex or tree-sitter AST parser based on config.
 *
 * Modes:
 *   - 'regex' (default): Zero native dependencies, regex-based heuristic parsing.
 *   - 'tree-sitter': Precise AST parsing with fallback to regex for unsupported languages.
 */

import type { Chunk } from '../types/index.js';
import { parseCode as parseCodeRegex, type ParseContext } from './regex-code-parser.js';
import { parseCodeAst, isAstAvailable } from './ast-code-parser.js';

export type ParserMode = 'regex' | 'tree-sitter';

export interface CodeParseContext extends ParseContext {
  parserMode?: ParserMode;
}

// Re-export ParseContext for backward compatibility
export type { ParseContext } from './regex-code-parser.js';

/**
 * Parse source code into chunks.
 * In tree-sitter mode, tries AST parsing first; falls back to regex on failure or unsupported language.
 */
export async function parseCode(content: string, ctx: CodeParseContext): Promise<Chunk[]>;
export function parseCode(content: string, ctx: ParseContext): Chunk[];
export function parseCode(content: string, ctx: CodeParseContext): Chunk[] | Promise<Chunk[]> {
  const mode = ctx.parserMode ?? 'regex';

  if (mode === 'tree-sitter') {
    // Return a promise — caller must await
    return parseWithAstFallback(content, ctx);
  }

  return parseCodeRegex(content, ctx);
}

async function parseWithAstFallback(content: string, ctx: CodeParseContext): Promise<Chunk[]> {
  try {
    const available = await isAstAvailable(ctx.language);
    if (available) {
      const chunks = await parseCodeAst(content, ctx);
      if (chunks.length > 0) return chunks;
    }
  } catch {
    // Fall through to regex
  }

  // Fallback to regex parser
  return parseCodeRegex(content, ctx);
}
