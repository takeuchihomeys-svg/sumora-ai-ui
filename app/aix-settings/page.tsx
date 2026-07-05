"use client";

import { useEffect, useState } from "react";

type Setting = {
  key: string;
  label: string;
  value: string;
  is_default: boolean;
  updated_at: string | null;
};

export default function AixSettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/aix/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setSettings(d.settings);
          const vals: Record<string, string> = {};
          d.settings.forEach((s: Setting) => { vals[s.key] = s.value; });
          setEditValues(vals);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (key: string) => {
    setSaving(key);
    try {
      const res = await fetch("/api/aix/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: editValues[key] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        alert(`保存失敗: ${err.error ?? `HTTP ${res.status}`}`);
        return;
      }
      const d = await res.json() as { ok: boolean; error?: string };
      if (d.ok) {
        setSavedKey(key);
        setSettings((prev) =>
          prev.map((s) => s.key === key ? { ...s, is_default: false, updated_at: new Date().toISOString() } : s)
        );
        setTimeout(() => setSavedKey(null), 2500);
      } else {
        alert(`保存失敗: ${d.error}`);
      }
    } catch (e) {
      console.error("[handleSave] error:", e);
      alert("保存に失敗しました。通信環境を確認してください");
    } finally {
      setSaving(null);
    }
  };

  const handleReset = (key: string) => {
    const s = settings.find((x) => x.key === key);
    if (!s) return;
    // デフォルト値に戻す（まだ保存はしない）
    setEditValues((prev) => ({ ...prev, [key]: s.value }));
  };

  return (
    <main className="min-h-screen bg-[#f0f4f8] pb-12">
      <header className="sticky top-0 z-10 px-4 py-4 shadow-sm"
        style={{ background: "linear-gradient(135deg,#1a237e,#283593,#3949ab)" }}>
        <div className="flex items-center gap-3">
          <div className="text-[18px] font-bold text-white">⚙️ AIX 設定</div>
          <div className="text-[11px] text-white/60">Supabase に保存 — デプロイ後も保持</div>
        </div>
      </header>

      <div className="mx-auto max-w-2xl p-4 flex flex-col gap-6">

        {/* 使い方ガイド */}
        <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 text-[12px] text-blue-800">
          <div className="font-bold mb-1">📌 使い方</div>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>各アクションのシステムプロンプトを自由に編集できます</li>
            <li><code className="bg-blue-100 px-1 rounded">{"{{examples}}"}</code> — AIが学んだ実例（☆つき）が自動注入されます</li>
            <li><code className="bg-blue-100 px-1 rounded">{"{{knowledge}}"}</code> — ノウハウDBが自動注入されます</li>
            <li><code className="bg-blue-100 px-1 rounded">{"{{phrases}}"}</code> — よく使うフレーズが自動注入されます</li>
            <li>保存するとコードデプロイ後も設定が維持されます</li>
          </ul>
        </div>

        {loading ? (
          <div className="text-center text-[#8696a0] py-12">読み込み中...</div>
        ) : (
          settings.map((s) => (
            <div key={s.key} className="rounded-2xl bg-white shadow-sm overflow-hidden">
              {/* ヘッダー */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-[#f0f2f5]">
                <div>
                  <div className="text-[14px] font-bold text-[#111b21]">{s.label}</div>
                  <div className="text-[11px] text-[#8696a0] mt-0.5">
                    {s.is_default
                      ? "⚠️ デフォルト値（未保存）— 保存するとDB固定されます"
                      : `✅ DB保存済 — ${s.updated_at ? new Date(s.updated_at).toLocaleString("ja-JP") : ""}`}
                  </div>
                </div>
              </div>

              {/* テキストエリア */}
              <div className="px-4 py-3">
                <textarea
                  value={editValues[s.key] ?? ""}
                  onChange={(e) => setEditValues((prev) => ({ ...prev, [s.key]: e.target.value }))}
                  rows={18}
                  className="w-full rounded-xl border border-[#e0e0e0] bg-[#fafafa] px-3 py-2 text-[12px] font-mono text-[#111b21] focus:outline-none focus:border-[#3949ab] resize-y"
                />
              </div>

              {/* ボタン */}
              <div className="flex gap-2 px-4 pb-4">
                <button
                  onClick={() => handleSave(s.key)}
                  disabled={saving === s.key}
                  className="flex-1 rounded-xl bg-[#3949ab] py-2.5 text-[13px] font-bold text-white active:bg-[#283593] disabled:opacity-50"
                >
                  {saving === s.key ? "保存中..." : savedKey === s.key ? "✅ 保存しました" : "💾 Supabaseに保存"}
                </button>
                <button
                  onClick={() => handleReset(s.key)}
                  className="rounded-xl border border-[#e0e0e0] px-4 py-2.5 text-[12px] text-[#667781] active:bg-[#f0f2f5]"
                >
                  リセット
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
