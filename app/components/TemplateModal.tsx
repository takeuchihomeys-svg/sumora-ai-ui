"use client";

import { useState } from "react";
import { TEMPLATES, TEMPLATE_CATEGORIES } from "../lib/templates";

interface TemplateModalProps {
  onClose: () => void;
  /** チャット画面から呼ぶ場合: テキストを入力欄にセット */
  onSelect?: (text: string) => void;
}

export default function TemplateModal({ onClose, onSelect }: TemplateModalProps) {
  const [category, setCategory] = useState("初回応対");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-t-3xl bg-white shadow-2xl">
        {/* ヘッダー */}
        <div
          className="flex items-center justify-between rounded-t-3xl px-5 py-4"
          style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
        >
          <div className="text-[17px] font-bold text-white">📋 テンプレート辞書</div>
          <button
            onClick={onClose}
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
              onClick={() => setCategory(cat)}
              className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold transition"
              style={
                category === cat
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
            {(TEMPLATES[category] || []).map((tmpl) => (
              <div key={tmpl.id} className="rounded-2xl border border-[#e9edef] bg-[#f8f9fa] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold text-[#1565C0]">{tmpl.label}</span>
                  <div className="flex items-center gap-1.5">
                    {onSelect && (
                      <button
                        onClick={() => { onSelect(tmpl.text); onClose(); }}
                        className="rounded-full px-3 py-1 text-xs font-bold text-white"
                        style={{ background: "linear-gradient(135deg, #06c755, #06a043)" }}
                      >
                        使う
                      </button>
                    )}
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
  );
}
