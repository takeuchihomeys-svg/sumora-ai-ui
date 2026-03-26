"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const TABS = [
  { href: "/", label: "スモラ", emoji: "💬" },
  { href: "/calendar", label: "カレンダー", emoji: "📅" },
];

// アカウント一覧（後々追加）
const ACCOUNTS = [
  { id: "sumora", name: "スモラ", icon: "🦄", active: true },
];

export default function BottomNav() {
  const pathname = usePathname();
  const [showAccountModal, setShowAccountModal] = useState(false);

  return (
    <>
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

        {/* アカウント選択ボタン */}
        <button
          onClick={() => setShowAccountModal(true)}
          className="flex flex-1 flex-col items-center justify-center py-2 text-center"
        >
          <span className="mb-0.5 text-[22px] leading-none">👤</span>
          <span className="text-[10px] font-semibold text-[#8696a0]">アカウント</span>
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
              <div className="text-[17px] font-bold text-white">👤 アカウント選択</div>
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
    </>
  );
}
