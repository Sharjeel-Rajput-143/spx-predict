import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconPredict = (p: P) => (
  <svg {...base} {...p}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
);
export const IconTrophy = (p: P) => (
  <svg {...base} {...p}><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4z" /><path d="M17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3" /></svg>
);
export const IconHistory = (p: P) => (
  <svg {...base} {...p}><path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>
);
export const IconUser = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" /></svg>
);
export const IconArrowUp = (p: P) => (
  <svg {...base} strokeWidth={2.5} {...p}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
export const IconArrowDown = (p: P) => (
  <svg {...base} strokeWidth={2.5} {...p}><path d="M12 5v14M19 12l-7 7-7-7" /></svg>
);
export const IconFlame = (p: P) => (
  <svg {...base} {...p}><path d="M12 22c4 0 7-2.7 7-7 0-4-3-6.5-4-9.5-.5 2-1.5 3.3-3 4-1-3-.5-5.5 1-7.5C7.5 4 5 8.5 5 15c0 4.3 3 7 7 7z" /></svg>
);
export const IconTarget = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></svg>
);
export const IconCheck = (p: P) => (
  <svg {...base} strokeWidth={2.5} {...p}><path d="M5 12l5 5L20 7" /></svg>
);
export const IconX = (p: P) => (
  <svg {...base} strokeWidth={2.5} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconSun = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
);
export const IconMoon = (p: P) => (
  <svg {...base} {...p}><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" /></svg>
);
export const IconChevron = (p: P) => (
  <svg {...base} {...p}><path d="M6 9l6 6 6-6" /></svg>
);
export const IconLock = (p: P) => (
  <svg {...base} {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>
);
export const IconCandle = (p: P) => (
  <svg {...base} {...p}>
    <path d="M7 3v4M7 17v4M17 3v6M17 17v4" />
    <rect x="4" y="7" width="6" height="6" rx="1" />
    <rect x="14" y="9" width="6" height="8" rx="1" />
  </svg>
);
export const IconIndicator = (p: P) => (
  <svg {...base} {...p}><path d="M3 17l4-6 4 3 4-8 6 9" /></svg>
);
export const IconExpand = (p: P) => (
  <svg {...base} {...p}><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg>
);
export const IconRefresh = (p: P) => (
  <svg {...base} {...p}><path d="M3 12a9 9 0 0115.4-6.3M21 12a9 9 0 01-15.4 6.3" /><path d="M3 4v5h5M21 20v-5h-5" /></svg>
);
export const IconSearch = (p: P) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
);
export const IconEye = (p: P) => (
  <svg {...base} {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const IconEyeOff = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 3l18 18" />
    <path d="M10.6 5.2A9.4 9.4 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6C4 8.3 2 12 2 12s3.5 7 10 7a9.4 9.4 0 004.4-1.1" />
    <path d="M9.9 9.9a3 3 0 004.2 4.2" />
  </svg>
);
export const IconVolume = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 9v6h4l5 5V4L8 9H4z" />
    <path d="M16 8.5a5 5 0 010 7" />
    <path d="M18.5 6a9 9 0 010 12" />
  </svg>
);
export const IconVolumeOff = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 9v6h4l5 5V4L8 9H4z" />
    <path d="M23 9l-6 6M17 9l6 6" />
  </svg>
);
export const IconAutomation = (p: P) => (
  <svg {...base} {...p}><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" /></svg>
);
/** A candlestick chart: the Bybit tab. */
export const IconBybit = (p: P) => (
  <svg {...base} {...p}>
    <path d="M7 3v3M7 14v4M7 6h0M17 6v3M17 17v4" />
    <rect x="5" y="6" width="4" height="8" rx="1" />
    <rect x="15" y="9" width="4" height="8" rx="1" />
  </svg>
);
export const IconHelp = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9a2.5 2.5 0 014.7 1.2c0 1.6-2.2 1.8-2.2 3.3" />
    <path d="M12 17.5h.01" />
  </svg>
);
export const IconGear = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.6V21a2 2 0 11-4 0v-.2a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.6-1H3a2 2 0 110-4h.2a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.6V3a2 2 0 114 0v.2a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.6 1H21a2 2 0 110 4h-.2a1.7 1.7 0 00-1.4 1z" />
  </svg>
);

export const IconPositions = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M10 16V8h3a2.5 2.5 0 010 5h-3" /></svg>
);
export const IconCalendar = (p: P) => (
  <svg {...base} {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></svg>
);
export const IconSettings = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>
);

export const IconInfo = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);
export const IconEdit = (p: P) => (
  <svg {...base} {...p}><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" /></svg>
);
export const IconChevronDown = (p: P) => (
  <svg {...base} {...p}><path d="M6 9l6 6 6-6" /></svg>
);
export const IconChevronRight = (p: P) => (
  <svg {...base} {...p}><path d="M9 6l6 6-6 6" /></svg>
);
export const IconLink = (p: P) => (
  <svg {...base} {...p}><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /></svg>
);
export const IconPlus = (p: P) => (
  <svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconMore = (p: P) => (
  <svg {...base} {...p}><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></svg>
);
export const IconPanelLeft = (p: P) => (
  <svg {...base} {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
);
export const IconLogout = (p: P) => (
  <svg {...base} {...p}><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
);
export const IconBell = (p: P) => (
  <svg {...base} {...p}><path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8M10.3 21a2 2 0 003.4 0" /></svg>
);

export const IconCopy = (p: P) => (
  <svg {...base} {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" /></svg>
);
export const IconFolder = (p: P) => (
  <svg {...base} {...p}><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
);
export const IconSad = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M9 10h.01M15 10h.01M8.5 16c1-1.3 2.2-2 3.5-2s2.5.7 3.5 2" /></svg>
);
