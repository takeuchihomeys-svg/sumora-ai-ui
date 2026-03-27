"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const IconChat = ({ active }: { active?: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.5 : 1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);

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
};

export default function BottomNav({ unreadCount = 0 }: Props) {
  const pathname = usePathname();

  const activeColor = "#1565C0";
  const inactiveColor = "#64b5f6";

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-[#90caf9]"
      style={{
        background: "linear-gradient(to bottom, #dbeafe, #e3f2fd)",
        paddingBottom: "max(env(safe-area-inset-bottom), 4px)",
      }}
    >
      {/* メッセージ */}
      <Link href="/" className="flex flex-1 items-center justify-center py-1.5">
        <span className="relative" style={{ color: pathname === "/" ? activeColor : inactiveColor }}>
          <IconChat active={pathname === "/"} />
          {unreadCount > 0 && (
            <span className="absolute -right-2.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white leading-none">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </span>
      </Link>

      {/* カレンダー */}
      <Link href="/calendar" className="flex flex-1 items-center justify-center py-1.5">
        <span style={{ color: pathname === "/calendar" ? activeColor : inactiveColor }}>
          <IconCalendar active={pathname === "/calendar"} />
        </span>
      </Link>
    </nav>
  );
}
