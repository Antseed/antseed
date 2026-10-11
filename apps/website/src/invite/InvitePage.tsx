/**
 * /invite/<invite> — landing page for a referral invite link.
 *
 * Registered as the param route `/invite/:invite` by plugins/invite-route.ts.
 * The static build has no file per invite, so the host serves 404.html for
 * these URLs and the client router renders this page; everything here is
 * decoded client-side (see src/lib/invite.ts) and nothing is sent anywhere.
 */
import {useEffect, useState} from 'react';
import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';
import {useLocation} from '@docusaurus/router';
import {Button, PageHero} from '../components/ui';
import {DownloadButton} from '../components/DownloadButton';
import {CommandChip} from '../components/CommandChip';
import {decodeInvite, inviteExpiry, recoverInviter, shortAddress, type Invite} from '../lib/invite';

type Decoded = {raw: string; invite: Invite | null; referrer: string | null};

function inviteFromPath(pathname: string): string {
  const match = /\/invite\/([^/?#]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : '';
}

export default function InvitePage() {
  const {pathname} = useLocation();
  // Decode after mount: the HTML served for these URLs is generic, so the
  // first client render must match it before reading the path.
  const [decoded, setDecoded] = useState<Decoded | null>(null);
  useEffect(() => {
    const raw = inviteFromPath(pathname);
    const invite = decodeInvite(raw);
    setDecoded({raw, invite, referrer: invite ? recoverInviter(invite) : null});
  }, [pathname]);

  const invite = decoded?.invite ?? null;
  const expires = invite ? inviteExpiry(invite) : null;
  const expired = expires ? expires.getTime() <= Date.now() : false;

  return (
    <Layout title="You're invited" description="You're invited to Antseed: 12 weeks of bonus $ANTS.">
      <Head>
        <meta name="robots" content="noindex" />
      </Head>
      <main>
        {decoded && !invite ? (
          <PageHero
            kicker="Invite"
            title="This invite link is not valid."
            lead="Check that you copied the whole link, or ask for a new invite.">
            <DownloadButton variant="dark" />
          </PageHero>
        ) : (
          <PageHero
            kicker="Invite"
            title={<>You&apos;re invited to Antseed: <em>12 weeks of bonus $ANTS</em></>}
            lead={invite && (
              <>
                {decoded?.referrer ? <>Invited by <code>{shortAddress(decoded.referrer)}</code>. </> : null}
                {expired
                  ? 'This invite has expired. Ask for a new one.'
                  : `Use it before ${expires!.toLocaleDateString(undefined, {month: 'long', day: 'numeric', year: 'numeric'})}.`}
              </>
            )}
            note={invite && !expired && (
              <>
                <p>Using the CLI?</p>
                <CommandChip command={`npm i -g @antseed/cli && antseed referral redeem ${decoded!.raw}`} token={decoded!.raw} size="md" />
              </>
            )}>
            <DownloadButton variant="dark" />
            {invite && !expired && (
              <Button variant="ghost" size="lg" href={`antseed://invite/${decoded!.raw}`}>
                Open in Antseed
              </Button>
            )}
          </PageHero>
        )}
      </main>
    </Layout>
  );
}
