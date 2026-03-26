"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

// アカウント一覧（後々追加）
const ACCOUNTS = [
  { id: "sumora", name: "スモラ", icon: "🦄", active: true },
];

// ────────────────────────────────────────────────────────────────
//  テンプレートデータ
// ────────────────────────────────────────────────────────────────

const TEMPLATES: Record<string, { id: string; label: string; text: string }[]> = {
  "初回応対": [
    {
      id: "t1",
      label: "初回あいさつ",
      text: "はじめまして！スモラの担当です😊\nどのようなお部屋をお探しでしょうか？\nご希望の条件をお聞かせいただければ、条件に合ったお部屋をピックアップしてご提案させて頂きます！",
    },
    {
      id: "t2",
      label: "連絡お礼",
      text: "ご連絡いただきありがとうございます！\nスモラでご希望のお部屋を一緒に探しましょう😊\nまずは、ご希望の家賃・エリア・間取りをお聞かせください！",
    },
  ],
  "物件探し中": [
    {
      id: "t3",
      label: "条件ヒアリング",
      text: "ご希望の条件をもう少し詳しくお聞かせください😊\n・ご希望の家賃帯\n・エリア（駅名など）\n・間取り（1K・1LDKなど）\n・ご入居希望時期",
    },
    {
      id: "t4",
      label: "物件提案",
      text: "〇〇さんの条件に近いお部屋をいくつかピックアップしました😊\nご確認いただき、気になるお部屋があればぜひ教えてください！",
    },
    {
      id: "t5",
      label: "空き確認中",
      text: "ご希望のお部屋の空き状況を確認いたします！\n少々お時間をいただきますが、わかり次第ご連絡いたします😊",
    },
  ],
  "内覧": [
    {
      id: "t6",
      label: "内覧お誘い",
      text: "お気に召したお部屋はございましたか？😊\nぜひ一度内覧されてみませんか？\nご都合の良い日時をいくつかお知らせいただければご予約いたします！",
    },
    {
      id: "t7",
      label: "内覧確認",
      text: "内覧のご予約ありがとうございます！\n当日は〇〇（住所）にお集まりください😊\nご不明な点がございましたらお気軽にご連絡ください！",
    },
  ],
  "申込・審査": [
    {
      id: "t8",
      label: "申込後押し",
      text: "〇〇さんの条件にかなり近いお部屋となっておりますので、\nお気に召されましたらお申込してお部屋をおさえさせて頂きます！！\n今の市場では人気物件はすぐに埋まってしまいますので、ぜひご検討ください😊",
    },
    {
      id: "t9",
      label: "書類案内",
      text: "お申込ありがとうございます！\n審査に必要な書類をご準備いただけますか？\n・身分証明書（運転免許証など）\n・収入証明書（源泉徴収票など）\nご不明な点はお気軽にどうぞ😊",
    },
    {
      id: "t10",
      label: "審査結果待ち",
      text: "現在審査を進めております😊\n結果が出ましたらすぐにご連絡いたします！\nもうしばらくお待ちください。",
    },
  ],
  "契約・成約": [
    {
      id: "t11",
      label: "審査通過",
      text: "おめでとうございます🎉 審査が通過いたしました！\n次は契約手続きに進みます。\n契約書の内容についてご説明しますので、日程を調整させてください😊",
    },
    {
      id: "t12",
      label: "ご成約お礼",
      text: "この度はご成約おめでとうございます🎉\nご入居まで引き続きサポートいたします！\n新生活のスタートが素晴らしいものになりますよう応援しております😊",
    },
    {
      id: "t13",
      label: "鍵渡し案内",
      text: "鍵のお渡しについてのご案内です🔑\n〇月〇日〇時に〇〇（場所）にてお渡しいたします。\nご確認よろしくお願いいたします😊",
    },
  ],
};

const TEMPLATE_CATEGORIES = Object.keys(TEMPLATES);

export default function BottomNav() {
  const pathname = usePathname();
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateCategory, setTemplateCategory] = useState("初回応対");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const NAV_ITEMS = [
    { type: "account" as const, label: "アカウント", emoji: "👤" },
    { type: "link" as const, href: "/", label: "メッセージ", emoji: "💬" },
    { type: "link" as const, href: "/calendar", label: "カレンダー", emoji: "📅" },
    { type: "template" as const, label: "テンプレート", emoji: "📋" },
  ];

  return (
    <>
      <nav
        className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-[#d1d7db] bg-white/90 backdrop-blur-sm"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {NAV_ITEMS.map((item) => {
          if (item.type === "link") {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-1 flex-col items-center justify-center py-2 text-center"
              >
                <span className="mb-0.5 text-[22px] leading-none">{item.emoji}</span>
                <span
                  className="text-[10px] font-semibold"
                  style={
                    isActive
                      ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }
                      : { color: "#8696a0" }
                  }
                >
                  {item.label}
                </span>
                {isActive && (
                  <span
                    className="mt-1 h-1 w-6 rounded-full"
                    style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
                  />
                )}
              </Link>
            );
          }

          if (item.type === "account") {
            return (
              <button
                key="account"
                onClick={() => setShowAccountModal(true)}
                className="flex flex-1 flex-col items-center justify-center py-2 text-center"
              >
                <span className="mb-0.5 text-[22px] leading-none">{item.emoji}</span>
                <span className="text-[10px] font-semibold text-[#8696a0]">{item.label}</span>
              </button>
            );
          }

          // template
          return (
            <button
              key="template"
              onClick={() => setShowTemplates(true)}
              className="flex flex-1 flex-col items-center justify-center py-2 text-center"
            >
              <span className="mb-0.5 text-[22px] leading-none">{item.emoji}</span>
              <span className="text-[10px] font-semibold text-[#8696a0]">{item.label}</span>
            </button>
          );
        })}
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

      {/* テンプレートモーダル */}
      {showTemplates && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowTemplates(false); }}
        >
          <div className="w-full max-w-lg rounded-t-3xl bg-white shadow-2xl">
            {/* ヘッダー */}
            <div
              className="flex items-center justify-between rounded-t-3xl px-5 py-4"
              style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
            >
              <div className="text-[17px] font-bold text-white">📋 テンプレート</div>
              <button
                onClick={() => setShowTemplates(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white"
              >
                ✕
              </button>
            </div>

            {/* カテゴリタブ */}
            <div className="flex gap-1.5 overflow-x-auto border-b border-[#f0f2f5] bg-white px-4 py-2.5">
              {TEMPLATE_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setTemplateCategory(cat)}
                  className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold transition"
                  style={
                    templateCategory === cat
                      ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", color: "white" }
                      : { backgroundColor: "#f0f2f5", color: "#54656f" }
                  }
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* テンプレート一覧 */}
            <div className="max-h-[55vh] overflow-y-auto p-4">
              <div className="flex flex-col gap-3">
                {(TEMPLATES[templateCategory] || []).map((tmpl) => (
                  <div key={tmpl.id} className="rounded-2xl border border-[#e9edef] bg-[#f8f9fa] p-4">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-bold text-[#1565C0]">{tmpl.label}</span>
                      <button
                        onClick={() => copyText(tmpl.id, tmpl.text)}
                        className="rounded-full px-3 py-1 text-xs font-bold text-white transition"
                        style={
                          copiedId === tmpl.id
                            ? { backgroundColor: "#4CAF50" }
                            : { background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }
                        }
                      >
                        {copiedId === tmpl.id ? "✓ コピー済み" : "コピー"}
                      </button>
                    </div>
                    <p className="whitespace-pre-wrap text-[13px] leading-5 text-[#111b21]">
                      {tmpl.text}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
