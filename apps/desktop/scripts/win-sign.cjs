// electron-builder custom Windows sign hook (win.sign). The code-signing
// private key lives in the CA's cloud HSM (mandatory under current CA/B
// rules — there is no local .pfx); the CA's signing service is a plain
// HTTPS API with TOTP login, so signing needs no desktop app, no
// smart-card stack, and no persistent session — each release run
// authenticates itself from the TOTP seed.
//
// The protocol work (login, certificate fetch, Authenticode PKCS#7
// assembly, RFC3161 timestamp) is done by the `ssign` CLI, which the
// release workflow builds from a pinned, security-reviewed revision.
//
// Required env (set as GitHub secrets in the release workflow):
//   WIN_SIGN_EMAIL  signing service account e-mail
//   WIN_SIGN_OTP    TOTP seed (base32 or full otpauth:// URI). Long-lived
//                   signing credential — keep it in a protected environment.
//   SSIGN_PATH      optional path to the ssign binary (defaults to
//                   `ssign` on PATH)
//
// When WIN_SIGN_EMAIL / WIN_SIGN_OTP are absent the hook is a no-op, so
// unsigned local/dev builds keep working exactly as before.
//
// electron-builder calls this hook once per produced binary, and each
// ssign invocation performs a fresh TOTP login. TOTP codes are single-use
// on the service side, so two invocations inside the same 30-second TOTP
// window would submit the same code and the second login would be
// rejected. The hook therefore stalls until a new window opens whenever
// the previous invocation consumed the current one.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOTP_PERIOD_S = 30;
const windowStateFile = path.join(os.tmpdir(), 'win-sign-totp-window');

let warnedSkip = false;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reserveFreshTotpWindow() {
  let last = NaN;
  try {
    last = Number(fs.readFileSync(windowStateFile, 'utf8'));
  } catch {
    /* first invocation */
  }
  const now = Date.now() / 1000;
  if (Math.floor(now / TOTP_PERIOD_S) === last) {
    const waitS = TOTP_PERIOD_S - (now % TOTP_PERIOD_S) + 1;
    console.log(
      `  • win-sign: waiting ${Math.ceil(waitS)}s for a fresh TOTP window`
    );
    sleepMs(waitS * 1000);
  }
  fs.writeFileSync(
    windowStateFile,
    String(Math.floor(Date.now() / 1000 / TOTP_PERIOD_S))
  );
}

module.exports = async function sign(configuration) {
  const { WIN_SIGN_EMAIL, WIN_SIGN_OTP } = process.env;

  if (!WIN_SIGN_EMAIL || !WIN_SIGN_OTP) {
    if (!warnedSkip) {
      console.log(
        '  • WIN_SIGN_EMAIL / WIN_SIGN_OTP not set — skipping Windows code signing'
      );
      warnedSkip = true;
    }
    return;
  }

  const file = configuration.path;
  reserveFreshTotpWindow();
  console.log(`  • win-sign: signing ${path.basename(file)}`);
  execFileSync(
    process.env.SSIGN_PATH || 'ssign',
    // Default RFC3161 TSA (http:// — the TSA serves no TLS; timestamp
    // integrity comes from its own signature, per usual for RFC3161).
    ['-n', 'Antseed Desktop', '-u', 'https://antseed.com', file],
    // Secrets flow via env vars, never argv. Signs in place. ssign reads
    // its account/seed from CERTUM_EMAIL/CERTUM_OTP.
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        CERTUM_EMAIL: WIN_SIGN_EMAIL,
        CERTUM_OTP: WIN_SIGN_OTP,
      },
    }
  );
};
