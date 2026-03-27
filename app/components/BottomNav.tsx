"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 未読数をバブル内に表示するアイコン
const IconChatWithCount = ({ active, count }: { active?: boolean; count: number }) => {
  const hasCount = count > 0;
  const label = count > 99 ? "99+" : String(count);
  const fontSize = label.length >= 3 ? 5 : label.length === 2 ? 6.5 : 7.5;

  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        fill={hasCount ? "#1565C0" : "none"}
        stroke={hasCount ? "none" : "currentColor"}
        strokeWidth={active ? 2.5 : 1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {hasCount && (
        <text
          x="12"
          y="9.5"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fontSize}
          fontWeight="bold"
          fill="white"
        >
          {label}
        </text>
      )}
    </svg>
  );
};

const IconCalendar = ({ active }: { active?: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.5 : 1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/>
    <line x1="8" y1="2" x2="8" y2="6"/>
    <line x1="3" y1="10" x2="21" y2="10"/>
  </svg>
);

type Props = {
  unreadCount?: number;
  hidden?: boolean;
};

export default function BottomNav({ unreadCount = 0, hidden = false }: Props) {
  const pathname = usePathname();
  const activeColor = "#1565C0";
  const inactiveColor = "#90caf9";

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex items-end transition-transform duration-300"
      style={{
        background: "white",
        borderTop: "1px solid #e9edef",
        paddingBottom: "max(env(safe-area-inset-bottom), 8px)",
        transform: hidden ? "translateY(100%)" : "translateY(0)",
      }}
    >
      {/* メッセージ */}
      <Link href="/" className="flex flex-1 items-center justify-center pt-1.5 pb-0">
        <span
          className="flex items-center justify-center rounded-full transition-all duration-200"
          style={{
            width: 52,
            height: 30,
            background: unreadCount > 0 ? "#e3f2fd" : pathname === "/" ? "#dbeafe" : "transparent",
            color: unreadCount > 0 || pathname === "/" ? activeColor : inactiveColor,
          }}
        >
          <IconChatWithCount active={pathname === "/" || unreadCount > 0} count={unreadCount} />
        </span>
      </Link>

      {/* カレンダー */}
      <Link href="/calendar" className="flex flex-1 items-center justify-center pt-1.5 pb-0">
        <span
          className="flex items-center justify-center rounded-full transition-all duration-200"
          style={{
            width: 52,
            height: 30,
            background: pathname === "/calendar" ? "#dbeafe" : "transparent",
            color: pathname === "/calendar" ? activeColor : inactiveColor,
          }}
        >
          <IconCalendar active={pathname === "/calendar"} />
        </span>
      </Link>
    </nav>
  );
}
