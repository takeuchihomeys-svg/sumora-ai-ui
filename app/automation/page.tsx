"use client";
import { useState, useEffect, useCallback } from "react";

type AutoCommand = {
  id: string;
  status: "pending" | "running" | "done" | "error";
  total_customers: number;
  processed_customers: number;
  sites: string[];
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
};

const SITE_LABELS: Record<string, string> = {
  reins: "レインズ",
  itandi: "itandi",
  realnetpro: "リアプロ",
};

export default function AutomationPage() {
  const [commands, setCommands] = useState<AutoCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSites, setSelectedSites] = useState<string[]>(["reins"]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/automation/status");
      if (!res.ok) return;
      const data = await res.json() as { commands: AutoCommand[] };
      setCommands(data.commands || []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    const active = commands.find(c => c.status === "pending" || c.status === "running");
    if (!active) return;
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [commands, fetchStatus]);

  const handleStart = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/automation/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sites: selectedSites }),
      });
      if (!res.ok) throw new Error("Failed");
      await fetchStatus();
    } catch (e) {
      alert("エラーが発生しました: " + String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleSite = (site: string) => {
    setSelectedSites(prev =>
      prev.includes(site) ? prev.filter(s => s !== site) : [...prev, site]
    );
  };

  const activeCommand = commands.find(c => c.status === "pending" || c.status === "running");
  const isRunning = !!activeCommand;
  const progress = activeCommand && activeCommand.total_customers > 0
    ? Math.round((activeCommand.processed_customers / activeCommand.total_customers) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-gray-50 p-4 max-w-lg mx-auto">
      <h1 className="text-xl font-bold text-gray-800 mb-1">物件一括自動検索</h1>
      <p className="text-xs text-gray-500 mb-6">PCのChromeが自動で順番に検索します</p>

      <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
        <p className="text-sm font-semibold text-gray-600 mb-3">検索サイト選択</p>
        <div className="flex gap-2 flex-wrap">
          {["reins", "itandi", "realnetpro"].map(site => (
            <button
              key={site}
              onClick={() => toggleSite(site)}
              className={[
                "px-4 py-2 rounded-xl text-sm font-medium transition-colors",
                selectedSites.includes(site)
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600"
              ].join(" ")}
            >
              {SITE_LABELS[site]}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={handleStart}
        disabled={loading || isRunning || selectedSites.length === 0}
        className="w-full py-4 rounded-2xl bg-blue-600 text-white text-lg font-bold shadow-md active:scale-95 transition-transform disabled:opacity-50 disabled:cursor-not-allowed mb-4"
      >
        {isRunning
          ? "実行中..."
          : loading
          ? "開始中..."
          : "全顧客まとめて検索開始"}
      </button>

      {activeCommand && (
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-semibold text-gray-700">
              {activeCommand.status === "pending" ? "⏳ PCの起動待ち..." : "🔍 検索中..."}
            </span>
            <span className="text-sm text-gray-500">
              {activeCommand.processed_customers} / {activeCommand.total_customers}人
            </span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-3">
            <div
              className="bg-blue-500 h-3 rounded-full transition-all duration-500"
              style={{ width: progress + "%" }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-2">
            {activeCommand.status === "pending"
              ? "PCのChromeが拾い上げるまで最大30秒かかります"
              : (activeCommand.sites ?? []).map(s => SITE_LABELS[s] || s).join("・") + " で検索中"}
          </p>
        </div>
      )}

      {commands.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm p-4">
          <p className="text-sm font-semibold text-gray-600 mb-3">実行履歴</p>
          <div className="space-y-3">
            {commands.map(cmd => (
              <div key={cmd.id} className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={[
                      "text-xs px-2 py-0.5 rounded-full font-medium",
                      cmd.status === "done" ? "bg-green-100 text-green-700" :
                      cmd.status === "running" ? "bg-blue-100 text-blue-700" :
                      cmd.status === "pending" ? "bg-yellow-100 text-yellow-700" :
                      "bg-red-100 text-red-700"
                    ].join(" ")}>
                      {cmd.status === "done" ? "完了" :
                       cmd.status === "running" ? "実行中" :
                       cmd.status === "pending" ? "待機中" : "エラー"}
                    </span>
                    <span className="text-xs text-gray-500">
                      {(cmd.sites ?? []).map(s => SITE_LABELS[s] || s).join("・")}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {new Date(cmd.created_at).toLocaleString("ja-JP", {
                      month: "numeric", day: "numeric",
                      hour: "2-digit", minute: "2-digit"
                    })}
                  </p>
                </div>
                <span className="text-sm text-gray-600 font-medium">
                  {cmd.processed_customers}/{cmd.total_customers}人
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
