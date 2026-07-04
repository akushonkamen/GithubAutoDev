/**
 * @cgao/e2e-tests — Plan A end-to-end happy-path integration test.
 *
 * Barrel for fixtures + fakes. The actual test lives under
 * src/__tests__/happy-path.test.ts.
 */

export * from './fakes/fake-github-client.js';
export * from './fakes/fake-git-port.js';
export * from './fakes/fake-runner-queue.js';
export * from './fixtures/happy-path-fixture.js';
