/**
 * Impact Analyzer — evaluates the scope and impact of changes.
 * Uses vector search + dependency graph to find affected services.
 */

import type { SearchResult, DependencyEdge } from '../types/index.js';
import { SearchEngine } from '../query/search.js';

export interface ImpactReport {
  /** Original query / requirement description */
  query: string;
  /** Directly related code */
  directHits: SearchResult[];
  /** Services affected */
  affectedServices: string[];
  /** Files that may need changes */
  affectedFiles: string[];
  /** Upstream/downstream dependencies */
  relatedDependencies: DependencyEdge[];
  /** Estimated scope */
  scope: 'small' | 'medium' | 'large';
}

export class ImpactAnalyzer {
  constructor(private search: SearchEngine) {}

  /**
   * Analyze the impact of a requirement or change description.
   */
  async analyze(description: string): Promise<ImpactReport> {
    // Search across all collections
    const results = await this.search.search(description, {
      topK: 20,
      minScore: 0.3,
    });

    // Extract unique services and files
    const services = new Set<string>();
    const files = new Set<string>();

    for (const result of results) {
      services.add(result.chunk.metadata.project);
      files.add(`${result.chunk.metadata.project}/${result.chunk.metadata.filePath}`);
    }

    // Estimate scope
    let scope: ImpactReport['scope'] = 'small';
    if (services.size > 3) scope = 'large';
    else if (services.size > 1 || files.size > 5) scope = 'medium';

    return {
      query: description,
      directHits: results.slice(0, 10),
      affectedServices: [...services],
      affectedFiles: [...files],
      relatedDependencies: [], // TODO: integrate with graph store
      scope,
    };
  }
}
