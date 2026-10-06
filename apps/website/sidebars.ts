import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Getting Started',
      collapsible: false,
      items: [
        'getting-started/intro',
        'getting-started/install',
        'getting-started/configuration',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      collapsible: false,
      items: [
        'guides/vpr',
        'guides/using-the-api',
        'guides/agents',
        'guides/public-tunnels',
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
      collapsible: false,
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
      collapsible: false,
      items: [
        'plugins/provider-plugin',
        'plugins/router-plugin',
        'plugins/creating-plugins',
      ],
    },
    {
      type: 'category',
      label: 'CLI Reference',
      collapsible: false,
      items: [
        'cli/commands',
        'cli/flags',
      ],
    },
    {
      type: 'category',
      label: 'Papers',
      collapsible: false,
      items: [
        'lightpaper',
      ],
    },
  ],
};

export default sidebars;
