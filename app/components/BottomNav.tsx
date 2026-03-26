"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "トーク", emoji: "💬" },
  { href: "/calendar", label: "カレンダー", emoji: "📅" },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-[#d1d7db] bg-white/90 backdrop-blur-sm"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {TABS.map((tab) => {
        const isActive = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className="flex flex-1 flex-col items-center justify-center py-2 text-center"
          >
            <span className="mb-0.5 text-[22px] leading-none">{tab.emoji}</span>
            <span
              className="text-[10px] font-semibold"
              style={
                isActive
                  ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }
                  : { color: "#8696a0" }
              }
            >
              {tab.label}
            </span>
            {isActive && (
              <span
                className="mt-1 h-1 w-6 rounded-full"
                style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
