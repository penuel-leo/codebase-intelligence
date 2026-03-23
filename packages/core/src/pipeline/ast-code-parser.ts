/**
 * AST-based code parser using tree-sitter.
 * Provides precise function/class/method extraction with call/inheritance analysis.
 * Falls back gracefully if tree-sitter native modules are not installed.
 */

import { createHash } from 'node:crypto';
import type { Chunk, CodeChunkKind, ProviderType } from '../types/index.js';

export interface AstParseContext {
  project: string;
  provider: ProviderType;
  branch: string;
  filePath: string;
  language: string;
  commitSha?: string;
}

interface AstNode {
  kind: CodeChunkKind;
  symbolName: string;
  className?: string;
  packageName?: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  calls: string[];
  extendsClass?: string;
  implementsInterfaces?: string[];
}

// Lazy-loaded tree-sitter modules
let TreeSitter: any = null;
let loadedLanguages: Record<string, any> = {};
let loadAttempted = false;
let loadFailed = false;

/**
 * Supported languages and their tree-sitter grammar package names
 */
const LANGUAGE_PACKAGES: Record<string, string> = {
  java: 'tree-sitter-java',
  go: 'tree-sitter-go',
  python: 'tree-sitter-python',
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-typescript', // Use TS parser for JS too (superset)
};

/**
 * Try to load tree-sitter and language grammars dynamically.
 * Returns false if native modules are not available.
 */
async function ensureTreeSitter(): Promise<boolean> {
  if (loadFailed) return false;
  if (TreeSitter) return true;
  if (loadAttempted) return false;

  loadAttempted = true;
  try {
    // @ts-expect-error — tree-sitter is an optional native dependency
    const mod = await import('tree-sitter');
    TreeSitter = mod.default || mod;
    return true;
  } catch {
    loadFailed = true;
    return false;
  }
}

async function getLanguage(lang: string): Promise<any | null> {
  if (loadedLanguages[lang]) return loadedLanguages[lang];

  const pkgName = LANGUAGE_PACKAGES[lang];
  if (!pkgName) return null;

  try {
    const mod = await import(pkgName);
    let grammar = mod.default || mod;

    // tree-sitter-typescript exports { typescript, tsx }
    if (lang === 'typescript' && grammar.typescript) {
      grammar = grammar.typescript;
    } else if (lang === 'javascript' && grammar.typescript) {
      grammar = grammar.typescript;
    }

    loadedLanguages[lang] = grammar;
    return grammar;
  } catch {
    return null;
  }
}

/**
 * Check if tree-sitter is available for a given language.
 */
export async function isAstAvailable(language: string): Promise<boolean> {
  if (!(language in LANGUAGE_PACKAGES)) return false;
  if (!(await ensureTreeSitter())) return false;
  return (await getLanguage(language)) !== null;
}

/**
 * Parse code using tree-sitter AST.
 * Returns empty array if tree-sitter is not available or parsing fails.
 */
export async function parseCodeAst(content: string, ctx: AstParseContext): Promise<Chunk[]> {
  if (!(await ensureTreeSitter())) return [];

  const language = await getLanguage(ctx.language);
  if (!language) return [];

  try {
    const parser = new TreeSitter();
    parser.setLanguage(language);
    const tree = parser.parse(content);
    const rootNode = tree.rootNode;

    const nodes = extractNodes(rootNode, ctx.language, content);
    if (nodes.length === 0) return [];

    return nodes.map(node => makeAstChunk(node, ctx));
  } catch {
    return [];
  }
}

/**
 * Extract meaningful AST nodes based on language.
 */
function extractNodes(rootNode: any, language: string, content: string): AstNode[] {
  switch (language) {
    case 'java':
    case 'kotlin':
      return extractJavaNodes(rootNode, content);
    case 'go':
      return extractGoNodes(rootNode, content);
    case 'python':
      return extractPythonNodes(rootNode, content);
    case 'typescript':
    case 'javascript':
      return extractTsNodes(rootNode, content);
    default:
      return [];
  }
}

// ─── Java/Kotlin extraction ────────────────────────────────────

