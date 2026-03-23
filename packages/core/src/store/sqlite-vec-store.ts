/**
 * SQLite vector store with three search modes:
 *   1. FTS5 (BM25) — keyword / exact match (function names, API paths, variables)
 *   2. Vector — semantic similarity (cosine)
 *   3. Graph — dependency chain traversal
 *
 * Hybrid search = BM25 + Vector, weighted merge.
 * All based on SQLite, zero external dependencies.
 */

import Database from 'better-sqlite3';
import { buildCalledByMap, type CodeRowForCalls } from '../analysis/called-by.js';
import type { Chunk, CollectionName, SearchFilter, DependencyEdge } from '../types/index.js';
import type { VectorStore, VectorStoreQueryOptions, VectorStoreQueryResult } from './vector-store.js';

interface SqliteVecConfig {
  url?: string;
  collectionPrefix?: string;
  dimensions?: number;
}

// ─── Hybrid search types ──────────────────────────────────────

export interface HybridSearchOptions {
  collection: CollectionName;
  query: string;
  embedding?: number[];
  filter?: SearchFilter;
  topK?: number;
  minScore?: number;
  /** Weight for keyword BM25 score (0-1). Default: 0.3 */
  keywordWeight?: number;
  /** Weight for vector similarity score (0-1). Default: 0.7 */
  vectorWeight?: number;
  /** 'hybrid' | 'keyword' | 'vector'. Default: 'hybrid' */
  mode?: 'hybrid' | 'keyword' | 'vector';
}

export interface GraphQueryResult {
  edges: DependencyEdge[];
  /** All services reachable from the source */
  reachable: string[];
  depth: number;
}

export class SqliteVecStore implements VectorStore {
  private db: Database.Database;
  private prefix: string;
  private dimensions: number;

