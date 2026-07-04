/**
 * Happy-path fixture — wires the full in-memory graph of services the
 * e2e suite drives.
 *
 * One fixture = one self-contained world: bus, audit chain, artifact
 * store, db repos, fakes for git/github/runner. The fixture exposes
 * the production services (BranchService, CommitBuilder, PR service,
 * ReviewRunner, SecurityReviewRunner, GateAggregator,
 * MergeFinalEvaluator, MergeService, IssueCloseService, CheckpointVerifier)
 * wired against those fakes.
 *
 * The test drives those services top-to-bottom and asserts at each gate.
 */

import { InMemoryArtifactStore } from '@cgao/artifacts';
import {
  type AuditChainService,
  AuditCheckpointWriter,
  CheckpointVerifier,
  InMemoryAuditChainService,
  InMemoryImmutableAdapter,
} from '@cgao/audit';
import { InMemoryReviewFindingRepository, InMemoryWorkflowRunRepository } from '@cgao/db';
import { InMemoryEventBus } from '@cgao/eventbus';
import {
  BranchService,
  CommitBuilder,
  GateAggregator,
  GateResultsReader,
  GitHubStateHydrator,
  IssueCloseService,
  MergeFinalEvaluator,
  MergeService,
  PullRequestService,
  ReviewFindingRepo,
  ReviewRunner,
  SecurityReviewRunner,
  WorkflowRunPrAdapter,
  buildHandoff,
  buildImplementationPlan,
  classify,
  generateRequirementSpec,
} from '@cgao/orchestrator';
import { FakeGitPort } from '../fakes/fake-git-port.js';
import { FakeGitHubClient } from '../fakes/fake-github-client.js';
import { FakeRunnerQueue } from '../fakes/fake-runner-queue.js';

/** Static configuration every scenario starts from. */
export interface FixtureConfig {
  /** Repo full name (e.g. 'cgao/test'). */
  repo: string;
  /** Issue number the webhook delivered. */
  issueNumber: number;
  /** Bot login for the marker HMAC. */
  botLogin: string;
  /** HMAC secret for PR markers + status comments. */
  controlToken: string;
  /** Initial base sha for the work branch. */
  baseSha: string;
}

export interface HappyPathFixture {
  config: FixtureConfig;
  bus: InMemoryEventBus;
  audit: AuditChainService;
  immutable: InMemoryImmutableAdapter;
  checkpointVerifier: CheckpointVerifier;
  checkpointWriter: AuditCheckpointWriter;
  artifacts: InMemoryArtifactStore;
  workflowRuns: InMemoryWorkflowRunRepository;
  reviewFindings: InMemoryReviewFindingRepository;
  findingRepo: ReviewFindingRepo;
  fakeGitHub: FakeGitHubClient;
  fakeGit: FakeGitPort;
  fakeQueue: FakeRunnerQueue;
  branchService: BranchService;
  commitBuilder: CommitBuilder;
  prService: PullRequestService;
  reviewRunner: ReviewRunner;
  securityRunner: SecurityReviewRunner;
  gateReader: GateResultsReader;
  gateAggregator: GateAggregator;
  hydrator: GitHubStateHydrator;
  finalEvaluator: MergeFinalEvaluator;
  mergeService: MergeService;
  issueCloseService: IssueCloseService;
  /** Builders imported so the test does not have to re-import. */
  builders: {
    classify: typeof classify;
    generateRequirementSpec: typeof generateRequirementSpec;
    buildImplementationPlan: typeof buildImplementationPlan;
    buildHandoff: typeof buildHandoff;
  };
}

/**
 * Default config — every test scenario overrides only the fields it
 * cares about.
 */
export const DEFAULT_FIXTURE_CONFIG: FixtureConfig = {
  repo: 'cgao/test',
  issueNumber: 42,
  botLogin: 'cgao-bot[bot]',
  controlToken: 'e2e-control-token',
  baseSha: '0'.repeat(40),
};

/**
 * Build a fresh, isolated world. Every service is constructed against
 * in-memory implementations + fakes; no real I/O happens.
 */