function extractJavaNodes(rootNode: any, content: string): AstNode[] {
  const nodes: AstNode[] = [];
  let currentPackage = '';
  let currentClass = '';

  function walk(node: any) {
    switch (node.type) {
      case 'package_declaration': {
        const nameNode = node.childForFieldName('name') || findChild(node, 'scoped_identifier') || findChild(node, 'identifier');
        if (nameNode) currentPackage = nameNode.text;
        break;
      }
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration': {
        const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
        if (nameNode) {
          currentClass = nameNode.text;
          const kind: CodeChunkKind = node.type === 'interface_declaration' ? 'interface'
            : node.type === 'enum_declaration' ? 'enum' : 'class';

          const ext = extractJavaSuperclass(node);
          const impl = extractJavaInterfaces(node);
          const calls = extractCalls(node);

          nodes.push({
            kind,
            symbolName: currentClass,
            packageName: currentPackage || undefined,
            content: node.text,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            calls,
            extendsClass: ext,
            implementsInterfaces: impl.length > 0 ? impl : undefined,
          });
        }
        break;
      }
      case 'method_declaration':
      case 'constructor_declaration': {
        const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
        if (nameNode) {
          const calls = extractCalls(node);
          nodes.push({
            kind: 'method',
            symbolName: nameNode.text,
            className: currentClass || undefined,
            packageName: currentPackage || undefined,
            content: node.text,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            calls,
          });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(rootNode);
  return nodes;
}

function extractJavaSuperclass(node: any): string | undefined {
  const superclass = node.childForFieldName('superclass');
  if (superclass) return superclass.text;
  // Check for extends clause
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'superclass') return child.text?.replace(/^extends\s+/, '');
  }
  return undefined;
}

function extractJavaInterfaces(node: any): string[] {
  const result: string[] = [];
  const interfaces = node.childForFieldName('interfaces');
  if (interfaces) {
    for (let i = 0; i < interfaces.childCount; i++) {
      const child = interfaces.child(i);
      if (child.type === 'type_identifier' || child.type === 'generic_type') {
        result.push(child.text);
      }
    }
  }
  return result;
}

// ─── Go extraction ─────────────────────────────────────────────

function extractGoNodes(rootNode: any, content: string): AstNode[] {
  const nodes: AstNode[] = [];

  function walk(node: any) {
    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
        if (nameNode) {
          nodes.push({
            kind: 'function',
            symbolName: nameNode.text,
            content: node.text,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            calls: extractCalls(node),
          });
        }
        break;
      }
      case 'method_declaration': {
        const nameNode = node.childForFieldName('name') || findChild(node, 'field_identifier');
        if (nameNode) {
          nodes.push({
            kind: 'method',
            symbolName: nameNode.text,
            content: node.text,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            calls: extractCalls(node),
          });
        }
        break;
      }
      case 'type_declaration': {
        const spec = findChild(node, 'type_spec');
        if (spec) {
          const nameNode = spec.childForFieldName('name') || findChild(spec, 'type_identifier');
          const typeNode = spec.childForFieldName('type');
          if (nameNode) {
            const kind: CodeChunkKind = typeNode?.type === 'interface_type' ? 'interface' : 'struct';
            nodes.push({
              kind,
              symbolName: nameNode.text,
              content: node.text,
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              calls: [],
            });
          }
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(rootNode);
  return nodes;
}

// ─── Python extraction ─────────────────────────────────────────

function extractPythonNodes(rootNode: any, content: string): AstNode[] {
  const nodes: AstNode[] = [];
  let currentClass = '';

  function walk(node: any, depth = 0) {
    switch (node.type) {
      case 'class_definition': {
        const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
        if (nameNode) {
          currentClass = nameNode.text;
          const ext = extractPythonSuperclass(node);
          nodes.push({
            kind: 'class',
            symbolName: currentClass,
            content: node.text,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            calls: extractCalls(node),
            extendsClass: ext,
          });
        }
        break;
      }
      case 'function_definition': {
        const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
        if (nameNode) {
          const isMethod = depth > 0 && currentClass;
          nodes.push({
            kind: isMethod ? 'method' : 'function',
            symbolName: nameNode.text,
            className: isMethod ? currentClass : undefined,
            content: node.text,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            calls: extractCalls(node),
          });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), depth + 1);
    }
  }

  walk(rootNode);
  return nodes;
}

function extractPythonSuperclass(node: any): string | undefined {
  const args = node.childForFieldName('superclasses') || findChild(node, 'argument_list');
  if (args && args.childCount > 0) {
    for (let i = 0; i < args.childCount; i++) {
      const child = args.child(i);
      if (child.type === 'identifier' || child.type === 'attribute') {
        return child.text;
      }
    }
  }
  return undefined;
}

// ─── TypeScript/JavaScript extraction ──────────────────────────

function extractTsNodes(rootNode: any, content: string): AstNode[] {
  const nodes: AstNode[] = [];
  let currentClass = '';

  function walk(node: any, depth = 0) {
    switch (node.type) {
      case 'class_declaration': {
        const nameNode = node.childForFieldName('name') || findChild(node, 'type_identifier');
        if (nameNode) {
          currentClass = nameNode.text;
          const ext = extractTsSuperclass(node);
          const impl = extractTsImplements(node);
          nodes.push({
            kind: 'class',
            symbolName: currentClass,
            content: node.text,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            calls: extractCalls(node),
            extendsClass: ext,
            implementsInterfaces: impl.length > 0 ? impl : undefined,
          });
        }
        break;
      }
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
        if (nameNode) {
          nodes.push({
            kind: 'function',
            symbolName: nameNode.text,
            content: node.text,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            calls: extractCalls(node),
          });
        }
        break;
      }
      case 'method_definition': {
        const nameNode = node.childForFieldName('name') || findChild(node, 'property_identifier');
        if (nameNode) {
          nodes.push({
            kind: 'method',
            symbolName: nameNode.text,
            className: currentClass || undefined,
            content: node.text,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            calls: extractCalls(node),
          });
        }
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        // Handle const foo = () => {} or const foo = function() {}
        if (depth === 0) {
          const declarator = findChild(node, 'variable_declarator');
          if (declarator) {
            const nameNode = declarator.childForFieldName('name') || findChild(declarator, 'identifier');
            const valueNode = declarator.childForFieldName('value');
            if (nameNode && valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function')) {
              nodes.push({
                kind: 'function',
                symbolName: nameNode.text,
                content: node.text,
                lineStart: node.startPosition.row + 1,
                lineEnd: node.endPosition.row + 1,
                calls: extractCalls(valueNode),
              });
            }
          }
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), depth + 1);
    }
  }

  walk(rootNode);
  return nodes;
}

function extractTsSuperclass(node: any): string | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'class_heritage') {
      const extendsClause = findChild(child, 'extends_clause');
      if (extendsClause) {
        const typeNode = findChild(extendsClause, 'identifier') || findChild(extendsClause, 'member_expression');
        if (typeNode) return typeNode.text;
      }
    }
  }
  return undefined;
}

