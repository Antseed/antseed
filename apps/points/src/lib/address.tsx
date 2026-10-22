// The address being viewed. Anyone can look up any address; a connected wallet
// is only needed to claim or stake. Source order: ?address= deep link (from the
// AI VPN or console) → last looked-up address → connected wallet.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';
import { isAddress } from './format';

const KEY = 'antseed-points.address';

interface Ctx {
  address: Address | null;
  setAddress: (a: string | null) => void;
}

const AddressContext = createContext<Ctx>({ address: null, setAddress: () => {} });

function readInitial(): Address | null {
  const fromUrl = new URLSearchParams(window.location.search).get('address');
  if (fromUrl && isAddress(fromUrl)) {
    try {
      localStorage.setItem(KEY, fromUrl.toLowerCase());
    } catch {
      /* storage blocked */
    }
    return fromUrl.toLowerCase() as Address;
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && isAddress(saved)) return saved as Address;
  } catch {
    /* storage blocked */
  }
  return null;
}

export function AddressProvider({ children }: { children: ReactNode }) {
  const [address, setState] = useState<Address | null>(readInitial);
  const { address: connected } = useAccount();

  const setAddress = useCallback((a: string | null) => {
    const next = a && isAddress(a) ? (a.trim().toLowerCase() as Address) : null;
    setState(next);
    try {
      if (next) localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch {
      /* storage blocked */
    }
  }, []);

  useEffect(() => {
    if (!address && connected) setState(connected.toLowerCase() as Address);
  }, [address, connected]);

  return <AddressContext.Provider value={{ address, setAddress }}>{children}</AddressContext.Provider>;
}

export const useViewedAddress = () => useContext(AddressContext);
