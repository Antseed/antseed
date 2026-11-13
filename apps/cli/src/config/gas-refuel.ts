import {
  DEFAULT_REFUEL_MAX_USDC_PER_DAY_UNITS,
  DEFAULT_REFUEL_SLIPPAGE_BPS,
  DEFAULT_REFUEL_SWAP_USDC_UNITS,
  DEFAULT_REFUEL_TRIGGER_WEI,
  formatEther,
} from '@antseed/node'
import type { SellerGasRefuelCLIConfig } from './types.js'

/** `seller.gasRefuel` with every default filled in, in ETH / USDC numbers as configured. */
export function resolveGasRefuelConfig(cfg: SellerGasRefuelCLIConfig | undefined): Required<SellerGasRefuelCLIConfig> {
  return {
    enabled: cfg?.enabled !== false,
    triggerBalanceEth: cfg?.triggerBalanceEth ?? Number(formatEther(DEFAULT_REFUEL_TRIGGER_WEI)),
    swapUsdc: cfg?.swapUsdc ?? Number(DEFAULT_REFUEL_SWAP_USDC_UNITS) / 1e6,
    maxUsdcPerDay: cfg?.maxUsdcPerDay ?? Number(DEFAULT_REFUEL_MAX_USDC_PER_DAY_UNITS) / 1e6,
    slippageBps: cfg?.slippageBps ?? DEFAULT_REFUEL_SLIPPAGE_BPS,
  }
}
