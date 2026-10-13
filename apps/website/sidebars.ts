import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Getting Started',
      className: 'sidebar-icon sidebar-icon--start',
      collapsible: true,
      collapsed: false,
      items: [
        'getting-started/intro',
        'getting-started/install',
        'getting-started/configuration',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      className: 'sidebar-icon sidebar-icon--guides',
      collapsible: true,
      collapsed: true,
      items: [
        'guides/vpr',
        'guides/using-the-api',
        'guides/agents',
        'guides/public-tunnels',
        'guides/gateway-api-keys',
        'guides/gateway-server',
        'guides/gateway-console',
        'guides/become-a-provider',
        'guides/tee-provider',
        'guides/verify-tee',
        'guides/payments',
        'guides/staking',
        'guides/pricing',
        'guides/metrics',
        'guides/metadata-v12-upgrade',
      ],
    },
    {
      type: 'category',
      label: 'Protocol',
      className: 'sidebar-icon sidebar-icon--protocol',
      collapsible: true,
      collapsed: true,
      items: [
        'protocol/overview',
        'protocol/discovery',
        'protocol/transport',
        'protocol/metering',
        'protocol/payments',
        'protocol/recognized-usage',
        'protocol/reward-policies',
        'protocol/legacy-emissions',
        'protocol/reputation',
        'protocol/security',
      ],
    },
    {
      type: 'category',
      label: 'Plugins',
      className: 'sidebar-icon sidebar-icon--plugins',
      collapsible: true,
      collapsed: true,
      items: [
        'plugins/provider-plugin',
        'plugins/router-plugin',
        'plugins/creating-plugins',
      ],
    },
    {
      type: 'category',
      label: 'CLI Reference',
      className: 'sidebar-icon sidebar-icon--cli',
      collapsible: true,
      collapsed: true,
      items: [
        'cli/commands',
        'cli/flags',
      ],
    },
    {
      type: 'category',
      label: 'Papers',
      className: 'sidebar-icon sidebar-icon--papers',
      collapsible: true,
      collapsed: true,
      items: [
        'lightpaper',
      ],
    },
  ],
};

export default sidebars;
