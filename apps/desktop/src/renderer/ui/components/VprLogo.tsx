type VprLogoProps = {
  height?: number;
  className?: string;
};

const WORDMARK_WIDTH = 40.55863;
const HORIZONTAL_LOGO_WIDTH = WORDMARK_WIDTH + 32;
const STACKED_LOGO_WIDTH = WORDMARK_WIDTH + 2;

function AntIconPaths({ color = '#1FD87A' }: { color?: string }) {
  return (
    <>
      <path d="M14 9.62502C14.9665 9.62502 15.75 8.76317 15.75 7.70002C15.75 6.63688 14.9665 5.77502 14 5.77502C13.0335 5.77502 12.25 6.63688 12.25 7.70002C12.25 8.76317 13.0335 9.62502 14 9.62502Z" fill={color}/>
      <path d="M13.9998 15.4C15.3529 15.4 16.4498 14.1464 16.4498 12.6C16.4498 11.0537 15.3529 9.80005 13.9998 9.80005C12.6467 9.80005 11.5498 11.0537 11.5498 12.6C11.5498 14.1464 12.6467 15.4 13.9998 15.4Z" fill={color}/>
      <path d="M14.0001 23.45C15.7398 23.45 17.1501 21.5696 17.1501 19.25C17.1501 16.9305 15.7398 15.05 14.0001 15.05C12.2604 15.05 10.8501 16.9305 10.8501 19.25C10.8501 21.5696 12.2604 23.45 14.0001 23.45Z" fill={color}/>
      <path opacity="0.7" d="M12.9498 5.94998L9.7998 2.09998" stroke={color} strokeWidth="0.6" strokeLinecap="round"/>
      <path opacity="0.7" d="M15.0498 5.94998L18.1998 2.09998" stroke={color} strokeWidth="0.6" strokeLinecap="round"/>
      <path d="M9.7998 2.97498C10.283 2.97498 10.6748 2.58322 10.6748 2.09998C10.6748 1.61673 10.283 1.22498 9.7998 1.22498C9.31655 1.22498 8.9248 1.61673 8.9248 2.09998C8.9248 2.58322 9.31655 2.97498 9.7998 2.97498Z" fill={color}/>
      <path d="M18.2002 2.97498C18.6835 2.97498 19.0752 2.58322 19.0752 2.09998C19.0752 1.61673 18.6835 1.22498 18.2002 1.22498C17.717 1.22498 17.3252 1.61673 17.3252 2.09998C17.3252 2.58322 17.717 2.97498 18.2002 2.97498Z" fill={color}/>
      <path opacity="0.5" d="M12.25 11.2001L6.125 7.70007" stroke={color} strokeWidth="0.52" strokeLinecap="round"/>
      <path opacity="0.5" d="M15.75 11.2001L21.875 7.70007" stroke={color} strokeWidth="0.52" strokeLinecap="round"/>
      <path d="M6.2998 8.57495C6.78305 8.57495 7.1748 8.1832 7.1748 7.69995C7.1748 7.2167 6.78305 6.82495 6.2998 6.82495C5.81655 6.82495 5.4248 7.2167 5.4248 7.69995C5.4248 8.1832 5.81655 8.57495 6.2998 8.57495Z" fill={color}/>
      <path d="M21.7002 8.57495C22.1835 8.57495 22.5752 8.1832 22.5752 7.69995C22.5752 7.2167 22.1835 6.82495 21.7002 6.82495C21.217 6.82495 20.8252 7.2167 20.8252 7.69995C20.8252 8.1832 21.217 8.57495 21.7002 8.57495Z" fill={color}/>
      <path opacity="0.5" d="M11.5499 13.3L4.8999 14" stroke={color} strokeWidth="0.52" strokeLinecap="round"/>
      <path opacity="0.5" d="M16.4502 13.3L23.1002 14" stroke={color} strokeWidth="0.52" strokeLinecap="round"/>
      <path d="M4.8999 14.875C5.38315 14.875 5.7749 14.4832 5.7749 14C5.7749 13.5168 5.38315 13.125 4.8999 13.125C4.41666 13.125 4.0249 13.5168 4.0249 14C4.0249 14.4832 4.41666 14.875 4.8999 14.875Z" fill={color}/>
      <path d="M23.1001 14.875C23.5833 14.875 23.9751 14.4832 23.9751 14C23.9751 13.5168 23.5833 13.125 23.1001 13.125C22.6168 13.125 22.2251 13.5168 22.2251 14C22.2251 14.4832 22.6168 14.875 23.1001 14.875Z" fill={color}/>
      <path opacity="0.5" d="M11.9001 18.2L5.6001 21" stroke={color} strokeWidth="0.52" strokeLinecap="round"/>
      <path opacity="0.5" d="M16.1001 18.2L22.4001 21" stroke={color} strokeWidth="0.52" strokeLinecap="round"/>
      <path d="M5.6001 21.875C6.08334 21.875 6.4751 21.4832 6.4751 21C6.4751 20.5168 6.08334 20.125 5.6001 20.125C5.11685 20.125 4.7251 20.5168 4.7251 21C4.7251 21.4832 5.11685 21.875 5.6001 21.875Z" fill={color}/>
      <path d="M22.3999 21.875C22.8832 21.875 23.2749 21.4832 23.2749 21C23.2749 20.5168 22.8832 20.125 22.3999 20.125C21.9167 20.125 21.5249 20.5168 21.5249 21C21.5249 21.4832 21.9167 21.875 22.3999 21.875Z" fill={color}/>
      <path opacity="0.15" d="M6.2999 7.69995L4.8999 14" stroke={color} strokeWidth="0.52" strokeLinecap="round"/>
      <path opacity="0.15" d="M21.7002 7.69995L23.1002 14" stroke={color} strokeWidth="0.52" strokeLinecap="round"/>
      <path opacity="0.15" d="M4.8999 14L5.5999 21" stroke={color} strokeWidth="0.52" strokeLinecap="round"/>
      <path opacity="0.15" d="M23.0999 14L22.3999 21" stroke={color} strokeWidth="0.52" strokeLinecap="round"/>
    </>
  );
}

