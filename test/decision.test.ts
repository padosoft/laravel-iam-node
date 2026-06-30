import { describe, it, expect } from 'vitest';
import { deny, isGranted, decisionFromBody } from '../src/index.js';

describe('decision normalisation', () => {
  it('deny() builds an explicit fail-closed decision', () => {
    const d = deny('boom');
    expect(d.allowed).toBe(false);
    expect(d.requiresStepUp).toBe(false);
    expect(d.explanation).toEqual(['boom']);
  });

  it('degrades safely on missing/wrong-typed fields', () => {
    const d = decisionFromBody({ allowed: 'yes', decision_id: 5, policy_version: '3', matched: 'x' });
    expect(d.allowed).toBe(false); // only strict `true` allows
    expect(d.decisionId).toBe('');
    expect(d.policyVersion).toBe(0);
    expect(d.matched).toEqual([]);
  });

  it('denies on a non-object body', () => {
    expect(decisionFromBody('nope').allowed).toBe(false);
    expect(decisionFromBody(null).allowed).toBe(false);
  });

  it('unwraps a single { data } envelope', () => {
    const d = decisionFromBody({ data: { allowed: true, decision_id: 'dec_x' } });
    expect(d.allowed).toBe(true);
    expect(d.decisionId).toBe('dec_x');
  });

  it('isGranted is false whenever a step-up is pending', () => {
    expect(isGranted({ ...deny('x'), allowed: true })).toBe(true);
    expect(isGranted({ ...deny('x'), allowed: true, requiresStepUp: true })).toBe(false);
  });
});
