import { describe, expect, it } from 'vitest';
import { verifyWebhook, webhookSignature } from '../src/tools/knowledge.js';
import { startHarness } from './helpers/harness.js';

const SECRET = 'whsec_test_secret';
const TS = '1700000000';
const BODY = '{"event_id":"e1","event_type":"hub.test","occurred_at":"2023-11-14T22:13:20Z","data":{}}';
const SIG = 'sha256=328c408d7dd716cd2554fb6d2a95d9c7fe5240c49c69ee621d58e14a26a2bfc8';

describe('webhook signature helper', () => {
  it('matches the known vector (openssl dgst -sha256 -hmac over "{timestamp}.{body}")', () => {
    expect(webhookSignature(SECRET, TS, BODY)).toBe(SIG);
  });

  it('accepts a good signature inside the window', () => {
    const r = verifyWebhook({ secret: SECRET, timestamp: TS, body: BODY, signature: SIG, nowSeconds: 1700000100 });
    expect(r.valid).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and a wrong signature', () => {
    expect(verifyWebhook({ secret: SECRET, timestamp: TS, body: BODY + ' ', signature: SIG, nowSeconds: 1700000100 }).valid).toBe(false);
    expect(verifyWebhook({ secret: 'other', timestamp: TS, body: BODY, signature: SIG, nowSeconds: 1700000100 }).valid).toBe(false);
    expect(verifyWebhook({ secret: SECRET, timestamp: TS, body: BODY, signature: 'sha256=00', nowSeconds: 1700000100 }).valid).toBe(false);
  });

  it('enforces the 300 second window both ways', () => {
    expect(verifyWebhook({ secret: SECRET, timestamp: TS, body: BODY, signature: SIG, nowSeconds: 1700000300 }).valid).toBe(true);
    expect(verifyWebhook({ secret: SECRET, timestamp: TS, body: BODY, signature: SIG, nowSeconds: 1700000301 }).withinWindow).toBe(false);
    expect(verifyWebhook({ secret: SECRET, timestamp: TS, body: BODY, signature: SIG, nowSeconds: 1699999699 }).withinWindow).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    const r = verifyWebhook({ secret: SECRET, timestamp: 'abc', body: BODY, signature: SIG });
    expect(r.timestampValid).toBe(false);
    expect(r.valid).toBe(false);
  });

  it('works as an MCP tool, computes when no signature is given, and never echoes the secret', async () => {
    const h = await startHarness();
    try {
      const ok = await h.call('hb_verify_webhook_signature', { secret: SECRET, body: BODY, timestamp: TS, signature: SIG, now_epoch_seconds: 1700000100 });
      expect(ok.json.valid).toBe(true);
      const computed = await h.call('hb_verify_webhook_signature', { secret: SECRET, body: BODY, timestamp: TS });
      expect(computed.json.expected_signature).toBe(SIG);
      expect(ok.text + computed.text).not.toContain(SECRET);
      const noSecret = await h.call('hb_verify_webhook_signature', { body: BODY, timestamp: TS });
      expect(noSecret.isError).toBe(true);
    } finally {
      await h.close();
    }
  });
});
