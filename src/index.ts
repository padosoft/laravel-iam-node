export { IamClient } from './client.js';
export { TokenVerificationError } from './errors.js';
export { deny, isGranted, decisionFromBody } from './decision.js';
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
