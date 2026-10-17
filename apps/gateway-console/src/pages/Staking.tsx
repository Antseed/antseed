import { NAV_GROUPS, PAGE_AREAS, PAGES } from '@antseed/ants-web/embed'
import { PageHeader, PageLink, TabPanel, Tabs } from '../components/ui'
import { navigate, useLocation } from '../lib/router'
import { StakingDashboard } from '../staking/StakingDashboard'

const LABELS = new Map<string, string>(NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.label] as [string, string])))
const TABS = PAGES.filter((page) => PAGE_AREAS[page] === 'staking').map((page) => ({ id: page, label: LABELS.get(page) ?? page }))
const PAGE_IDS = TABS.map((tab) => tab.id)
const TABS_ID = 'gc-staking'

/**
 * The staking dashboard's staking pages, as tabs. Its rewards join the
 * console's Rewards page; running a seller and the protocol pages stay in the
 * standalone dashboard.
 */
export default function Staking() {
  const location = useLocation()
  const open = TABS.find((tab) => tab.id === location.rest[0])?.id ?? TABS[0]!.id
  return (
    <div className="gc-page">
      <PageHeader title="Staking" description={<>Stake ANTS into seller pools and manage your positions, signed with your wallet. Staking rewards are on <PageLink to="rewards">Rewards</PageLink>.</>} />
      <Tabs id={TABS_ID} label="Staking" value={open} onChange={(page) => navigate(`staking/${page}`)} tabs={TABS} />
      <TabPanel tabsId={TABS_ID} tab={open}>
        <StakingDashboard pages={PAGE_IDS} buyerRewards />
      </TabPanel>
    </div>
  )
}