function VprWordmark() {
  return (
    <>
      <path d="M2.87394 10.7628L0 0.237196H1.77376L3.88431 8.29054L5.99487 0.237196H7.76863L4.89468 10.7628H2.87394Z" transform="translate(7.76863 11) rotate(180)" fill="currentColor" fillRule="evenodd"/>
      <path d="M2.1 6.92712H5.66863V8.63712H2.1Z" fill="currentColor" fillRule="evenodd"/>
      <path d="M9.33 0.237196H11.04V10.7628H9.33Z" fill="currentColor" fillRule="evenodd"/>
      <path d="M2.87394 10.7628L0 0.237196H1.77376L3.88431 8.29054L5.99487 0.237196H7.76863L4.89468 10.7628H2.87394Z" transform="translate(14.44 0)" fill="currentColor" fillRule="evenodd"/>
      <path d="M0 10.7628V0.237196H3.9C5.05667 0.237196 5.94667 0.647196 6.57 1.46716C7.19333 2.28712 7.505 3.30712 7.505 4.52716C7.505 5.74712 7.19333 6.76712 6.57 7.58708C5.94667 8.40712 5.05667 8.81712 3.9 8.81712H1.71V10.7628H0ZM1.71 6.92712H3.755C4.28833 6.92712 4.69333 6.71962 4.97 6.30462C5.24667 5.88962 5.385 5.29712 5.385 4.52716C5.385 3.75712 5.24667 3.16462 4.97 2.74962C4.69333 2.33462 4.28833 2.12712 3.755 2.12712H1.71V6.92712Z" transform="translate(23.77 0)" fill="currentColor" fillRule="evenodd"/>
      <path d="M0 10.7628V0.237196H1.71L6.05863 7.5096V0.237196H7.76863V10.7628H6.05863L1.71 3.4904V10.7628Z" transform="translate(32.79 0)" fill="currentColor" fillRule="evenodd"/>
    </>
  );
}

/** Just the ant mark, no wordmark — square icon contexts (the floating pill
 * badge). The viewBox is shifted so the mark sits optically centered. */
export function VprMark({ size = 28, className, color }: { size?: number; className?: string; color?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 -1.5 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <AntIconPaths color={color} />
    </svg>
  );
}

export function VprLogo({ height = 28, className }: VprLogoProps) {
  const width = Math.round(height * (HORIZONTAL_LOGO_WIDTH / 28));

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${HORIZONTAL_LOGO_WIDTH} 28`}
      role="img"
      aria-label="AI VPN"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <AntIconPaths />
      <g transform="translate(30, 8.5)">
        <VprWordmark />
      </g>
    </svg>
  );
}

export function VprStackedLogo({ height = 56, className }: VprLogoProps) {
  const width = Math.round(height * (STACKED_LOGO_WIDTH / 44));

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${STACKED_LOGO_WIDTH} 44`}
      role="img"
      aria-label="AI VPN"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={`translate(${(STACKED_LOGO_WIDTH - 28) / 2}, 0)`}>
        <AntIconPaths />
      </g>
      <g transform="translate(1, 32.5)">
        <VprWordmark />
      </g>
    </svg>
  );
}
