/**
 * AST-based dependency analyzer — uses tree-sitter for precise import/call extraction.
 * Falls back gracefully if tree-sitter is not available.
 */

import type { DependencyAnalysis } from './dependency-analyzer.js';

/**
 * Analyze dependencies using tree-sitter AST.
 * Returns the same DependencyAnalysis interface as the regex version.
 * Returns null if tree-sitter is not available (caller should fall back to regex).
 */
export async function analyzeAstDependencies(
  content: string,
  language: string,
): Promise<DependencyAnalysis | null> {
  let TreeSitter: any;
  try {
    // @ts-expect-error — tree-sitter is an optional native dependency
    const mod = await import('tree-sitter');
    TreeSitter = mod.default || mod;
  } catch {
    return null; // tree-sitter not available
  }

  const languageGrammar = await loadLanguage(language);
  if (!languageGrammar) return null;

  try {
    const parser = new TreeSitter();
    parser.setLanguage(languageGrammar);
    const tree = parser.parse(content);

    const result: DependencyAnalysis = {
      httpCalls: [],
      mqProduce: [],
      mqConsume: [],
      grpcServices: [],
      imports: [],
    };

    result.imports = extractAstImports(tree.rootNode, language);

    // HTTP/MQ/gRPC patterns are still better detected with regex
    // since they depend on string literals and annotations rather than AST structure.
    // AST gives us precise imports; we combine with regex for the rest.

    return result;
  } catch {
    return null;
  }
}

const LANGUAGE_PACKAGES: Record<string, string> = {
  java: 'tree-sitter-java',
  go: 'tree-sitter-go',
  python: 'tree-sitter-python',
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-typescript',
};

const loadedLangs: Record<string, any> = {};

async function loadLanguage(lang: string): Promise<any | null> {
  if (loadedLangs[lang]) return loadedLangs[lang];
  const pkgName = LANGUAGE_PACKAGES[lang];
  if (!pkgName) return null;

  try {
    const mod = await import(pkgName);
    let grammar = mod.default || mod;
    if ((lang === 'typescript' || lang === 'javascript') && grammar.typescript) {
      grammar = grammar.typescript;
    }
    loadedLangs[lang] = grammar;
    return grammar;
  } catch {
    return null;
  }
}

/**
 * Extract imports using AST — more precise than regex.
 */
function extractAstImports(rootNode: any, language: string): string[] {
  const imports: string[] = [];

  function walk(node: any) {
    switch (language) {
      case 'java':
      case 'kotlin':
        if (node.type === 'import_declaration') {
          // Get the full import path
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child.type === 'scoped_identifier' || child.type === 'identifier') {
              imports.push(child.text);
              break;
            }
          }
        }
        break;

      case 'go':
        if (node.type === 'import_spec') {
          const pathNode = findChild(node, 'interpreted_string_literal') || findChild(node, 'raw_string_literal');
          if (pathNode) {
            imports.push(pathNode.text.replace(/["`]/g, ''));
          }
        }
        break;

      case 'python':
        if (node.type === 'import_statement' || node.type === 'import_from_statement') {
          const moduleName = node.childForFieldName('module_name') || findChild(node, 'dotted_name');
          if (moduleName) {
            imports.push(moduleName.text);
          }
        }
        break;

      case 'typescript':
      case 'javascript':
        if (node.type === 'import_statement') {
          const source = node.childForFieldName('source') || findChild(node, 'string');
          if (source) {
            imports.push(source.text.replace(/['"]/g, ''));
          }
        }
        break;
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(rootNode);
  return imports;
}

function findChild(node: any, type: string): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === type) return child;
  }
  return null;
}