  constructor(config: SqliteVecConfig) {
    const dbPath = config.url ?? ':memory:';
    this.db = new Database(dbPath);
    this.prefix = config.collectionPrefix ?? 'ci_';
    this.dimensions = config.dimensions ?? 768;

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  async init(): Promise<void> {
    const collections: CollectionName[] = ['code', 'api', 'docs', 'config'];

    for (const col of collections) {
      const table = this.tableName(col);
      const ftsTable = `${table}_fts`;

      // ─── Main data table ───
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          project TEXT NOT NULL,
          branch TEXT DEFAULT 'main',
          type TEXT NOT NULL,
          chunk_kind TEXT NOT NULL,
          language TEXT,
          file_path TEXT NOT NULL,
          line_start INTEGER,
          line_end INTEGER,
          symbol_name TEXT,
          class_name TEXT,
          package_name TEXT,
          http_method TEXT,
          api_path TEXT,
          tags TEXT,
          page_title TEXT,
          section_heading TEXT,
          content_hash TEXT NOT NULL,
          commit_sha TEXT,
          web_url TEXT,
          indexed_at TEXT NOT NULL,
          embedding BLOB
        )
      `);

      // ─── FTS5 full-text index (BM25 keyword search) ───
      // Indexes: content, symbol_name, class_name, file_path, api_path, page_title
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(
          id UNINDEXED,
          content,
          symbol_name,
          class_name,
          file_path,
          api_path,
          page_title,
          content='${table}',
          content_rowid='rowid',
          tokenize='porter unicode61'
        )
      `);

      // ─── Triggers to keep FTS in sync with main table ───
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_ai AFTER INSERT ON ${table} BEGIN
          INSERT INTO ${ftsTable}(rowid, id, content, symbol_name, class_name, file_path, api_path, page_title)
          VALUES (new.rowid, new.id, new.content, COALESCE(new.symbol_name,''), COALESCE(new.class_name,''), new.file_path, COALESCE(new.api_path,''), COALESCE(new.page_title,''));
        END;
        CREATE TRIGGER IF NOT EXISTS ${table}_ad AFTER DELETE ON ${table} BEGIN
          INSERT INTO ${ftsTable}(${ftsTable}, rowid, id, content, symbol_name, class_name, file_path, api_path, page_title)
          VALUES ('delete', old.rowid, old.id, old.content, COALESCE(old.symbol_name,''), COALESCE(old.class_name,''), old.file_path, COALESCE(old.api_path,''), COALESCE(old.page_title,''));
        END;
        CREATE TRIGGER IF NOT EXISTS ${table}_au AFTER UPDATE ON ${table} BEGIN
          INSERT INTO ${ftsTable}(${ftsTable}, rowid, id, content, symbol_name, class_name, file_path, api_path, page_title)
          VALUES ('delete', old.rowid, old.id, old.content, COALESCE(old.symbol_name,''), COALESCE(old.class_name,''), old.file_path, COALESCE(old.api_path,''), COALESCE(old.page_title,''));
          INSERT INTO ${ftsTable}(rowid, id, content, symbol_name, class_name, file_path, api_path, page_title)
          VALUES (new.rowid, new.id, new.content, COALESCE(new.symbol_name,''), COALESCE(new.class_name,''), new.file_path, COALESCE(new.api_path,''), COALESCE(new.page_title,''));
        END;
      `);

      // ─── Indexes ───
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${table}(project);
        CREATE INDEX IF NOT EXISTS idx_${table}_branch ON ${table}(project, branch);
        CREATE INDEX IF NOT EXISTS idx_${table}_source ON ${table}(source);
        CREATE INDEX IF NOT EXISTS idx_${table}_file_path ON ${table}(project, file_path);
        CREATE INDEX IF NOT EXISTS idx_${table}_content_hash ON ${table}(content_hash);
        CREATE INDEX IF NOT EXISTS idx_${table}_symbol ON ${table}(symbol_name);
        CREATE INDEX IF NOT EXISTS idx_${table}_api_path ON ${table}(api_path);
      `);
    }

    // ─── Sync state table ───
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.prefix}sync_state (
        project TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        last_commit_sha TEXT,
        last_sync_at TEXT,
        total_chunks INTEGER DEFAULT 0,
        status TEXT DEFAULT 'idle',
        error TEXT
      )
    `);
    this.migrateSyncStateColumns();
    this.migrateChunkTableWebUrl();
    this.migrateWikiToDocsType();
    this.migrateRelatedProjectsAndAstColumns();

    // ─── Dependency graph table ───
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.prefix}dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_service TEXT NOT NULL,
        to_service TEXT NOT NULL,
        type TEXT NOT NULL,
        detail TEXT,
        UNIQUE(from_service, to_service, type)
      );
      CREATE INDEX IF NOT EXISTS idx_${this.prefix}dep_from ON ${this.prefix}dependencies(from_service);
      CREATE INDEX IF NOT EXISTS idx_${this.prefix}dep_to ON ${this.prefix}dependencies(to_service);
    `);

    // ─── Project meta table ───
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.prefix}projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        url TEXT,
        branches TEXT,
        default_branch TEXT DEFAULT 'main',
        language TEXT,
        description TEXT,
        last_indexed_at TEXT
      )
    `);
  }

  // ═══════════════════════════════════════════════════════════════
  //  CRUD
  // ═══════════════════════════════════════════════════════════════

  async upsert(collection: CollectionName, chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const table = this.tableName(collection);

    // Delete-then-insert to fire FTS triggers correctly
    const delStmt = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    const insStmt = this.db.prepare(`
      INSERT INTO ${table} (
        id, content, source, project, branch, type, chunk_kind,
        language, file_path, line_start, line_end,
        symbol_name, class_name, package_name,
        http_method, api_path, tags,
        page_title, section_heading,
        related_projects, calls, called_by, extends_class, implements_ifaces,
        content_hash, commit_sha, web_url, indexed_at, embedding
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);

    const upsertMany = this.db.transaction((items: Chunk[]) => {
      for (const chunk of items) {
        const m = chunk.metadata;
        delStmt.run(m.id);
        insStmt.run(
          m.id, chunk.content, m.source, m.project, m.branch, m.type, m.chunkKind,
          m.language ?? null, m.filePath, m.lineStart ?? null, m.lineEnd ?? null,
          m.symbolName ?? null, m.className ?? null, m.packageName ?? null,
          m.httpMethod ?? null, m.apiPath ?? null, m.tags ? JSON.stringify(m.tags) : null,
          m.pageTitle ?? null, m.sectionHeading ?? null,
          m.relatedProjects ? JSON.stringify(m.relatedProjects) : null,
          m.calls ? JSON.stringify(m.calls) : null,
          m.calledBy ? JSON.stringify(m.calledBy) : null,
          m.extendsClass ?? null,
          m.implementsInterfaces ? JSON.stringify(m.implementsInterfaces) : null,
          m.contentHash, m.commitSha ?? null, m.webUrl ?? null, m.indexedAt,
          chunk.embedding ? Buffer.from(new Float32Array(chunk.embedding).buffer) : null,
        );
      }
    });
    upsertMany(chunks);
  }

  async deleteByFile(collection: CollectionName, project: string, filePath: string): Promise<number> {
    const table = this.tableName(collection);
    const result = this.db.prepare(`DELETE FROM ${table} WHERE project = ? AND file_path = ?`).run(project, filePath);
    return result.changes;
  }

  async deleteByProject(collection: CollectionName, project: string): Promise<number> {
    const table = this.tableName(collection);
    const result = this.db.prepare(`DELETE FROM ${table} WHERE project = ?`).run(project);
    return result.changes;
  }

  // ═══════════════════════════════════════════════════════════════
  //  SEARCH — Vector (legacy interface, used by ChromaDB too)
  // ═══════════════════════════════════════════════════════════════

  async query(options: VectorStoreQueryOptions): Promise<VectorStoreQueryResult[]> {
    return this.vectorSearch(options);
  }

  // ═══════════════════════════════════════════════════════════════
  //  SEARCH — FTS5 BM25 keyword search
  // ═══════════════════════════════════════════════════════════════

  keywordSearch(collection: CollectionName, query: string, filter?: SearchFilter, topK: number = 10): VectorStoreQueryResult[] {
    const table = this.tableName(collection);
    const ftsTable = `${table}_fts`;
    const { clause, params } = this.buildFilterClause(filter, 't');

    // FTS5: use the virtual table name in FROM/WHERE (no alias). Some SQLite builds reject `WHERE f MATCH ?`
    // with alias `f` ("no such column: f"). bm25() first arg must be the FTS5 table name, not an alias.
    const filterJoin = clause ? `AND ${clause}` : '';
    const sql = `
      SELECT t.*, -bm25(${ftsTable}) AS fts_score
      FROM ${ftsTable}
      JOIN ${table} t ON ${ftsTable}.id = t.id
      WHERE ${ftsTable} MATCH ?
      ${filterJoin}
      ORDER BY fts_score DESC
      LIMIT ?
    `;

    // Escape FTS5 special characters, then add * for prefix matching
    const ftsQuery = this.buildFtsQuery(query);
    const rows = this.db.prepare(sql).all(ftsQuery, ...params, topK) as any[];

    // Normalize BM25 scores to 0-1 range
    const maxScore = rows.length > 0 ? Math.max(...rows.map(r => r.fts_score)) : 1;
    return rows.map(row => ({
      chunk: this.rowToChunk(row),
      score: maxScore > 0 ? row.fts_score / maxScore : 0,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  //  SEARCH — Hybrid (BM25 + Vector weighted merge)
  // ═══════════════════════════════════════════════════════════════

  async hybridSearch(options: HybridSearchOptions): Promise<VectorStoreQueryResult[]> {
    const mode = options.mode ?? 'hybrid';
    const topK = options.topK ?? 10;
    const kw = options.keywordWeight ?? 0.3;
    const vw = options.vectorWeight ?? 0.7;

    if (mode === 'keyword') {
      return this.keywordSearch(options.collection, options.query, options.filter, topK);
    }

    if (mode === 'vector') {
      if (!options.embedding) throw new Error('Vector mode requires embedding');
      return this.vectorSearch({
        collection: options.collection,
        embedding: options.embedding,
        filter: options.filter,
        topK,
        minScore: options.minScore,
      });
    }

    // ─── Hybrid mode: run both, merge by weighted score ───
    const keywordResults = this.keywordSearch(options.collection, options.query, options.filter, topK * 2);

    let vectorResults: VectorStoreQueryResult[] = [];
    if (options.embedding) {
      vectorResults = await this.vectorSearch({
        collection: options.collection,
        embedding: options.embedding,
        filter: options.filter,
        topK: topK * 2,
        minScore: options.minScore,
      });
    }

    // Merge: combine by chunk id, weighted score
    const scoreMap = new Map<string, { chunk: any; kwScore: number; vecScore: number }>();

    for (const r of keywordResults) {
      scoreMap.set(r.chunk.metadata.id, {
        chunk: r.chunk,
        kwScore: r.score,
        vecScore: 0,
      });
    }

    for (const r of vectorResults) {
      const existing = scoreMap.get(r.chunk.metadata.id);
      if (existing) {
        existing.vecScore = r.score;
      } else {
        scoreMap.set(r.chunk.metadata.id, {
          chunk: r.chunk,
          kwScore: 0,
          vecScore: r.score,
        });
      }
    }

    // Calculate weighted final score
    const merged = [...scoreMap.values()].map(item => ({
      chunk: item.chunk,
      score: kw * item.kwScore + vw * item.vecScore,
    }));

    // If BM25 has a very high confidence hit (>0.8), boost it
    for (const item of merged) {
      const entry = scoreMap.get(item.chunk.metadata.id)!;
      if (entry.kwScore > 0.8) {
        item.score = Math.max(item.score, entry.kwScore);
      }
    }

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
  }

  // ═══════════════════════════════════════════════════════════════
  //  GRAPH — Dependency queries
  // ═══════════════════════════════════════════════════════════════

  upsertDependency(edge: DependencyEdge): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO ${this.prefix}dependencies (from_service, to_service, type, detail)
      VALUES (?, ?, ?, ?)
    `).run(edge.from, edge.to, edge.type, edge.detail ?? null);
  }

  upsertDependencies(edges: DependencyEdge[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ${this.prefix}dependencies (from_service, to_service, type, detail)
      VALUES (?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((items: DependencyEdge[]) => {
      for (const e of items) stmt.run(e.from, e.to, e.type, e.detail ?? null);
    });
    insertMany(edges);
  }

  /** Get all services that depend on `service` (who calls me?) */
  getUpstream(service: string): DependencyEdge[] {
    return this.db.prepare(
      `SELECT * FROM ${this.prefix}dependencies WHERE to_service = ?`
    ).all(service) as DependencyEdge[];
  }

  /** Get all services that `service` depends on (who do I call?) */
  getDownstream(service: string): DependencyEdge[] {
    return this.db.prepare(
      `SELECT * FROM ${this.prefix}dependencies WHERE from_service = ?`
    ).all(service) as DependencyEdge[];
  }

  /** BFS: find all services reachable from `service` within `maxDepth` hops */
  getImpactChain(service: string, maxDepth: number = 3): GraphQueryResult {
    const visited = new Set<string>();
    const allEdges: DependencyEdge[] = [];
    let frontier = [service];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      const nextFrontier: string[] = [];
      for (const svc of frontier) {
        if (visited.has(svc)) continue;
        visited.add(svc);

        const upstream = this.getUpstream(svc);
        const downstream = this.getDownstream(svc);
        allEdges.push(...upstream, ...downstream);

        for (const e of [...upstream, ...downstream]) {
          const neighbor = e.from === svc ? e.to : e.from;
          if (!visited.has(neighbor)) nextFrontier.push(neighbor);
        }
      }
      frontier = nextFrontier;
      depth++;
    }

    visited.delete(service); // Don't include self
    return { edges: allEdges, reachable: [...visited], depth };
  }

  /** Get full dependency graph */
  getAllDependencies(): DependencyEdge[] {
    return this.db.prepare(`SELECT * FROM ${this.prefix}dependencies`).all() as DependencyEdge[];
  }

  clearDependencies(service?: string): void {
    if (service) {
      this.db.prepare(`DELETE FROM ${this.prefix}dependencies WHERE from_service = ? OR to_service = ?`).run(service, service);
    } else {
      this.db.prepare(`DELETE FROM ${this.prefix}dependencies`).run();
    }
  }

  /** Remove edges originating from a project (before rebuilding from code scan). */
  clearOutgoingDependencies(fromService: string): void {
    this.db.prepare(`DELETE FROM ${this.prefix}dependencies WHERE from_service = ?`).run(fromService);
  }

  /**
   * Recompute `called_by` for all code chunks in a project+branch from `calls` (inverse graph).
   * Runs after indexing; clears then sets `called_by`. Chunks with no callers get NULL.
   */
  recomputeCalledByForProject(project: string, branch: string): void {
    const table = this.tableName('code');
    const rows = this.db.prepare(
      `SELECT id, file_path, symbol_name, class_name, chunk_kind, calls FROM ${table} WHERE project = ? AND branch = ?`,
    ).all(project, branch) as Array<{
      id: string;
      file_path: string;
      symbol_name: string | null;
      class_name: string | null;
      chunk_kind: string;
      calls: string | null;
    }>;

    const lite: CodeRowForCalls[] = rows.map(r => {
      let calls: string[] | null = null;
      if (r.calls) {
        try {
          calls = JSON.parse(r.calls) as string[];
        } catch {
          calls = null;
        }
      }
      return {
        id: r.id,
        filePath: r.file_path,
        symbolName: r.symbol_name,
        className: r.class_name,
        chunkKind: r.chunk_kind,
        calls,
      };
    });

    const map = buildCalledByMap(lite);
    this.db.prepare(`UPDATE ${table} SET called_by = NULL WHERE project = ? AND branch = ?`).run(project, branch);

    const upd = this.db.prepare(`UPDATE ${table} SET called_by = ? WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const [id, labels] of map) {
        upd.run(JSON.stringify(labels), id);
      }
    });
    tx();
  }

  // ═══════════════════════════════════════════════════════════════
  //  META / STATUS
  // ═══════════════════════════════════════════════════════════════

  async count(collection: CollectionName, filter?: SearchFilter): Promise<number> {
    const table = this.tableName(collection);
    const { clause, params } = this.buildFilterClause(filter);
    const where = clause ? `WHERE ${clause}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${table} ${where}`).get(...params) as any;
    return row.cnt;
  }

  async listProjects(): Promise<string[]> {
    const projects = new Set<string>();
    for (const col of ['code', 'api', 'docs', 'config'] as CollectionName[]) {
      const table = this.tableName(col);
      const rows = this.db.prepare(`SELECT DISTINCT project FROM ${table}`).all() as any[];
      for (const row of rows) projects.add(row.project);
    }
    return [...projects];
  }

  /** Get language distribution for a project (from code collection). */
  getProjectLanguages(project: string): Record<string, number> {
    const table = this.tableName('code');
    const rows = this.db.prepare(
      `SELECT language, COUNT(*) as cnt FROM ${table} WHERE project = ? AND language IS NOT NULL GROUP BY language ORDER BY cnt DESC`
    ).all(project) as Array<{ language: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[row.language] = row.cnt;
    return result;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ─── Sync state helpers ─────────────────────────────

  /** Add optional columns for first-sync resume (SQLite has no IF NOT EXISTS for columns). */
  private migrateSyncStateColumns(): void {
    const table = `${this.prefix}sync_state`;
    const add = (col: string, def: string) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      } catch {
        /* column already exists */
      }
    };
    add('index_resume_offset', 'INTEGER');
    add('index_resume_head', 'TEXT');
  }

  /** Older DBs created before webUrl metadata need this column on all chunk tables. */
  private migrateChunkTableWebUrl(): void {
    const collections: CollectionName[] = ['code', 'api', 'docs', 'config'];
    for (const col of collections) {
      const table = this.tableName(col);
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN web_url TEXT`);
      } catch {
        /* column already exists */
      }
    }
  }

  /** Migrate existing 'wiki' type values to 'docs' (idempotent). */
  private migrateWikiToDocsType(): void {
    const table = this.tableName('docs');
    this.db.exec(`UPDATE ${table} SET type = 'docs' WHERE type = 'wiki'`);
  }

  /** Add relatedProjects and AST metadata columns to all chunk tables (idempotent). */
  private migrateRelatedProjectsAndAstColumns(): void {
    const collections: CollectionName[] = ['code', 'api', 'docs', 'config'];
    const newCols = [
      ['related_projects', 'TEXT'],
      ['calls', 'TEXT'],
      ['called_by', 'TEXT'],
      ['extends_class', 'TEXT'],
      ['implements_ifaces', 'TEXT'],
    ];
    for (const col of collections) {
      const table = this.tableName(col);
      for (const [colName, colDef] of newCols) {
        try {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
        } catch {
          /* column already exists */
        }
      }
    }
  }

  getSyncState(project: string): any {
    return this.db.prepare(`SELECT * FROM ${this.prefix}sync_state WHERE project = ?`).get(project);
  }

  setSyncState(project: string, state: Partial<any>): void {
    const existing = this.getSyncState(project);
    if (existing) {
      const sets: string[] = [];
      const vals: any[] = [];
      for (const [k, v] of Object.entries(state)) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
      vals.push(project);
      this.db.prepare(`UPDATE ${this.prefix}sync_state SET ${sets.join(', ')} WHERE project = ?`).run(...vals);
    } else {
      this.db.prepare(
        `INSERT INTO ${this.prefix}sync_state (project, provider, last_commit_sha, last_sync_at, total_chunks, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(project, state.provider ?? 'local', state.last_commit_sha ?? null,
        state.last_sync_at ?? new Date().toISOString(), state.total_chunks ?? 0, state.status ?? 'idle');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  INTERNAL
  // ═══════════════════════════════════════════════════════════════

  private vectorSearch(options: VectorStoreQueryOptions): VectorStoreQueryResult[] {
    const table = this.tableName(options.collection);
    const topK = options.topK ?? 10;
    const { clause, params } = this.buildFilterClause(options.filter);

    const rows = this.db.prepare(`
      SELECT *, embedding FROM ${table}
      WHERE embedding IS NOT NULL ${clause ? 'AND ' + clause : ''}
    `).all(...params) as any[];

    if (rows.length === 0) return [];

    const queryVec = new Float32Array(options.embedding);
    const results: VectorStoreQueryResult[] = [];

    for (const row of rows) {
      if (!row.embedding) continue;
      const stored = new Float32Array(
        row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
      );
      const score = cosineSimilarity(queryVec, stored);
      if (options.minScore && score < options.minScore) continue;
      results.push({ chunk: this.rowToChunk(row), score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  private tableName(collection: CollectionName): string {
    return `${this.prefix}${collection}`;
  }

  private buildFtsQuery(query: string): string {
    // Escape FTS5 special chars, support partial matching with *
    const escaped = query
      .replace(/['"]/g, '')
      .replace(/[^\w\s\u4e00-\u9fff.-]/g, ' ')  // keep CJK, alphanumeric, dot, hyphen
      .trim();
    if (!escaped) return '""';
    // Split into tokens, add prefix matching
    const tokens = escaped.split(/\s+/).filter(Boolean);
    return tokens.map(t => `"${t}"*`).join(' OR ');
  }

  /** @param tableAlias qualify columns (e.g. `t`) for JOIN queries such as keywordSearch */
  private buildFilterClause(filter?: SearchFilter, tableAlias?: string): { clause: string; params: any[] } {
    if (!filter) return { clause: '', params: [] };
    const conditions: string[] = [];
    const params: any[] = [];
    const q = (col: string) => (tableAlias ? `${tableAlias}.${col}` : col);

    const addFilter = (field: string, value: any) => {
      if (value == null) return;
      if (Array.isArray(value)) {
        conditions.push(`${q(field)} IN (${value.map(() => '?').join(',')})`);
        params.push(...value);
      } else {
        conditions.push(`${q(field)} = ?`);
        params.push(value);
      }
    };

    addFilter('source', filter.source);
    // Project filter: also match chunks whose related_projects contain the project name
    if (filter.project != null) {
      const projects = Array.isArray(filter.project) ? filter.project : [filter.project];
      const projectConds: string[] = [];
      for (const p of projects) {
        projectConds.push(`${q('project')} = ?`);
        params.push(p);
        projectConds.push(`${q('related_projects')} LIKE ?`);
        params.push(`%"${p}"%`);
      }
      conditions.push(`(${projectConds.join(' OR ')})`);
    }
    if (filter.branch) { conditions.push(`${q('branch')} = ?`); params.push(filter.branch); }
    addFilter('language', filter.language);
    if (filter.filePath) { conditions.push(`${q('file_path')} LIKE ?`); params.push(`%${filter.filePath}%`); }
    if (filter.httpMethod) { conditions.push(`${q('http_method')} = ?`); params.push(filter.httpMethod); }

    return { clause: conditions.join(' AND '), params };
  }

  private rowToChunk(row: any): Chunk {
    return {
      content: row.content,
      metadata: {
        id: row.id, source: row.source, project: row.project, branch: row.branch,
        type: row.type, chunkKind: row.chunk_kind, language: row.language,
        filePath: row.file_path, lineStart: row.line_start, lineEnd: row.line_end,
        symbolName: row.symbol_name, className: row.class_name, packageName: row.package_name,
        httpMethod: row.http_method, apiPath: row.api_path,
        tags: row.tags ? JSON.parse(row.tags) : undefined,
        pageTitle: row.page_title, sectionHeading: row.section_heading,
        relatedProjects: row.related_projects ? JSON.parse(row.related_projects) : undefined,
        calls: row.calls ? JSON.parse(row.calls) : undefined,
        calledBy: row.called_by ? JSON.parse(row.called_by) : undefined,
        extendsClass: row.extends_class ?? undefined,
        implementsInterfaces: row.implements_ifaces ? JSON.parse(row.implements_ifaces) : undefined,
        contentHash: row.content_hash, commitSha: row.commit_sha,
        webUrl: row.web_url ?? undefined, indexedAt: row.indexed_at,
      },
    };
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
