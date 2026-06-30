/**
 * Thrown by {@link IamClient.verifyToken} when a token cannot be trusted
 * (bad signature, wrong `iss`/`aud`, expired, JWKS unreachable, malformed).
 * Verification is fail-closed: callers must treat a rejection as "deny".
 */
export class TokenVerificationError extends Error {
  override readonly name = 'TokenVerificationError';
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super(`token verification failed: ${reason}`, options);
    this.reason = reason;
  }
}