function extractTsImplements(node: any): string[] {
  const result: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'class_heritage') {
      const implClause = findChild(child, 'implements_clause');
      if (implClause) {
        for (let j = 0; j < implClause.childCount; j++) {
          const typeNode = implClause.child(j);
          if (typeNode.type === 'type_identifier' || typeNode.type === 'generic_type') {
            result.push(typeNode.text);
          }
        }
      }
    }
  }
  return result;
}

// ─── Shared helpers ────────────────────────────────────────────

/**
 * Extract all function/method call names from a node.
 */
function extractCalls(node: any): string[] {
  const calls = new Set<string>();

  function walk(n: any) {
    if (n.type === 'call_expression' || n.type === 'method_invocation') {
      const funcNode = n.childForFieldName('function') || n.childForFieldName('name');
      if (funcNode) {
        // For member access like obj.method(), get just the method name
        if (funcNode.type === 'member_expression' || funcNode.type === 'field_access') {
          const propNode = funcNode.childForFieldName('property') || funcNode.childForFieldName('field');
          if (propNode) calls.add(propNode.text);
        } else if (funcNode.type === 'identifier' || funcNode.type === 'field_identifier') {
          calls.add(funcNode.text);
        }
      }
    }
    // Python call expressions
    if (n.type === 'call') {
      const funcNode = n.childForFieldName('function');
      if (funcNode) {
        if (funcNode.type === 'attribute') {
          const attrNode = funcNode.childForFieldName('attribute');
          if (attrNode) calls.add(attrNode.text);
        } else if (funcNode.type === 'identifier') {
          calls.add(funcNode.text);
        }
      }
    }

    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i));
    }
  }

  walk(node);
  return [...calls];
}

function findChild(node: any, type: string): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === type) return child;
  }
  return null;
}

function makeAstChunk(node: AstNode, ctx: AstParseContext): Chunk {
  const hash = createHash('sha256').update(node.content).digest('hex').slice(0, 16);
  const id = `${ctx.project}__${node.className || ''}__${node.symbolName}__${hash}`;

  return {
    content: node.content,
    metadata: {
      id,
      source: ctx.provider,
      project: ctx.project,
      branch: ctx.branch,
      type: 'code',
      chunkKind: node.kind,
      language: ctx.language,
      filePath: ctx.filePath,
      lineStart: node.lineStart,
      lineEnd: node.lineEnd,
      symbolName: node.symbolName,
      className: node.className,
      packageName: node.packageName,
      calls: node.calls.length > 0 ? node.calls : undefined,
      extendsClass: node.extendsClass,
      implementsInterfaces: node.implementsInterfaces,
      contentHash: hash,
      commitSha: ctx.commitSha,
      indexedAt: new Date().toISOString(),
    },
  };
}
