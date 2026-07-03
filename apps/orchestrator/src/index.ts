export { default as app } from './server.js';
export { parseConfig } from './config/loader.js';

// Re-export modules used by cross-app test suites (security/concurrency).
export * from './modules/branches/branch-service.js';
export * from './modules/branches/naming-policy.js';
export * from './modules/commits/commit-builder.js';
export * from './modules/commits/commit-message-renderer.js';
export * from './modules/prs/pull-request-service.js';
export * from './modules/prs/pr-marker.js';
export * from './modules/prs/pr-body-renderer.js';
export * from './modules/prs/traceability-block.js';
export * from './modules/policy/dependency-change-detector.js';
export * from './modules/policy/sca-hook.js';
