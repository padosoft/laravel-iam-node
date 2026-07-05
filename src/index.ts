export { IamClient } from './client.js';
export { TokenVerificationError } from './errors.js';
export { deny, isGranted, decisionFromBody } from './decision.js';
export { validateManifest, submitManifest } from './manifest.js';
export type { ManifestValidation, SubmitManifestOptions, SubmitManifestResult } from './manifest.js';
export type {
  Subject,
  Resource,
  DecisionContext,
  DecisionQuery,
  DecisionMatch,
  Decision,
  Claims,
  CacheOptions,
  VerifyOptions,
  IamClientConfig,
} from './types.js';
