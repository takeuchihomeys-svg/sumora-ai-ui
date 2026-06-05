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
        fill={hasCount ? "#06C755" : "none"}
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

const IconBuilding = ({ active }: { active?: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.5 : 1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <path d="M9 3v18"/>
    <path d="M3 9h6"/>
    <path d="M3 15h6"/>
    <path d="M12 9h6v12h-6z" fill={active ? "currentColor" : "none"} strokeWidth={active ? 2 : 1.8}/>
    <line x1="15" y1="12" x2="15" y2="15"/>
  </svg>
);

const IconPeople = ({ active }: { active?: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.5 : 1.8} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="7" r="4"/>
    <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    <path d="M21 21v-2a4 4 0 0 0-3-3.87"/>
  </svg>
);

const IconReceipt = ({ active }: { active?: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.5 : 1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="9" y1="13" x2="15" y2="13"/>
    <line x1="9" y1="17" x2="15" y2="17"/>
    <line x1="9" y1="9" x2="11" y2="9"/>
  </svg>
);

type Props = {
  unreadCount?: number;
  hidden?: boolean;
};

export default function BottomNav({ unreadCount = 0, hidden = false }: Props) {
  const pathname = usePathname();
  const activeColor = "#06C755";
  const inactiveColor = "#aaaaaa";

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex items-end transition-transform duration-300"
      style={{
        background: "#f7f8fa",
        borderTop: "1px solid #dde1e5",
        paddingTop: 6,
        paddingBottom: "max(env(safe-area-inset-bottom), 6px)",
        transform: hidden ? "translateY(100%)" : "translateY(0)",
      }}
    >
      {/* メッセージ */}
      <Link href="/" className="flex flex-1 items-center justify-center">
        <span
          className="flex items-center justify-center rounded-full transition-all duration-200"
          style={{
            width: 48,
            height: 28,
            background: unreadCount > 0 ? "#e6f9ee" : pathname === "/" ? "#e6f9ee" : "transparent",
            color: unreadCount > 0 || pathname === "/" ? activeColor : inactiveColor,
          }}
        >
          <IconChatWithCount active={pathname === "/" || unreadCount > 0} count={unreadCount} />
        </span>
      </Link>

      {/* 物件条件 */}
      <Link href="/conditions" className="flex flex-1 items-center justify-center">
        <span
          className="flex items-center justify-center rounded-full transition-all duration-200"
          style={{
            width: 48,
            height: 28,
            background: pathname === "/conditions" ? "#e6f9ee" : "transparent",
            color: pathname === "/conditions" ? activeColor : inactiveColor,
          }}
        >
          <IconBuilding active={pathname === "/conditions"} />
        </span>
      </Link>

      {/* お客さん管理 */}
      <Link href="/customers" className="flex flex-1 items-center justify-center">
        <span
          className="flex items-center justify-center rounded-full transition-all duration-200"
          style={{
            width: 48,
            height: 28,
            background: pathname === "/customers" ? "#e6f9ee" : "transparent",
            color: pathname === "/customers" ? activeColor : inactiveColor,
          }}
        >
          <IconPeople active={pathname === "/customers"} />
        </span>
      </Link>

      {/* カレンダー */}
      <Link href="/calendar" className="flex flex-1 items-center justify-center">
        <span
          className="flex items-center justify-center rounded-full transition-all duration-200"
          style={{
            width: 48,
            height: 28,
            background: pathname === "/calendar" ? "#e6f9ee" : "transparent",
            color: pathname === "/calendar" ? activeColor : inactiveColor,
          }}
        >
          <IconCalendar active={pathname === "/calendar"} />
        </span>
      </Link>

      {/* 見積書 */}
      <Link href="/estimate" className="flex flex-1 items-center justify-center">
        <span
          className="flex items-center justify-center rounded-full transition-all duration-200"
          style={{
            width: 48,
            height: 28,
            background: pathname === "/estimate" ? "#e6f9ee" : "transparent",
            color: pathname === "/estimate" ? activeColor : inactiveColor,
          }}
        >
          <IconReceipt active={pathname === "/estimate"} />
        </span>
      </Link>
    </nav>
  );
}
