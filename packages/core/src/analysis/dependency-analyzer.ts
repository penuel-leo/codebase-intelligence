/**
 * Dependency Analyzer — extracts import/require/API call relationships from code.
 * Builds a dependency graph stored in SQLite.
 */

import type { DependencyEdge } from '../types/index.js';

/** Patterns for detecting inter-service calls */
const HTTP_CLIENT_PATTERNS = [
  // Java/Spring
  /(?:@FeignClient|@WebClient|RestTemplate)\s*[\(\{].*?(?:url|value|name)\s*=\s*["']([^"']+)/gs,
  // Generic HTTP URLs in code
  /(?:fetch|axios|http\.get|http\.post|request)\s*\(\s*["'`]([^"'`]+)/g,
  // Go HTTP client
  /http\.(?:Get|Post|Put|Delete)\s*\(\s*["']([^"']+)/g,
];

const MQ_PRODUCER_PATTERNS = [
  // RabbitMQ / Kafka
  /(?:send|publish|produce|emit)\s*\(\s*["']([^"']+)["']/g,
  // @SendTo annotation
  /@(?:SendTo|Output|RabbitListener)\s*\(\s*["']([^"']+)/g,
];

const MQ_CONSUMER_PATTERNS = [
  /(?:subscribe|consume|listen|on)\s*\(\s*["']([^"']+)["']/g,
  /@(?:RabbitListener|KafkaListener|EventHandler|Subscribe)\s*\(\s*["']([^"']+)/g,
];

const GRPC_PATTERNS = [
  // Proto service calls
  /service\s+(\w+)\s*\{/g,
  /rpc\s+(\w+)\s*\(/g,
];

export interface DependencyAnalysis {
  httpCalls: string[];
  mqProduce: string[];
  mqConsume: string[];
  grpcServices: string[];
  imports: string[];
}

/**
 * Analyze a code file for inter-service dependencies.
 */
export function analyzeDependencies(content: string, language: string): DependencyAnalysis {
  const result: DependencyAnalysis = {
    httpCalls: [],
    mqProduce: [],
    mqConsume: [],
    grpcServices: [],
    imports: [],
  };

  // HTTP client calls
  for (const pattern of HTTP_CLIENT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) result.httpCalls.push(match[1]);
    }
  }

  // MQ producers
  for (const pattern of MQ_PRODUCER_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) result.mqProduce.push(match[1]);
    }
  }

  // MQ consumers
  for (const pattern of MQ_CONSUMER_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) result.mqConsume.push(match[1]);
    }
  }

  // gRPC
  for (const pattern of GRPC_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) result.grpcServices.push(match[1]);
    }
  }

  // Imports (language-specific)
  result.imports = extractImports(content, language);

  return result;
}

function extractImports(content: string, language: string): string[] {
  const imports: string[] = [];

  switch (language) {
    case 'java':
    case 'kotlin': {
      const regex = /import\s+([\w.]+)/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        imports.push(match[1]);
      }
      break;
    }
    case 'go': {
      const regex = /import\s+(?:\(\s*)?["']([^"']+)["']/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        imports.push(match[1]);
      }
      break;
    }
    case 'python': {
      const regex = /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        imports.push(match[1] || match[2]);
      }
      break;
    }
    case 'javascript':
    case 'typescript': {
      const regex = /(?:import|require)\s*\(?["']([^"']+)["']\)?/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        imports.push(match[1]);
      }
      break;
    }
  }

  return imports;
}

/**
 * Convert dependency analysis into edges for the graph.
 */
export function toEdges(
  fromProject: string,
  analysis: DependencyAnalysis,
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  for (const url of analysis.httpCalls) {
    edges.push({
      from: fromProject,
      to: extractServiceFromUrl(url),
      type: 'http',
      detail: url,
    });
  }

  for (const topic of analysis.mqProduce) {
    edges.push({
      from: fromProject,
      to: topic,
      type: 'mq',
      detail: `produce: ${topic}`,
    });
  }

  for (const service of analysis.grpcServices) {
    edges.push({
      from: fromProject,
      to: service,
      type: 'grpc',
      detail: service,
    });
  }

  return edges;
}

function extractServiceFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    // Try to extract service name from path-like strings
    const parts = url.split('/').filter(Boolean);
    return parts[0] ?? url;
  }
}
