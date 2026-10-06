import {ArrowRight, Button} from './ui';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {useMobileGetStarted} from '../lib/useMobileGetStarted';

/* The desktop download CTA shared by the audience pages. The label swaps
   between desktop and mobile copy via the .vprLabel* classes in custom.css. */
export function DownloadButton({
  variant,
  size = 'lg',
  className,
}: {
  variant?: 'dark' | 'white';
  size?: 'md' | 'lg';
  className?: string;
}) {
  const download = useLatestDesktopDownload();
  const onGetStarted = useMobileGetStarted();
  const buttonClass = className ? `vprBtn ${className}` : 'vprBtn';
  return (
    <Button href={download.href} size={size} variant={variant} className={buttonClass} onClick={onGetStarted}>
      <span className="vprLabelDesktop">Download the AI VPN</span>
      <span className="vprLabelMobile">Get the AI VPN<ArrowRight /></span>
    </Button>
  );
}
