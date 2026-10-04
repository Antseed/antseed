import type {Plugin} from '@docusaurus/types';

/**
 * Registers the client-side route /invite/:invite for referral invite links
 * (https://antseed.com/invite/<invite>). Invites are unbounded, so there is
 * no static file per invite: the host answers these URLs with 404.html and
 * the client router renders src/invite/InvitePage.tsx, which decodes the
 * invite in the browser.
 */
export default function inviteRoutePlugin(): Plugin {
  return {
    name: 'invite-route',
    async contentLoaded({actions}) {
      actions.addRoute({
        path: '/invite/:invite',
        component: '@site/src/invite/InvitePage.tsx',
        exact: true,
      });
    },
  };
}
