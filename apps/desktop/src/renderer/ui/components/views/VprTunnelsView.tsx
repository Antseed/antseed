import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, ArrowUpRight01Icon, GlobalIcon } from '@hugeicons/core-free-icons';
import { usePublicEndpointModal } from '../tunnels/PublicEndpointModal';
import { BrandIcon } from '../brand/BrandIcon';
import { VprPage } from '../vpr/VprKit';
import styles from './VprToolsView.module.scss';
import tunnelStyles from './VprTunnelsView.module.scss';

const OPENCLAW_ICON = new URL('../../../assets/openclaw.svg', import.meta.url).href;

const AGENTS = [
  {
    name: 'Hermes Agent',
    brand: 'hermes',
    description: 'Connect Hermes to the AI VPN with the OpenAI-compatible endpoint.',
    integrationUrl: 'https://antseed.com/integrations/hermes/',
    skillUrl: 'https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed',
  },
  {
    name: 'OpenClaw',
    icon: OPENCLAW_ICON,
    description: 'Register Antseed as an Anthropic Messages provider for OpenClaw.',
    integrationUrl: 'https://antseed.com/integrations/openclaw/',
    skillUrl: 'https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed',
  },
] as const;

export function VprTunnelsView() {
  const { status, openPublicEndpointModal } = usePublicEndpointModal();

  return (
    <section className={`view view-vpr-tunnels view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Agents" backFallback="home">
        <div className={styles.stack}>
          <section className={tunnelStyles.intro}>
            <h2 className={tunnelStyles.introTitle}>Connect an agent to your AI VPN</h2>
            <p className={tunnelStyles.introText}>Agents on this computer can use <code>http://127.0.0.1:8377/v1</code>. Remote agents use your protected internet-accessible endpoint.</p>
          </section>

          <button type="button" className={tunnelStyles.endpointLauncher} onClick={openPublicEndpointModal}>
            <span className={tunnelStyles.endpointLauncherIcon}><HugeiconsIcon icon={GlobalIcon} size={17} strokeWidth={1.8} /></span>
            <span className={tunnelStyles.endpointLauncherText}>
              <span className={tunnelStyles.endpointLauncherTitle}>Internet-accessible endpoint</span>
              <span className={tunnelStyles.endpointLauncherHint}>
                {status?.running
                  ? `${status.activeProvider === 'ngrok' ? 'ngrok' : 'Cloudflare'} is running for remote agents`
                  : 'Configure a protected public URL for remote agents'}
              </span>
            </span>
            {status?.running ? <span className={tunnelStyles.endpointLauncherDot} aria-label="Running" /> : null}
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={tunnelStyles.endpointLauncherArrow} />
          </button>

          <div className={tunnelStyles.agentList}>
            {AGENTS.map((agent) => (
              <section key={agent.name} className={tunnelStyles.agentCard}>
                {'brand' in agent
                  ? <BrandIcon brand={agent.brand} size={30} className={tunnelStyles.agentIcon} />
                  : <img className={tunnelStyles.agentIcon} src={agent.icon} alt="" />}
                <div className={tunnelStyles.agentContent}>
                  <h2 className={tunnelStyles.agentName}>{agent.name}</h2>
                  <p className={tunnelStyles.agentDescription}>{agent.description}</p>
                  <span className={tunnelStyles.agentLinks}>
                    <button type="button" className={tunnelStyles.docsLink} onClick={() => void window.antseedDesktop?.openExternalUrl?.(agent.integrationUrl)}>
                      Setup guide <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                    </button>
                    <button type="button" className={tunnelStyles.docsLink} onClick={() => void window.antseedDesktop?.openExternalUrl?.(agent.skillUrl)}>
                      Agent skill <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                    </button>
                  </span>
                </div>
              </section>
            ))}
          </div>

        </div>
      </VprPage>
    </section>
  );
}