export function buildHappyPathFixture(
  configOverride: Partial<FixtureConfig> = {},
): HappyPathFixture {
  const config: FixtureConfig = { ...DEFAULT_FIXTURE_CONFIG, ...configOverride };

  const bus = new InMemoryEventBus();
  const audit = new InMemoryAuditChainService();
  const immutable = new InMemoryImmutableAdapter();
  const artifacts = new InMemoryArtifactStore();
  const workflowRuns = new InMemoryWorkflowRunRepository();
  const reviewFindings = new InMemoryReviewFindingRepository();

  const fakeGitHub = new FakeGitHubClient({ baseSha: config.baseSha });
  const fakeGit = new FakeGitPort({ baseSha: config.baseSha });
  const fakeQueue = new FakeRunnerQueue();

  const findingRepo = new ReviewFindingRepo({ repo: reviewFindings });

  const checkpointWriter = new AuditCheckpointWriter({
    chain: audit,
    storage: immutable,
    secret: config.controlToken,
  });
  const checkpointVerifier = new CheckpointVerifier({
    chain: audit,
    storage: immutable,
    secret: config.controlToken,
  });

  const branchService = new BranchService({ git: fakeGit, audit });
  const commitBuilder = new CommitBuilder({ git: fakeGit, audit });
  const prAdapter = new WorkflowRunPrAdapter(workflowRuns);
  const prService = new PullRequestService({
    github: fakeGitHub,
    runs: prAdapter,
    audit,
    config: { markerSecret: config.controlToken },
  });
  const reviewRunner = new ReviewRunner({
    llm: benignCodeLlm,
    store: artifacts,
    findings: findingRepo,
  });
  const securityRunner = new SecurityReviewRunner({
    llm: benignSecurityLlm,
    store: artifacts,
    findings: findingRepo,
  });

  const gateReader = new GateResultsReader({
    testGates: emptyTestGateLookup,
    aiReviews: emptyAiReviewLookup,
    humanApprovals: emptyHumanApprovalLookup,
    risk: emptyRiskLookup,
    findings: findingRepo,
  });
  const gateAggregator = new GateAggregator(gateReader);
  const hydrator = new GitHubStateHydrator(fakeGitHub);
  const finalEvaluator = new MergeFinalEvaluator({
    hydrator,
    aggregator: gateAggregator,
    store: artifacts,
  });
  const mergeService = new MergeService({
    github: fakeGitHub,
    audit,
    resolveMergeToken: async () => ({
      token: 'merge-token',
      scopes: ['repo:pull_requests:write', 'repo:contents:write', 'repo:status:write'],
      isMergeManager: true,
      validationErrors: [],
    }),
  });
  const issueCloseService = new IssueCloseService(fakeGitHub, audit);

  return {
    config,
    bus,
    audit,
    immutable,
    checkpointVerifier,
    checkpointWriter,
    artifacts,
    workflowRuns,
    reviewFindings,
    findingRepo,
    fakeGitHub,
    fakeGit,
    fakeQueue,
    branchService,
    commitBuilder,
    prService,
    reviewRunner,
    securityRunner,
    gateReader,
    gateAggregator,
    hydrator,
    finalEvaluator,
    mergeService,
    issueCloseService,
    builders: {
      classify,
      generateRequirementSpec,
      buildImplementationPlan,
      buildHandoff,
    },
  };
}

/**
 * Benign code-review LLM stub: returns no findings + a clean summary.
 * The e2e test's happy path expects zero blocking findings here.
 */
const benignCodeLlm: { complete(args: { prompt: string }): Promise<string> } = {
  async complete() {
    return JSON.stringify({
      summary: 'No issues found.',
      findings: [],
    });
  },
};

/** Benign security-review LLM stub. */
const benignSecurityLlm: { complete(args: { prompt: string }): Promise<string> } = {
  async complete() {
    return JSON.stringify({
      summary: 'No security issues found.',
      findings: [],
    });
  },
};

/** Empty TestGateLookup — returns a passing test gate at the head sha. */
const emptyTestGateLookup = {
  async findLatest(args: { runId: string }) {
    // The happy path uses the head sha from the merge evaluator; we
    // return a passing test gate bound to whatever the caller asks
    // about. We can't synthesize the headSha here without knowing it,
    // so we return null and rely on the fixture's hydrator + a custom
    // lookup that the test wires in for the merge gate. For the e2e
    // happy path, the test passes a real passing test gate via the
    // gate reader override (see happy-path.test.ts).
    void args;
    return null;
  },
};

const emptyAiReviewLookup = {
  async list() {
    return [];
  },
};

const emptyHumanApprovalLookup = {
  async findLatest() {
    return null;
  },
};

const emptyRiskLookup = {
  async find() {
    return null;
  },
};

/** Re-export the empty lookups' types so the test can override them. */
export const emptyLookups = {
  testGates: emptyTestGateLookup,
  aiReviews: emptyAiReviewLookup,
  humanApprovals: emptyHumanApprovalLookup,
  risk: emptyRiskLookup,
};
