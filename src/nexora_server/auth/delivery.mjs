// Magic-link delivery.
//
//   AUTH_DELIVERY_MODE=console  prints the one-time link to the backend
//                               terminal (dev only, never in production).
//   AUTH_DELIVERY_MODE=resend   sends via the Resend HTTP API — requires
//                               RESEND_API_KEY and EMAIL_FROM. NOTE: Resend
//                               test mode delivers ONLY to the Resend
//                               account owner's email address.
//
// Failure policy: a configured 'resend' delivery that fails does NOT fall
// back to console — the caller returns an error so the link is never
// silently undeliverable. Raw tokens / verify URLs are never logged.

export function deliveryMode() {
  return (process.env.AUTH_DELIVERY_MODE || '').toLowerCase();
}

// Returns true when console delivery is allowed in this environment.
export function consoleDeliveryAllowed() {
  return deliveryMode() === 'console' && process.env.NODE_ENV !== 'production';
}

function consoleDeliver({ email, verifyUrl, ttlMinutes }) {
  console.log([
    '',
    '=================================================',
    'NEXORAXR — DEVELOPMENT LOGIN',
    '=================================================',
    '',
    `Email: ${email}`,
    '',
    'Confirmation link:',
    verifyUrl,
    '',
    `Expires in: ${ttlMinutes} minutes`,
    'Single use: Yes',
    '',
    '=================================================',
    '',
  ].join('\n'));
  return { ok: true, mode: 'console' };
}

// Resend HTTP API — https://resend.com/docs/api-reference/emails/send-email
// Uses global fetch (Node >=18); no SDK dependency. Secrets stay server-side;
// only the recipient and HTTP status ever reach the logs.
async function resendDeliver({ email, verifyUrl, ttlMinutes }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    return { ok: false, error: 'resend_not_configured',
      message: 'AUTH_DELIVERY_MODE=resend requires RESEND_API_KEY and EMAIL_FROM' };
  }
  const subject = 'Your WuFlux sign-in link';
  const html = `
    <div style="font-family:system-ui,sans-serif;background:#0b0f1a;color:#e5e7eb;padding:32px">
      <div style="max-width:440px;margin:0 auto;background:#141a2e;border:1px solid #2a3352;border-radius:12px;padding:28px">
        <h1 style="font-size:18px;margin:0 0 12px">Sign in to WuFlux</h1>
        <p style="font-size:14px;color:#94a3b8;line-height:1.5">
          Confirm your sign-in by clicking the button below. The link is
          single-use and expires in ${ttlMinutes} minutes.
        </p>
        <p style="text-align:center;margin:24px 0">
          <a href="${verifyUrl}"
             style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;
                    padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600">
            Confirm sign in
          </a>
        </p>
        <p style="font-size:12px;color:#64748b;line-height:1.5">
          If you didn't request this link you can ignore this email.
        </p>
      </div>
    </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [email], subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      // Log the status + Resend's error class only — never the payload/token.
      console.warn(`[auth] resend delivery to ${email} failed: HTTP ${r.status} ${body.slice(0, 200)}`);
      return { ok: false, error: 'resend_send_failed', status: r.status };
    }
    console.log(`[auth] magic link emailed to ${email} via resend`);
    return { ok: true, mode: 'resend' };
  } catch (err) {
    console.warn(`[auth] resend delivery to ${email} failed: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
    return { ok: false, error: 'resend_request_failed' };
  }
}

// Delivers the link via the configured mode.
//   { ok: true }               — delivered (console print or Resend email)
//   { ok: false, error }       — configured delivery failed; callers must
//                                surface an error, not pretend it worked
//   { ok: false, unconfigured }— no mode set / console disallowed; callers
//                                keep the generic response (dev behaviour)
export async function deliverMagicLink({ email, verifyUrl, ttlMinutes = 10 }) {
  const mode = deliveryMode();
  if (mode === 'resend') return resendDeliver({ email, verifyUrl, ttlMinutes });
  if (consoleDeliveryAllowed()) return consoleDeliver({ email, verifyUrl, ttlMinutes });
  return { ok: false, unconfigured: true };
}
