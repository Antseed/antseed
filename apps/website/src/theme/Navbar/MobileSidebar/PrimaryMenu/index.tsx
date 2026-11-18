import type {JSX} from 'react';
import {useNavbarMobileSidebar} from '@docusaurus/theme-common/internal';
import NavLink from '../../NavLink';
import {MENU_TAIL, NETWORK, PROVIDERS} from '../../links';

const ITEMS = [NETWORK, ...PROVIDERS, ...MENU_TAIL];

/** The mobile sidebar's main menu (behind "Back to main menu"): the phone menu's links in Docusaurus' menu markup. */
export default function NavbarMobilePrimaryMenu(): JSX.Element {
  const {toggle} = useNavbarMobileSidebar();
  return (
    <ul className="menu__list">
      {ITEMS.map((item) => (
        <li key={item.href} className="menu__list-item">
          <NavLink item={item} className="menu__link" onClick={toggle} arrow />
        </li>
      ))}
    </ul>
  );
}
