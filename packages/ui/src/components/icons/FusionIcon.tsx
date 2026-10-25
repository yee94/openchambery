import type { SVGProps } from 'react';

import { ICON_STROKE_WIDTH } from '@/components/icon/Icon';

export function FusionIcon(props: SVGProps<SVGSVGElement>) {
  const { className, ...rest } = props;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={['yuri-icon', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <path d="M12 4.5v6.25M12 10.75v3.5M12 10.75H7.25A3.25 3.25 0 0 0 4 14v1.25M12 10.75h4.75A3.25 3.25 0 0 1 20 14v1.25" />
      <path d="M9.25 7.25 12 4.5l2.75 2.75" />
      <circle cx="4" cy="17.25" r="1.55" />
      <circle cx="12" cy="17.25" r="1.55" />
      <circle cx="20" cy="17.25" r="1.55" />
    </svg>
  );
}
