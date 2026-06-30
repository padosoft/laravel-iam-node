import type { IamClient } from './client.js';
import { isGranted } from './decision.js';
import type { Decision, DecisionContext, Resource, Subject } from './types.js';

/**
 * Minimal structural request/response shapes so the middleware works with both
 * Express (`req, res, next`) and Fastify (`request, reply, done` / async preHandler)
 * without taking a hard dependency on either framework.
 */
export interface MiddlewareRequest {
  user?: { id?: string | number; type?: string } | undefined;
  auth?: { sub?: string } | undefined;
  [k: string]: unknown;
}

export interface MiddlewareResponse {
  status(code: number): MiddlewareResponse;
  /** Express uses `json`; Fastify replies expose `send`. We try `json` first. */
  json?(body: unknown): unknown;
  send?(body: unknown): unknown;
  code?(code: number): MiddlewareResponse;
}

type Resolver<T> = T | ((req: MiddlewareRequest) => T | undefined);

export interface RequirePermissionOptions {
  /** How to extract the subject. Defaults to `req.user` / `req.auth.sub`. */
  subject?: Resolver<Subject | string>;
  resource?: Resolver<Resource | string>;
  context?: Resolver<DecisionContext>;
  organization?: Resolver<string>;
  application?: Resolver<string>;
  currentAal?: Resolver<string>;
  /** Custom rejection handler. Default: 403 JSON `{ error, decision }`. */
  onDeny?: (req: MiddlewareRequest, res: MiddlewareResponse, decision: Decision) => unknown;
}

/**
 * Express/Fastify middleware that gates a route behind a PDP permission.
 * Fail-closed: a missing subject, an unreachable PDP, or a pending step-up all
 * deny (HTTP 403). The decision is always the server's — never inferred locally.
 *
 * @example
 * app.post('/stock', requirePermission(iam, 'stock.adjust'), handler)
 */
export function requirePermission(
  client: IamClient,
  permission: string,
  options: RequirePermissionOptions = {},
) {
  return async function (
    req: MiddlewareRequest,
    res: MiddlewareResponse,
    next: (err?: unknown) => void,
  ): Promise<void> {
    const subject = resolveSubject(req, options.subject);
    if (!subject || !subject.id) {
      reject(req, res, denyDecision('no-subject'), options.onDeny);
      return;
    }

    // `check()` is itself fail-closed, but cache-key serialisation (`JSON.stringify`)
    // can throw on a circular `context` BEFORE any deny is returned. Without this
    // guard that throw becomes an unhandled rejection (Express 4 hangs the request,
    // Express 5 / Fastify 500s) and silently bypasses the 403. Catch → deny.
    let decision: Decision;
    try {
      decision = await client.check({
        subject,
        permission,
        ...optional('resource', resolveResource(req, options.resource)),
        ...optional('organization', resolve(req, options.organization)),
        ...optional('application', resolve(req, options.application)),
        ...optional('currentAal', resolve(req, options.currentAal)),
        context: resolve(req, options.context) ?? {},
      });
    } catch {
      reject(req, res, denyDecision('check-threw'), options.onDeny);
      return;
    }

    if (!isGranted(decision)) {
      reject(req, res, decision, options.onDeny);
      return;
    }

    next();
  };
}

function resolveSubject(
  req: MiddlewareRequest,
  resolver?: Resolver<Subject | string>,
): Subject | undefined {
  const value = resolve(req, resolver);
  if (typeof value === 'string') return { id: value };
  if (value && typeof value === 'object' && value.id) return value;

  // Fallbacks: a typical auth layer puts the user on `req.user` or `req.auth`.
  const id = req.user?.id ?? req.auth?.sub;
  if (id === undefined || id === null || id === '') return undefined;
  return { id: String(id), ...(req.user?.type ? { type: req.user.type } : {}) };
}

function resolveResource(
  req: MiddlewareRequest,
  resolver?: Resolver<Resource | string>,
): Resource | string | undefined {
  return resolve(req, resolver);
}

function resolve<T>(req: MiddlewareRequest, resolver?: Resolver<T>): T | undefined {
  if (typeof resolver === 'function') {
    return (resolver as (req: MiddlewareRequest) => T | undefined)(req);
  }
  return resolver;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function denyDecision(reason: string): Decision {
  return {
    allowed: false,
    decisionId: '',
    policyVersion: 0,
    requiresStepUp: false,
    requiredAal: null,
    matched: [],
    explanation: [reason],
  };
}

function reject(
  req: MiddlewareRequest,
  res: MiddlewareResponse,
  decision: Decision,
  onDeny?: RequirePermissionOptions['onDeny'],
): void {
  if (onDeny) {
    onDeny(req, res, decision);
    return;
  }
  const r = res.status(403);
  const body = {
    error: decision.requiresStepUp ? 'step_up_required' : 'forbidden',
    required_aal: decision.requiredAal,
    decision_id: decision.decisionId,
  };
  if (typeof r.json === 'function') r.json(body);
  else if (typeof r.send === 'function') r.send(body);
}
