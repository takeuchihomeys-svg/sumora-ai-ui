"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import TemplateModal from "./TemplateModal";

const ACCOUNTS = [
  { id: "sumora", name: "スモラ", icon: "🦄", active: true },
];

// シンプルSVGアイコン群
const IconPerson = ({ active }: { active?: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

const IconChat = ({ active }: { active?: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);

const IconCalendar = ({ active }: { active?: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/>
    <line x1="8" y1="2" x2="8" y2="6"/>
    <line x1="3" y1="10" x2="21" y2="10"/>
  </svg>
);

const IconBook = ({ active }: { active?: boolean }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
  </svg>
);

export default function BottomNav() {
  const pathname = usePathname();
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  const activeColor = "#1565C0";
  const inactiveColor = "#8696a0";

  return (
    <>
      <nav
        className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-[#d1d7db] bg-white"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 4px)" }}
      >
        {/* アカウント */}
        <button
          onClick={() => setShowAccountModal(true)}
          className="flex flex-1 items-center justify-center py-3"
        >
          <span style={{ color: inactiveColor }}>
            <IconPerson />
          </span>
        </button>

        {/* メッセージ */}
        <Link href="/" className="flex flex-1 items-center justify-center py-3">
          <span style={{ color: pathname === "/" ? activeColor : inactiveColor }}>
            <IconChat active={pathname === "/"} />
          </span>
        </Link>

        {/* カレンダー */}
        <Link href="/calendar" className="flex flex-1 items-center justify-center py-3">
          <span style={{ color: pathname === "/calendar" ? activeColor : inactiveColor }}>
            <IconCalendar active={pathname === "/calendar"} />
          </span>
        </Link>

        {/* テンプレート */}
        <button
          onClick={() => setShowTemplates(true)}
          className="flex flex-1 items-center justify-center py-3"
        >
          <span style={{ color: inactiveColor }}>
            <IconBook />
          </span>
        </button>
      </nav>

      {/* アカウント選択モーダル */}
      {showAccountModal && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowAccountModal(false); }}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl">
            <div
              className="flex items-center justify-between rounded-t-3xl px-5 py-4"
              style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
            >
              <div className="text-[17px] font-bold text-white">アカウント選択</div>
              <button
                onClick={() => setShowAccountModal(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white"
              >
                ✕
              </button>
            </div>

            <div className="p-5">
              <div className="mb-3 text-xs font-semibold text-[#8696a0]">使用中のアカウント</div>
              <div className="flex flex-col gap-2">
                {ACCOUNTS.map((acc) => (
                  <button
                    key={acc.id}
                    className="flex items-center gap-3 rounded-2xl border-2 border-[#2196F3] bg-[#e3f2fd] px-4 py-3 text-left"
                  >
                    <span className="text-2xl">{acc.icon}</span>
                    <div className="flex-1">
                      <div className="text-sm font-bold text-[#1565C0]">{acc.name}</div>
                      <div className="text-xs text-[#2196F3]">現在使用中</div>
                    </div>
                    <span className="text-[#2196F3]">✓</span>
                  </button>
                ))}
              </div>
              <div className="mt-4 rounded-2xl bg-[#f0f2f5] px-4 py-3 text-center text-xs text-[#8696a0]">
                アカウントは順次追加予定です
              </div>
            </div>
          </div>
        </div>
      )}

      {showTemplates && (
        <TemplateModal onClose={() => setShowTemplates(false)} />
      )}
    </>
  );
}
