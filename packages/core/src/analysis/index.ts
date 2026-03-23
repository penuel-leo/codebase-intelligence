export { analyzeDependencies, toEdges } from './dependency-analyzer.js';
export type { DependencyAnalysis } from './dependency-analyzer.js';
export { analyzeAstDependencies } from './ast-dependency-analyzer.js';
export { buildCalledByMap, callerLabel, resolveCallee } from './called-by.js';
export type { CodeRowForCalls } from './called-by.js';
export { ArchitectureMapper } from './architecture-mapper.js';
export { ImpactAnalyzer } from './impact-analyzer.js';
export type { ImpactReport } from './impact-analyzer.js';
