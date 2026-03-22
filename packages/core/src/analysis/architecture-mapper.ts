/**
 * Architecture Mapper — generates a service dependency map from indexed data.
 */

import type { ArchitectureMap, ServiceNode, DependencyEdge } from '../types/index.js';
import type { VectorStore } from '../store/vector-store.js';

export class ArchitectureMapper {
  constructor(private store: VectorStore) {}

  /**
   * Generate architecture map from indexed projects.
   */
  async generateMap(): Promise<ArchitectureMap> {
    const projects = await this.store.listProjects();
    const services: Record<string, ServiceNode> = {};
    const dependencies: DependencyEdge[] = [];

    for (const project of projects) {
      // Detect service type from indexed metadata
      const codeCount = await this.store.count('code', { project });
      const apiCount = await this.store.count('api', { project });

      const service: ServiceNode = {
        name: project,
        type: apiCount > 0 ? 'microservice' : 'library',
        apisExposed: [],
        databases: [],
        mqProduce: [],
        mqConsume: [],
      };

      // Detect language from code chunks
      // (In a full implementation, we'd query the store for language distribution)
      service.language = 'unknown';

      services[project] = service;
    }

    return {
      services,
      dependencies,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Export architecture map as Mermaid diagram.
   */
  static toMermaid(map: ArchitectureMap): string {
    const lines: string[] = ['graph LR'];

    for (const [name, service] of Object.entries(map.services)) {
      const label = `${name}[${name}<br/>${service.language ?? ''}]`;
      lines.push(`  ${safeName(name)}${label}`);
    }

    for (const dep of map.dependencies) {
      const label = dep.type;
      lines.push(`  ${safeName(dep.from)} -->|${label}| ${safeName(dep.to)}`);
    }

    return lines.join('\n');
  }
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}
