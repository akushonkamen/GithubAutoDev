/**
 * Checkpoint barrel — T-M10-006.
 */

export {
  type CheckpointPayload,
  type CheckpointRecord,
  type ImmutableStorageAdapter,
  InMemoryImmutableAdapter,
  S3ImmutableAdapter,
  hashRecords,
  signCheckpoint,
  verifyCheckpointSignature,
} from './immutable-storage-adapter.js';
export {
  type AuditCheckpointWriterDeps,
  type WriteCheckpointInput,
  AuditCheckpointWriter,
} from './audit-checkpoint-writer.js';
export {
  type CheckpointVerifierDeps,
  type VerifyResult,
  CheckpointVerifier,
} from './checkpoint-verifier.js';
