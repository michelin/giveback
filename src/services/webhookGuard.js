import { createHmac, timingSafeEqual } from "node:crypto";
import Express from "express";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("webhookGuard");

/**
 * What stands in front of Probot on the webhook endpoint
 *
 * The endpoint is the one route any anonymous caller can POST to, and @octokit/webhooks reads
 * the whole body into memory, with no cap, before it checks the signature - and on a mismatch
 * hands that body to every error handler, which logged it. Here the body is capped and the
 * signature checked first, so Probot only ever sees a delivery that came from GitHub. That holds
 * because src/index.js mounts Probot on this route, behind the guard, and nowhere else.
 *
 * Probot still verifies again. That costs one HMAC, and it keeps this module a filter in front
 * of the library rather than a replacement for its check.
 */

export const WEBHOOK_PATH = '/api/github/webhooks';

// Sized for the deliveries this app receives, not for GitHub's 25 MB cap: every anonymous caller
// gets this much buffered before the signature is checked. Only installation events are handled
// (src/app.js), and the few GitHub sends every App regardless are no larger. Their one variable
// part is the `repositories` array, about 350 bytes an entry at worst. With no repository
// permission the array is probably empty, but no source confirms it, so 1 MiB is sized as if it
// listed every repository of a personal account: about 3,000 at worst, 7,600 typical. Above
// that a delivery answers 413 and GitHub does not retry it, and nothing is lost: the OAuth
// callback writes the enrolled row itself, and reconcile_installations repairs a missed suspend,
// unsuspend or delete at its next run (hourly in production).
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;

const secret = process.env.WEBHOOK_SECRET ?? '';

// Read as bytes, never parsed: the signature is over the raw body. inflate off because GitHub
// never compresses a delivery, and a compressed body is the one shape whose decoded size the
// declared length says nothing about.
const readBody = Express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT, inflate: false });

/**
 * Answer a body that will not be read, and drop the connection it arrived on
 *
 * Connection: close, because whatever is left of the body is still on the socket, and closing
 * it is the only way to stop receiving it.
 */
const refuse = (res, status) => {
  res.set('Connection', 'close');
  res.status(status).json({ error: status === 413 ? 'payload too large' : 'unreadable body' });
};

/**
 * Read the body, refusing it past the cap
 *
 * A declared Content-Length above the cap is refused here, on the header alone: body-parser
 * would refuse it too, but only after reading - and discarding - every byte the client chose to
 * send. A chunked body declares nothing, and body-parser stops buffering it the moment it
 * crosses the cap.
 *
 * Answered here rather than passed on: the catch-all would answer the same status, but without
 * Connection: close and with a warn line. Not logged: the request line at debug already records
 * the status, and a flood is exactly when a line per refusal would hurt.
 */
const capBody = (req, res, next) => {
  if (Number(req.get('content-length')) > WEBHOOK_BODY_LIMIT) {
    refuse(res, 413);
    return;
  }

  readBody(req, res, (error) => {
    if (error) {
      // body-parser's errors carry the status to answer with: 413 past the cap, 400 or 415 for
      // a body that cannot be read as bytes.
      refuse(res, error.status ?? 400);
      return;
    }

    next();
  });
};

/** `sha256=<hex>`, the form GitHub sends in X-Hub-Signature-256. */
const signatureOf = (body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * Refuse a delivery whose signature does not match WEBHOOK_SECRET
 *
 * One warn line, with the two headers that identify a delivery on GitHub's side and nothing from
 * the body. A mismatch is either somebody probing the URL or a secret that differs from the one
 * on the app's settings page, and in the second case the delivery id is what finds it there.
 */
const verifySignature = (req, res, next) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const given = Buffer.from(String(req.get('x-hub-signature-256') ?? ''));
  const expected = Buffer.from(signatureOf(body));

  // timingSafeEqual throws on a length mismatch, and a length difference is not a secret.
  if (secret && given.length === expected.length && timingSafeEqual(given, expected)) {
    // The form @octokit/webhooks accepts a body already read in: an object `body` beside a
    // `rawBody` of bytes. Without it, it would wait on a stream that has already ended.
    req.body = body;
    req.rawBody = body;
    next();
    return;
  }

  logger.warn(
    { delivery: req.get('x-github-delivery'), event: req.get('x-github-event') },
    'webhook delivery refused - its signature does not match WEBHOOK_SECRET, answering 400'
  );

  res.status(400).json({ error: 'signature does not match' });
};

/** The middleware to mount on POST WEBHOOK_PATH, ahead of Probot's. */
export const guardWebhooks = [capBody, verifySignature];
