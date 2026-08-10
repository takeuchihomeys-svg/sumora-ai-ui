"use client";

import { useEffect, useState, useMemo, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import BottomNav from "@/app/components/BottomNav";
import { supabase } from "@/app/lib/supabase";

type LinkedConv = {
  id: string;
  last_message?: string | null;
  last_sender?: string | null;
  updated_at?: string | null;
  account?: string | null;
  status?: string | null;
  profile_image_url?: string | null;
  customer_name?: string | null;
  is_hot?: boolean | null;
  is_flagged?: boolean | null;
};

type SummaryJson = {
  situation?: string;
  inspection?: { requested?: boolean; done?: boolean; properties?: string[] };
  estimate?: { requested?: boolean };
  requirements?: string[];
  opinions?: string[];
  our_actions?: string[];
  winning_pattern?: string;
  next_action?: string;
};

type Customer = {
  id: string;
  customer_name: string;
  line_user_id?: string | null;
  phone?: string | null;
  status: string;
  account?: string | null;
  assignee?: string | null;
  preferences?: string | null;
  ng_points?: string | null;
  property_memo?: string | null;
  last_property_sent_at?: string | null;
  move_in_time?: string | null;
  rent_min?: number | null;
  rent_max?: number | null;
  desired_area?: string | null;
  walk_minutes?: number | null;
  floor_plan?: string | null;
  building_age?: number | null;
  other_requests?: string | null;
  initial_cost_limit?: number | null;
  floor_area_min?: number | null;
  floor_area_max?: number | null;
  pet?: boolean | null;
  property_send_count?: number | null;
  property_viewed_at?: string | null;
  additional_conditions?: string | null;
  ai_summary?: string | null;
  ai_summary_json?: SummaryJson | null;
  ai_summary_at?: string | null;
  created_at: string;
  updated_at: string;
  is_linked?: boolean;
  linked_conversation?: LinkedConv | null;
  lines?: string[] | null;
  stations?: string[] | null;
  rp_update_days?: number | null;
  area_mode?: string | null;
};

// 物件比較（🏠 物件比較）の結果型
type PropRankItem = {
  index: number;
  label: string;
  property_name: string;
  score: number;
  hardNG: string | null;
  breakdown: Array<{ label: string; point: number; note: string }>;
};
type PropCompareResult = {
  best: (PropRankItem & { summary: string }) | null;
  ranked: PropRankItem[];
  customer_name: string;
};

// リアプロ自動スクレイプ比較 — automation_commands 経由
// 修正11: pending→running→done/error をポーリングで追跡し、成否をボタンに反映する
// noext = 60秒 pending のまま（PC拡張が起動していない可能性）
// timeout = 6分経過しても done/error に到達しない（拡張クラッシュ・PC停止等）
type ScrapeCompareStatus = "idle" | "queued" | "running" | "done" | "error" | "noext" | "timeout";

const PROP_STATUS: Record<string, { label: string; dot: string }> = {
  new_inquiry:     { label: "新規",    dot: "bg-red-500" },
  hot:             { label: "毎日",    dot: "bg-orange-400" },
  property_search: { label: "物件出し", dot: "bg-blue-400" },
  pending:         { label: "検討中",  dot: "bg-gray-300" },
  applying:        { label: "申込",    dot: "bg-pink-500" },
  screening:       { label: "審査中",  dot: "bg-indigo-500" },
  contract:        { label: "契約",    dot: "bg-emerald-600" },
  closed_won:      { label: "成約",    dot: "bg-emerald-800" },
};

const APPLYING_STATUSES = ["applying", "screening", "contract", "closed_won"];
function isApplying(status: string) { return APPLYING_STATUSES.includes(status); }

const ACCT_LABEL: Record<string, string> = {
  sumora: "スモラ", ieyasu: "イエヤス", giga: "ギガ", hasu: "ハス",
};

function relTime(d?: string | null) {
  if (!d) return "";
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

function needsProp(status: string, lastSent?: string | null) {
  if (status === "pending") return false;
  if (isApplying(status)) return false;
  if (status === "new_inquiry") return true;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (status === "hot") return !lastSent || new Date(lastSent) < today;
  if (status === "property_search") {
    if (!lastSent) return true;
    return (Date.now() - new Date(lastSent).getTime()) / 86400000 >= 3;
  }
  return false;
}

type Urgency = "reply" | "property" | "ok" | "passive";
function urgency(c: Customer): Urgency {
  if (c.linked_conversation?.last_sender === "customer") return "reply";
  if (needsProp(c.status, c.last_property_sent_at)) return "property";
  if (c.status === "pending") return "passive";
  return "ok";
}
const URGENCY_ORDER: Record<Urgency, number> = { reply: 0, property: 1, ok: 2, passive: 3 };

function initial(name: string) { return name?.trim()?.charAt(0) ?? "?"; }

function generateSearchFormat(c: Customer): string {
  const year = new Date().getFullYear();
  const lines: string[] = [];
  lines.push(`1 ${c.move_in_time || "（未入力）"}`);
  const rentMin = c.rent_min ? Math.floor(c.rent_min / 10000) : null;
  const rentMax = c.rent_max ? Math.floor(c.rent_max / 10000) : null;
  if (rentMin && rentMax) lines.push(`2 できれば${rentMin}から${rentMax}万円`);
  else if (rentMax) lines.push(`2 できれば${rentMax}万円以内`);
  else lines.push("2 （未入力）");
  if (c.ng_points) lines.push(`3 ${c.ng_points}でなければ特にない`);
  else lines.push("3 特にない");
  if (c.building_age) lines.push(`4 ${year - c.building_age}年以降`);
  else lines.push("4 築年数不問");
  lines.push(`5 ${c.desired_area || "（未入力）"}`);
  if (c.walk_minutes) lines.push(`6 ${c.walk_minutes}分以内`);
  else lines.push("6 （未入力）");
  if (c.initial_cost_limit) lines.push(`7 ${Math.floor(c.initial_cost_limit / 10000)}万💴以内`);
  else lines.push("7 （未入力）");
  const petStr = c.pet === true ? "ペット可" : c.pet === false ? "ペット不可" : "";
  const pref = [petStr, c.preferences].filter(Boolean).join("、");
  lines.push(`8 ${pref || "特にない"}`);
  return lines.join("\n");
}

function isToday(d?: string | null): boolean {
  if (!d) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return new Date(d) >= today;
}

function completedToday(c: Customer): { sent: boolean; viewed: boolean } {
  return { sent: isToday(c.last_property_sent_at), viewed: isToday(c.property_viewed_at) };
}

function isDoneToday(c: Customer): boolean {
  const { sent, viewed } = completedToday(c);
  return sent || viewed;
}

// 条件ログエントリのパース: "【2026/06/07追加】" or "【2026/06/07反映済み】" or "【2026/06/07 自動反映】" 形式を検出
function parseConditionLog(text: string): { isLog: boolean; isReflected: boolean; isAutoReflected: boolean; date: string; content: string } {
  const m = text.match(/^【(\d{4}\/\d{2}\/\d{2})(追加|反映済み| 自動反映)】([\s\S]*)$/);
  if (m) return { isLog: true, isReflected: m[2] === "反映済み", isAutoReflected: m[2] === " 自動反映", date: m[1], content: m[3].trim() };
  return { isLog: false, isReflected: false, isAutoReflected: false, date: "", content: text };
}

// 駅リスト（5駅以上の・区切り）を「なかもず 他47駅」に要約して表示
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^[-*]\s+/gm, "・")
    .replace(/^---+$/gm, "")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function summarizeCondContent(content: string): string {
  const stripped = stripMarkdown(content);
  if (!stripped) return "";
  const items = stripped.split(/[・、]/).map(s => s.trim()).filter(Boolean);
  if (items.length >= 5) return `${items[0]} 他${items.length - 1}駅`;
  return stripped;
}

// addCondText が駅リストか判定（5駅以上）
function isStationList(text: string): boolean {
  const stripped = text.trim().replace(/^#{1,3}\s*設定中の[駅沿線][^\n]*\n?/, "");
  return stripped.split(/[・、\n]/).map(s => s.trim()).filter(Boolean).length >= 5;
}

// 駅リストを「・」区切りの1行テキストに正規化（ヘッダー除去・改行結合）
function normalizeStationList(text: string): string {
  const stripped = text.trim().replace(/^#{1,3}\s*設定中の[駅沿線][^\n]*\n?/, "");
  return stripped.split(/[\n]/).map(s => s.trim()).filter(Boolean).join("・").replace(/・{2,}/g, "・");
}

function formatLogDate(): string {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
}

const FLOOR_PLAN_OPTIONS = ["1R", "1K", "1DK", "1LDK", "2K", "2DK", "2LDK", "3LDK"] as const;

type EditFields = {
  desired_area: string; floor_plan: string;
  area_input: string; station_input: string;
  shikirei_free: boolean;
  rent_min: string; rent_max: string;
  walk_minutes: string; move_in_time: string;
  building_age: string; initial_cost_limit: string;
  floor_area_min: string; floor_area_max: string;
  pet: string;
  preferences: string; ng_points: string;
  other_requests: string; property_memo: string;
};

function parseAreaStation(desired_area: string | null | undefined): { area_input: string; station_input: string } {
  if (!desired_area) return { area_input: "", station_input: "" };
  const tokens = desired_area.split(/[・、,\n]+/).map((t) => t.trim()).filter(Boolean);
  const stationTokens: string[] = [];
  const areaTokens: string[] = [];
  for (const t of tokens) {
    if (/駅|線/.test(t)) stationTokens.push(t);
    else areaTokens.push(t);
  }
  return { area_input: areaTokens.join("・"), station_input: stationTokens.join("・") };
}

function detectShikireiFlag(c: Customer): boolean {
  const text = `${c.preferences ?? ""} ${c.ng_points ?? ""} ${c.other_requests ?? ""}`;
  return /敷礼なし|敷金礼金なし|敷金礼金0|敷金0礼金0|敷0礼0/.test(text);
}

function toEditFields(c: Customer): EditFields {
  const { area_input, station_input } = parseAreaStation(c.desired_area);
  return {
    desired_area:       c.desired_area       ?? "",
    area_input,
    station_input,
    shikirei_free:      detectShikireiFlag(c),
    floor_plan:         c.floor_plan         ?? "",
    rent_min:           c.rent_min           ? String(Math.floor(c.rent_min / 10000)) : "",
    rent_max:           c.rent_max           ? String(Math.floor(c.rent_max / 10000)) : "",
    walk_minutes:       c.walk_minutes       ? String(c.walk_minutes) : "",
    move_in_time:       c.move_in_time       ?? "",
    building_age:       c.building_age       ? String(c.building_age) : "",
    initial_cost_limit: c.initial_cost_limit ? String(Math.floor(c.initial_cost_limit / 10000)) : "",
    floor_area_min:     c.floor_area_min     ? String(c.floor_area_min) : "",
    floor_area_max:     c.floor_area_max     ? String(c.floor_area_max) : "",
    pet:                c.pet === true ? "true" : c.pet === false ? "false" : "",
    preferences:        c.preferences        ?? "",
    ng_points:          c.ng_points          ?? "",
    other_requests:     c.other_requests     ?? "",
    property_memo:      c.property_memo      ?? "",
  };
}

function emptyEditFields(): EditFields {
  return { desired_area:"", area_input:"", station_input:"", shikirei_free:false, floor_plan:"", rent_min:"", rent_max:"", walk_minutes:"", move_in_time:"", building_age:"", initial_cost_limit:"", floor_area_min:"", floor_area_max:"", pet:"", preferences:"", ng_points:"", other_requests:"", property_memo:"" };
}

// popup.js の parseAreaMin と同一ロジック
// "25㎡以上" / "25平米以上" / "25m2以上" 等の自由記述から面積下限を抽出
function parseAreaMin(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/(\d+)\s*(?:平米|㎡|m2|m²)\s*以上/i);
  return m ? Number(m[1]) : null;
}

// popup.js の calcUpdateDays と同一ロジック: 最終物件送信日からリアプロ更新日フィルターを算出
function calcRpUpdateDays(lastSentAt: string | null | undefined): number | null {
  if (!lastSentAt) return null;
  const daysSince = Math.floor((Date.now() - new Date(lastSentAt).getTime()) / 86400000);
  if (daysSince <= 1) return 1;
  if (daysSince <= 3) return 3;
  if (daysSince <= 7) return 7;
  return 14;
}

// popup.js preloadAdjForm のペット判定と同一ロジック: pet=null時は自由記述フォールバック
function resolvePetOk(c: Customer): boolean {
  if (c.pet === true) return true;
  if (c.pet === false) return false;
  const petFields = [c.preferences, c.other_requests, c.additional_conditions].filter(Boolean).join(" ");
  return /ペット|pet/i.test(petFields);
}

// 建物構造トークン (page-script.js の STRUCTURE_MAP キーと一致。長い順で部分一致誤検出を防ぐ)
const STRUCTURE_TOKENS = [
  "鉄骨鉄筋コンクリート造", "鉄筋コンクリート造", "木造一部RC造",
  "重量鉄骨造", "軽量鉄骨造", "SRC造", "鉄骨造", "RC造", "SRC", "S造", "RC", "木造",
];

// 自由記述から建物構造希望を抽出。否定表現(木造NG等)は除外（フィルターが反転するため）
function parseStructureTypes(...texts: (string | null | undefined)[]): string[] {
  let joined = texts.filter(Boolean).join("、");
  if (!joined) return [];
  const found: string[] = [];
  for (const tok of STRUCTURE_TOKENS) {
    const idx = joined.indexOf(tok);
    if (idx === -1) continue;
    const after = joined.slice(idx + tok.length, idx + tok.length + 6);
    joined = joined.split(tok).join(" ");
    if (/^(は|も)?(NG|ＮＧ|以外|不可|×|避け|嫌|ダメ|だめ)/.test(after)) continue;
    found.push(tok);
  }
  return found;
}

function CustomersPageInner() {
  const searchParams = useSearchParams();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filterMode, setFilterMode] = useState<"linked" | "all" | "urgent" | "applying" | "flagged">("linked");
  const [expandedId, setExpandedId]     = useState<string | null>(null);
  const [sentUpdating, setSentUpdating]   = useState<string | null>(null);
  const [viewedUpdating, setViewedUpdating]   = useState<string | null>(null);
  const [updateDaysUpdating, setUpdateDaysUpdating] = useState<string | null>(null);
  const [formatCopied, setFormatCopied]   = useState<string | null>(null);
  const [formatMsgModal, setFormatMsgModal] = useState<{ text: string } | null>(null);
  const [formatMsgLoading, setFormatMsgLoading] = useState<string | null>(null);
  const [showCompleted, setShowCompleted]     = useState(false);
  const [reflectLoading, setReflectLoading]   = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // 条件に反映する → 保存後に生テキストを「反映済み」ログに変換するために使用
  const convertRawOnSave = useRef<{ id: string; raw: string } | null>(null);
  const summaryInitDone = useRef(false);
  const [statusMenuId, setStatusMenuId] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartPos = useRef<{ x: number; y: number } | null>(null);
  const longPressActivated = useRef(false);

  const [showAdd, setShowAdd]       = useState(false);
  const [newName, setNewName]       = useState("");
  const [newPhone, setNewPhone]     = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  const [editId, setEditId]         = useState<string | null>(null);
  const [editFields, setEditFields] = useState<EditFields | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  // 条件ログ展開（3件以上のとき「もっと見る」）
  const [expandedCondIds, setExpandedCondIds] = useState<Set<string>>(new Set());
  const [expandedSummaryIds, setExpandedSummaryIds] = useState<Set<string>>(new Set());
  const [expandedApplyingIds, setExpandedApplyingIds] = useState<Set<string>>(new Set());

  // 条件追加モーダル
  const [addCondId, setAddCondId]       = useState<string | null>(null);
  const [addCondText, setAddCondText]   = useState("");
  const [addCondParsing, setAddCondParsing] = useState(false);
  const [addCondSaving, setAddCondSaving]   = useState(false);
  const [parsedPreview, setParsedPreview]   = useState<EditFields | null>(null);
  const [addCondImage, setAddCondImage] = useState<{ base64: string; mediaType: string } | null>(null);
  const [addCondImagePreview, setAddCondImagePreview] = useState<string>("");

  const [summaries, setSummaries]           = useState<Record<string, string>>({});
  const [summaryJsons, setSummaryJsons]     = useState<Record<string, SummaryJson>>({});
  const [summaryLoading, setSummaryLoading] = useState<Set<string>>(new Set());

  // 🏠 物件比較: ピックアップ物件の画像を比較してどれが一番合うかAI判定
  const [propCompareOpen, setPropCompareOpen] = useState<string | null>(null);
  const [propCompareImages, setPropCompareImages] = useState<Record<string, Array<{ base64: string; mediaType: string; label: string; preview: string }>>>({});
  const [propCompareLoading, setPropCompareLoading] = useState<string | null>(null);
  const [propCompareResults, setPropCompareResults] = useState<Record<string, PropCompareResult>>({});

  // 🔍 リアプロ自動スクレイプ比較 — Chrome拡張 automation_commands 経由
  const [scrapeCompareStatus, setScrapeCompareStatus] = useState<Record<string, ScrapeCompareStatus>>({});
  // 修正: error時に automation_commands.error_message を保持して表示（未ログイン等が竹内さんに見える）
  const [scrapeCompareErrors, setScrapeCompareErrors] = useState<Record<string, string>>({});
  // 地域/駅 検索モード切替（リアプロ/itandi/レインズ共通・顧客ごと）
  // セッション内のみ保持しDB保存しない（popup.js の currentAreaMode と同じ揮発設計）。
  // "auto" = 従来の自動判定（decideLocationMode）にそのまま委ねる = デフォルト
  const [areaModeByCustomer, setAreaModeByCustomer] = useState<Record<string, "auto" | "ward" | "station">>({});
  const getAreaMode = (id: string): "auto" | "ward" | "station" => areaModeByCustomer[id] ?? "auto";
  const getAutoAreaMode = (c: Customer): "ward" | "station" | "auto" => {
    const hasArea = !!(c.desired_area?.trim());
    const hasStation = !!(c.stations?.length);
    if (hasArea && !hasStation) return "ward";
    if (!hasArea && hasStation) return "station";
    return "auto";
  };
  // ポーリングinterval / idle復帰timeout をアンマウント時に確実に停止するための保持
  const scrapePollIntervalsRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const scrapeIdleTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // Supabase Realtime チャンネル（ext-results）追跡 — アンマウント時に確実に解放
  const scrapeResultChannelsRef = useRef<Set<ReturnType<typeof supabase.channel>>>(new Set());
  useEffect(() => {
    const intervals = scrapePollIntervalsRef.current;
    const timeouts = scrapeIdleTimeoutsRef.current;
    const channels = scrapeResultChannelsRef.current;
    return () => {
      intervals.forEach((t) => clearInterval(t));
      intervals.clear();
      timeouts.forEach((t) => clearTimeout(t));
      timeouts.clear();
      channels.forEach((ch) => { supabase.removeChannel(ch).catch(() => {}); });
      channels.clear();
    };
  }, []);

  // 会話ログタブ管理
  const [activeTabs, setActiveTabs] = useState<Record<string, "summary" | "log">>({});
  const [msgCache, setMsgCache] = useState<Record<string, Array<{ id: string; text: string | null; sender: string; created_at: string }>>>({});
  const [loadingMsgs, setLoadingMsgs] = useState<Set<string>>(new Set());
  const [msgErrors, setMsgErrors] = useState<Set<string>>(new Set());

  // ボックス / リスト 切り替え
  const [viewMode, setViewMode] = useState<"list" | "box">("list");

  // AIXパネル（アツい・要対応・ターゲット一覧）
  const [showAixPanel, setShowAixPanel] = useState(false);

  // バッチ物件検索
  const [batchMode, setBatchMode] = useState<boolean>(false);
  const [batchIndex, setBatchIndex] = useState<number>(0);
  const [batchDone, setBatchDone] = useState<boolean>(false);
  const batchListRef = useRef<Customer[]>([]);
  const batchIsFlaggedRef = useRef<boolean>(false);

  // 改善13: 会話ログの自動スクロール用。顧客IDごとにスクロールコンテナのDOM参照を保持し、
  // メッセージ読み込み完了（msgCache更新）時に最下部（最新メッセージ）へスクロールする
  const msgLogRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    for (const id of Object.keys(msgCache)) {
      const el = msgLogRefs.current[id];
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [msgCache]);

  const fetchCustomers = async () => {
    try {
      const res = await fetch("/api/property-customers");
      if (res.ok) {
        const data: Customer[] = await res.json();
        setCustomers(data);
        const initModes: Record<string, "auto" | "ward" | "station"> = {};
        for (const c of data) {
          if (c.area_mode === "ward" || c.area_mode === "station") {
            initModes[c.id] = c.area_mode;
          }
        }
        if (Object.keys(initModes).length > 0) {
          setAreaModeByCustomer((prev) => ({ ...initModes, ...prev }));
        }
      }
    } catch (err) {
      console.error("[fetchCustomers] failed:", err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { fetchCustomers(); }, []);

  // URLパラメータ ?id=xxx でそのお客さんを自動展開
  useEffect(() => {
    const id = searchParams.get("id");
    if (id) {
      setExpandedId(id);
      setFilterMode("all");
    }
  }, [searchParams]);

  // ロード完了後: DB保存済み要約をstateに読み込み → 未生成の紐付き客を順次自動生成
  useEffect(() => {
    if (loading || summaryInitDone.current || customers.length === 0) return;
    summaryInitDone.current = true;

    const fromDb: Record<string, string> = {};
    const fromDbJson: Record<string, SummaryJson> = {};
    for (const c of customers) {
      if (c.ai_summary) fromDb[c.id] = c.ai_summary;
      if (c.ai_summary_json) fromDbJson[c.id] = c.ai_summary_json;
    }
    if (Object.keys(fromDb).length > 0) setSummaries(fromDb);
    if (Object.keys(fromDbJson).length > 0) setSummaryJsons(fromDbJson);

    const toGenerate = customers.filter((c) => c.is_linked && !c.ai_summary).slice(0, 8);
    if (toGenerate.length === 0) return;

    void (async () => {
      for (const c of toGenerate) {
        await generateSummary(c);
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, customers]);

  const base = useMemo(() => {
    let list: typeof customers;
    if (filterMode === "applying") {
      list = customers.filter((c) => isApplying(c.status));
    } else if (filterMode === "all") {
      list = customers.filter((c) => !isApplying(c.status));
    } else if (filterMode === "flagged") {
      list = customers.filter((c) => c.linked_conversation?.is_flagged && !isApplying(c.status));
    } else {
      list = customers.filter((c) => c.is_linked && !isApplying(c.status));
    }
    if (filterMode === "urgent") list = list.filter((c) => urgency(c) === "property");
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter((c) => c.customer_name.toLowerCase().includes(q));
  }, [customers, filterMode, searchQuery]);

  const completedList = useMemo(() =>
    base.filter((c) => isDoneToday(c)),
  [base]);

  // AIXパネル用データ（is_hot・is_flagged・ターゲットを既存customersから導出、追加フェッチなし）
  const AIX_14D_MS = 14 * 86400_000;
  const aixPanelData = useMemo(() => {
    const hot: Customer[] = [];
    const flagged: Customer[] = [];
    const target: Customer[] = [];
    const hotIds = new Set<string>();
    const flaggedIds = new Set<string>();
    const now = Date.now();

    for (const c of customers) {
      if (isApplying(c.status)) continue;
      const conv = c.linked_conversation;
      const updAt = conv?.updated_at ? new Date(conv.updated_at).getTime() : 0;
      if (conv?.is_hot && now - updAt <= AIX_14D_MS) {
        hot.push(c);
        hotIds.add(c.id);
      }
      if (conv?.is_flagged) {
        flagged.push(c);
        flaggedIds.add(c.id);
      }
    }

    // ターゲット: 物件出し対象・アツいと重複しない、最終送信が古い順
    customers
      .filter((c) =>
        !isApplying(c.status) &&
        ["new_inquiry", "hot", "property_search"].includes(c.status) &&
        !hotIds.has(c.id)
      )
      .sort((a, b) => {
        const ta = a.last_property_sent_at ? new Date(a.last_property_sent_at).getTime() : 0;
        const tb = b.last_property_sent_at ? new Date(b.last_property_sent_at).getTime() : 0;
        return ta - tb;
      })
      .slice(0, 30)
      .forEach((c) => target.push(c));

    return { hot, flagged, target };
  }, [customers]);

  const sorted = useMemo(() =>
    base
      .filter((c) => !isDoneToday(c))
      .sort((a, b) => {
        if (filterMode === "urgent") {
          // 未送信フィルタ: 送ってない日数が長い順（null=未送信=最優先=先頭）
          const ta = a.last_property_sent_at ? new Date(a.last_property_sent_at).getTime() : 0;
          const tb = b.last_property_sent_at ? new Date(b.last_property_sent_at).getTime() : 0;
          return ta - tb;
        }
        const ua = URGENCY_ORDER[urgency(a)];
        const ub = URGENCY_ORDER[urgency(b)];
        if (ua !== ub) return ua - ub;
        // 同一urgencyグループ内で内覧済み（inspection.done=true）を上位表示
        const aInspected = summaryJsons[a.id]?.inspection?.done === true;
        const bInspected = summaryJsons[b.id]?.inspection?.done === true;
        if (aInspected && !bInspected) return -1;
        if (!aInspected && bInspected) return 1;
        const ta = a.last_property_sent_at ? new Date(a.last_property_sent_at).getTime() : 0;
        const tb = b.last_property_sent_at ? new Date(b.last_property_sent_at).getTime() : 0;
        return tb - ta;
      }),
  [base, filterMode, summaryJsons]);

  // ボックスビュー用: sorted を updated_at の年月でグループ化
  const boxGroups = useMemo((): Array<{ label: string; customers: Customer[] }> => {
    const map = new Map<string, Customer[]>();
    for (const c of sorted) {
      const d = new Date(c.updated_at);
      const k = `${d.getFullYear()}年${d.getMonth() + 1}月`;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([label, customers]) => ({ label, customers }));
  }, [sorted]);

  const linkedCount    = customers.filter((c) => c.is_linked && !isApplying(c.status)).length;
  const replyCount     = customers.filter((c) => urgency(c) === "reply" && !isApplying(c.status)).length;
  const urgentCount    = customers.filter((c) => c.is_linked && urgency(c) === "property" && !isApplying(c.status)).length;
  const applyingCount  = customers.filter((c) => isApplying(c.status)).length;
  const flaggedCount   = customers.filter((c) => c.linked_conversation?.is_flagged && !isApplying(c.status)).length;

  const markSent = async (id: string) => {
    setSentUpdating(id);
    const now = new Date().toISOString();
    try {
      const res = await fetch("/api/property-customers", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, last_property_sent_at: now }),
      });
      if (res.ok) {
        const updated = await res.json();
        setCustomers((p) => p.map((c) => c.id === id ? { ...c, ...updated } : c));
      } else {
        console.error("[markSent] API failed:", res.status);
        alert("送信済みの更新に失敗しました。もう一度お試しください。");
      }
    } catch (err) {
      console.error("[markSent] failed:", err);
      alert("送信済みの更新に失敗しました。もう一度お試しください。");
    } finally {
      setSentUpdating(null);
    }
  };

  const cycleRpUpdateDays = async (c: Customer) => {
    const CYCLE: (number | null)[] = [1, 3, 7, 14, null];
    const cur = c.rp_update_days ?? null;
    const nextIdx = (CYCLE.indexOf(cur) + 1) % CYCLE.length;
    const nextVal = CYCLE[nextIdx];
    setUpdateDaysUpdating(c.id);
    try {
      const res = await fetch("/api/property-customers", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id, rp_update_days: nextVal }),
      });
      if (res.ok) {
        const updated = await res.json();
        setCustomers((p) => p.map((x) => x.id === c.id ? { ...x, ...updated } : x));
      }
    } catch { /* ignore */ }
    setUpdateDaysUpdating(null);
  };

  const addCustomer = async () => {
    if (!newName.trim() || addLoading) return;
    setAddLoading(true);
    const res = await fetch("/api/property-customers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_name: newName.trim(), phone: newPhone.trim() || undefined, assignee: newAssignee.trim() || undefined, status: "new_inquiry" }),
    });
    if (res.ok) {
      const created = await res.json();
      setCustomers((p) => [created, ...p]);
      setNewName(""); setNewPhone(""); setNewAssignee(""); setShowAdd(false);
    }
    setAddLoading(false);
  };

  const appendStr = (orig: string | null | undefined, add: string) => orig ? `${orig}、${add}` : add;

  // entryText: 対象の1エントリのテキスト（指定しない場合は最後の未処理行）
  const parseRawCondition = async (c: Customer, entryText?: string) => {
    const rawLines = c.additional_conditions!.split("\n")
      .filter(line => line.trim() && !parseConditionLog(line).isLog);
    if (rawLines.length === 0) return null;
    const rawText = entryText ?? rawLines[rawLines.length - 1];
    const res = await fetch("/api/parse-additional-conditions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: rawText }),
    });
    const data = await res.json() as { ok: boolean; parsed?: Record<string, unknown> };
    return data.ok ? { parsed: data.parsed ?? null, rawText } : null;
  };

  // appliedRawText: 反映済みにする1行のテキスト（省略時は全未処理行を反映済みにする）
  const applyConditionPatch = async (c: Customer, patch: Record<string, unknown>, appliedRawText?: string) => {
    if (Object.keys(patch).length <= 1) return;
    const saveRes = await fetch("/api/property-customers", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!saveRes.ok) return;
    const updated = await saveRes.json() as Customer;
    setCustomers((prev) => prev.map((x) => x.id === c.id ? { ...x, ...updated } : x));
    // 指定エントリのみ「反映済み」ログに変換（他の未処理エントリはそのまま）
    const logified = c.additional_conditions!.split("\n").map(line => {
      const pl = parseConditionLog(line);
      if (pl.isLog) return line;
      if (!appliedRawText || pl.content.trim() === appliedRawText.trim()) {
        return `【${formatLogDate()}反映済み】${pl.content}`;
      }
      return line; // 他の未処理エントリは変更しない
    }).filter(Boolean).join("\n");
    await fetch("/api/property-customers", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: c.id, additional_conditions: logified || null }),
    });
    setCustomers((prev) => prev.map((x) => x.id === c.id ? { ...x, additional_conditions: logified || null } : x));
    if (c.is_linked) void generateSummary({ ...c, ...updated } as Customer);
  };

  // 入れ替え: 選択した1エントリのフィールドで既存を上書き
  const handleReplace = async (c: Customer, entryText?: string) => {
    if (!c.additional_conditions || reflectLoading) return;
    setReflectLoading(c.id);
    try {
      const result = await parseRawCondition(c, entryText);
      if (!result?.parsed) return;
      const { parsed: p, rawText } = result;
      const patch: Record<string, unknown> = { id: c.id };
      if (p.desired_area)       patch.desired_area       = String(p.desired_area);
      if (p.floor_plan)         patch.floor_plan         = String(p.floor_plan);
      if (p.rent_min)           patch.rent_min           = Number(p.rent_min);
      if (p.rent_max)           patch.rent_max           = Number(p.rent_max);
      if (p.walk_minutes)       patch.walk_minutes       = Number(p.walk_minutes);
      if (p.move_in_time)       patch.move_in_time       = String(p.move_in_time);
      if (p.building_age)       patch.building_age       = Number(p.building_age);
      if (p.floor_area_min)     patch.floor_area_min     = Number(p.floor_area_min);
      if (p.initial_cost_limit) patch.initial_cost_limit = Number(p.initial_cost_limit);
      if (p.preferences)        patch.preferences        = String(p.preferences);
      if (p.ng_points)          patch.ng_points          = String(p.ng_points);
      if (p.other_requests)     patch.other_requests     = String(p.other_requests);
      await applyConditionPatch(c, patch, rawText);
    } finally {
      setReflectLoading(null);
    }
  };

  // 追加: 選択した1エントリのテキスト系フィールドを既存に追記
  const handleReflect = async (c: Customer, entryText?: string) => {
    if (!c.additional_conditions || reflectLoading) return;
    setReflectLoading(c.id);
    try {
      const result = await parseRawCondition(c, entryText);
      if (!result?.parsed) return;
      const { parsed: p, rawText } = result;
      const patch: Record<string, unknown> = { id: c.id };
      if (p.desired_area)       patch.desired_area       = appendStr(c.desired_area, String(p.desired_area));
      if (p.floor_plan)         patch.floor_plan         = String(p.floor_plan);
      if (p.rent_min)           patch.rent_min           = Number(p.rent_min);
      if (p.rent_max)           patch.rent_max           = Number(p.rent_max);
      if (p.walk_minutes)       patch.walk_minutes       = Number(p.walk_minutes);
      if (p.move_in_time)       patch.move_in_time       = String(p.move_in_time);
      if (p.building_age)       patch.building_age       = Number(p.building_age);
      if (p.floor_area_min)     patch.floor_area_min     = Number(p.floor_area_min);
      if (p.initial_cost_limit) patch.initial_cost_limit = Number(p.initial_cost_limit);
      if (p.preferences)        patch.preferences        = appendStr(c.preferences, String(p.preferences));
      if (p.ng_points)          patch.ng_points          = appendStr(c.ng_points, String(p.ng_points));
      if (p.other_requests)     patch.other_requests     = appendStr(c.other_requests, String(p.other_requests));
      await applyConditionPatch(c, patch, rawText);
    } finally {
      setReflectLoading(null);
    }
  };

  const clearAdditional = async (id: string) => {
    await fetch("/api/property-customers", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, additional_conditions: null }),
    });
    setCustomers((p) => p.map((c) => c.id === id ? { ...c, additional_conditions: null } : c));
  };

  const markViewed = async (id: string) => {
    setViewedUpdating(id);
    const now = new Date().toISOString();
    const res = await fetch("/api/property-customers", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, property_viewed_at: now, property_send_count: 0 }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCustomers((p) => p.map((c) => c.id === id ? { ...c, ...updated } : c));
    }
    setViewedUpdating(null);
  };

  const openEdit = (c: Customer) => { convertRawOnSave.current = null; setEditId(c.id); setEditFields(toEditFields(c)); };

  const saveEdit = async () => {
    if (!editId || !editFields || editSaving) return;
    setEditSaving(true);
    // 地域/駅 を merged して desired_area に戻す
    const merged_area = [editFields.area_input.trim(), editFields.station_input.trim()]
      .filter(Boolean).join("・");
    // 敷礼なしバッジ → ng_points に反映
    const SHIKIREI = "敷礼なし";
    let ngVal = editFields.ng_points;
    if (editFields.shikirei_free) {
      if (!ngVal.includes(SHIKIREI)) {
        ngVal = ngVal.trim() ? `${ngVal.trim()}・${SHIKIREI}` : SHIKIREI;
      }
    } else {
      ngVal = ngVal.split(/[・、,]/).filter((t) => t.trim() !== SHIKIREI).join("・");
    }
    const patch = {
      id: editId,
      desired_area:       merged_area                    || null,
      floor_plan:         editFields.floor_plan         || null,
      rent_min:           editFields.rent_min           ? Number(editFields.rent_min) * 10000           : null,
      rent_max:           editFields.rent_max           ? Number(editFields.rent_max) * 10000           : null,
      walk_minutes:       editFields.walk_minutes       ? Number(editFields.walk_minutes)               : null,
      move_in_time:       editFields.move_in_time       || null,
      building_age:       editFields.building_age       ? Number(editFields.building_age)               : null,
      initial_cost_limit: editFields.initial_cost_limit ? Number(editFields.initial_cost_limit) * 10000 : null,
      floor_area_min:     editFields.floor_area_min     ? Number(editFields.floor_area_min)              : null,
      floor_area_max:     editFields.floor_area_max     ? Number(editFields.floor_area_max)              : null,
      pet:                editFields.pet === "true" ? true : editFields.pet === "false" ? false : null,
      preferences:        editFields.preferences        || null,
      ng_points:          ngVal                         || null,
      other_requests:     editFields.other_requests     || null,
      property_memo:      editFields.property_memo      || null,
    };
    const res = await fetch("/api/property-customers", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const updated = await res.json();
      setCustomers((p) => p.map((c) => c.id === editId ? { ...c, ...updated } : c));
      // 条件更新後: 紐付き客はAI要約を自動再生成
      const editedC = customers.find((c) => c.id === editId);
      if (editedC?.is_linked) void generateSummary({ ...editedC, ...updated } as Customer);
      // 「条件に反映する」経由の場合: 生テキストを「反映済み」ログエントリに変換（削除しない）
      if (convertRawOnSave.current && convertRawOnSave.current.id === editId) {
        const { raw } = convertRawOnSave.current;
        convertRawOnSave.current = null;
        const logified = raw.split("\n").map(line => {
          const parsed = parseConditionLog(line);
          return parsed.isLog ? line : `【${formatLogDate()}反映済み】${parsed.content}`;
        }).filter(Boolean).join("\n");
        await fetch("/api/property-customers", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editId, additional_conditions: logified || null }),
        });
        setCustomers((p) => p.map((c) => c.id === editId ? { ...c, additional_conditions: logified || null } : c));
      }
    }
    setEditId(null); setEditFields(null); setEditSaving(false);
  };

  // 条件追加: AIでテキスト or 画像→構造化フィールドを自動解析
  const parseAddCond = async () => {
    if (!addCondImage && !addCondText.trim()) return;
    if (addCondParsing) return;
    setAddCondParsing(true);
    try {
      const body = addCondImage
        ? { imageBase64: addCondImage.base64, imageMediaType: addCondImage.mediaType }
        : { text: addCondText };
      const res = await fetch("/api/parse-additional-conditions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok: boolean; parsed?: Record<string, unknown>; extracted_text?: string };
      // 画像から抽出したテキストをテキスト欄に自動セット
      if (data.extracted_text) setAddCondText(data.extracted_text);
      if (!data.ok || !data.parsed) return;
      const p = data.parsed;
      // Haikuが駅リストをdesired_areaに入れ損ねた場合のフォールバック
      if (!p.desired_area && data.extracted_text) {
        const m = data.extracted_text.match(/設定中の[駅沿線][^\n]*\n([\s\S]+)/);
        if (m) {
          p.desired_area = m[1].trim().replace(/\n+/g, "・").replace(/・{2,}/g, "・");
        }
      }
      const f = emptyEditFields();
      const parsedDesiredArea = p.desired_area != null ? String(p.desired_area) : f.desired_area;
      const parsedAreaStation = parseAreaStation(parsedDesiredArea);
      const preview: EditFields = {
        desired_area:       parsedDesiredArea,
        area_input:         parsedAreaStation.area_input,
        station_input:      parsedAreaStation.station_input,
        shikirei_free:      false,
        floor_plan:         p.floor_plan         != null ? String(p.floor_plan)         : f.floor_plan,
        rent_min:           p.rent_min           != null ? String(Math.floor((p.rent_min as number)/10000)) : f.rent_min,
        rent_max:           p.rent_max           != null ? String(Math.floor((p.rent_max as number)/10000)) : f.rent_max,
        walk_minutes:       p.walk_minutes       != null ? String(p.walk_minutes)       : f.walk_minutes,
        move_in_time:       p.move_in_time       != null ? String(p.move_in_time)       : f.move_in_time,
        building_age:       p.building_age       != null ? String(p.building_age)       : f.building_age,
        floor_area_min:     p.floor_area_min     != null ? String(p.floor_area_min)     : f.floor_area_min,
        floor_area_max:     f.floor_area_max,
        pet:                f.pet,
        initial_cost_limit: p.initial_cost_limit != null ? String(Math.floor((p.initial_cost_limit as number)/10000)) : f.initial_cost_limit,
        preferences:        p.preferences        != null ? String(p.preferences)        : f.preferences,
        ng_points:          p.ng_points          != null ? String(p.ng_points)          : f.ng_points,
        other_requests:     p.other_requests     != null ? String(p.other_requests)     : f.other_requests,
        property_memo:      f.property_memo,
      };
      setParsedPreview(preview);
    } finally {
      setAddCondParsing(false);
    }
  };

  // 条件追加: 保存（テキストログ追記。alsoUpdateFields=trueのときは構造化フィールドも更新）
  const saveAddCond = async (alsoUpdateFields = false) => {
    if (!addCondId || !addCondText.trim() || addCondSaving) return;
    setAddCondSaving(true);
    try {
      const customer = customers.find((c) => c.id === addCondId);
      if (!customer) return;

      // 駅リストは raw行（生行）として保存 → 琥珀カードの「条件に反映する」ボタンが使えるようになる
      // 通常テキストは【追加】付きログ行として保存
      const logEntry = isStationList(addCondText)
        ? normalizeStationList(addCondText)
        : `【${formatLogDate()}追加】${addCondText.trim()}`;
      const existing = customer.additional_conditions?.trim() || "";
      const newAdditional = existing ? `${existing}\n${logEntry}` : logEntry;

      const patch: Record<string, unknown> = { id: addCondId, additional_conditions: newAdditional };

      // 「追加 + 条件タグも更新」ボタン経由の場合のみフィールドを更新（テキスト系は元の値に追記）
      if (alsoUpdateFields && parsedPreview) {
        const app = (orig: string | null | undefined, add: string) => orig ? `${orig}、${add}` : add;
        if (parsedPreview.desired_area)       patch.desired_area       = app(customer.desired_area, parsedPreview.desired_area);
        if (parsedPreview.floor_plan)         patch.floor_plan         = parsedPreview.floor_plan;
        if (parsedPreview.rent_min)           patch.rent_min           = Number(parsedPreview.rent_min) * 10000;
        if (parsedPreview.rent_max)           patch.rent_max           = Number(parsedPreview.rent_max) * 10000;
        if (parsedPreview.walk_minutes)       patch.walk_minutes       = Number(parsedPreview.walk_minutes);
        if (parsedPreview.move_in_time)       patch.move_in_time       = parsedPreview.move_in_time;
        if (parsedPreview.building_age)       patch.building_age       = Number(parsedPreview.building_age);
        if (parsedPreview.floor_area_min)     patch.floor_area_min     = Number(parsedPreview.floor_area_min);
        if (parsedPreview.initial_cost_limit) patch.initial_cost_limit = Number(parsedPreview.initial_cost_limit) * 10000;
        if (parsedPreview.preferences)        patch.preferences        = app(customer.preferences, parsedPreview.preferences);
        if (parsedPreview.ng_points)          patch.ng_points          = app(customer.ng_points, parsedPreview.ng_points);
        if (parsedPreview.other_requests)     patch.other_requests     = app(customer.other_requests, parsedPreview.other_requests);
      }

      const res = await fetch("/api/property-customers", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const updated = await res.json();
        setCustomers((p) => p.map((c) => c.id === addCondId ? { ...c, ...updated } : c));
        // 条件追加後: 紐付き客はAI要約を自動再生成
        const addedC = customers.find((c) => c.id === addCondId);
        if (addedC?.is_linked) void generateSummary({ ...addedC, ...updated } as Customer);
      }
      setAddCondId(null); setAddCondText(""); setParsedPreview(null);
    } finally {
      setAddCondSaving(false);
    }
  };

  const generateSummary = async (c: Customer) => {
    setSummaryLoading((prev) => new Set(prev).add(c.id));
    try {
      const res = await fetch("/api/customer-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_id:           c.id,
          customer_name:         c.customer_name,
          status:                c.status,
          desired_area:          c.desired_area,
          floor_plan:            c.floor_plan,
          floor_area_min:        c.floor_area_min,
          rent_min:              c.rent_min,
          rent_max:              c.rent_max,
          walk_minutes:          c.walk_minutes,
          move_in_time:          c.move_in_time,
          building_age:          c.building_age,
          initial_cost_limit:    c.initial_cost_limit,
          preferences:           c.preferences,
          ng_points:             c.ng_points,
          other_requests:        c.other_requests,
          property_memo:         c.property_memo,
          additional_conditions: c.additional_conditions,
          property_send_count:   c.property_send_count,
          last_message:          c.linked_conversation?.last_message,
          last_message_sender:   c.linked_conversation?.last_sender,
          conversation_id:       c.linked_conversation?.id ?? null,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { summary: string; summaryJson?: SummaryJson | null };
        if (data.summary) setSummaries((prev) => ({ ...prev, [c.id]: data.summary }));
        if (data.summaryJson) setSummaryJsons((prev) => ({ ...prev, [c.id]: data.summaryJson! }));
        const generatedAt = new Date().toISOString();
        setCustomers((prev) => prev.map((cust) => cust.id === c.id ? { ...cust, ai_summary_at: generatedAt } : cust));
      }
    } finally {
      setSummaryLoading((prev) => { const s = new Set(prev); s.delete(c.id); return s; });
    }
  };

  // 🏠 物件比較: 画像をcanvasでリサイズ（長辺1200px超は縮小・JPEG品質0.85）
  const resizeImage = (file: File, maxSize = 1200): Promise<{ base64: string; mediaType: string }> => {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const { width, height } = img;
        const scale = Math.min(1, maxSize / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
        resolve({ base64, mediaType: "image/jpeg" });
      };
      img.src = url;
    });
  };

  // 🏠 物件比較: 画像アップロード（リサイズ→base64変換・最大5件）
  const handlePropImageUpload = async (customerId: string, files: FileList) => {
    const current = propCompareImages[customerId] ?? [];
    const remain = 5 - current.length;
    if (remain <= 0) return;
    const toAdd = Array.from(files).slice(0, remain);
    const converted = await Promise.all(
      toAdd.map(async (file, i) => {
        const { base64, mediaType } = await resizeImage(file);
        const preview = `data:${mediaType};base64,${base64}`;
        return { base64, mediaType, label: `物件${current.length + i + 1}`, preview };
      })
    );
    setPropCompareImages((prev) => ({
      ...prev,
      [customerId]: [...(prev[customerId] ?? []), ...converted].slice(0, 5),
    }));
  };

  // 🏠 物件比較: 指定indexの画像を削除
  const handlePropImageRemove = (customerId: string, index: number) => {
    setPropCompareImages((prev) => ({
      ...prev,
      [customerId]: (prev[customerId] ?? []).filter((_, i) => i !== index),
    }));
  };

  // 🔍 リアプロ自動スクレイプ比較
  // 優先: webapp-bridge → axlx-scrape-and-compare（拡張側でresolve: popupと同等）
  // フォールバック: Supabase automation_commands 経由（拡張なし・ACK未着時）
  const handleScrapeCompare = async (c: Customer, isWide: boolean = false) => {
    const key = isWide ? `${c.id}-wide` : c.id;
    const cur = scrapeCompareStatus[key] ?? "idle";
    if (cur === "queued" || cur === "running" || cur === "noext") return;
    setScrapeCompareStatus((prev) => ({ ...prev, [key]: "queued" }));
    setScrapeCompareErrors((prev) => { const next = { ...prev }; delete next[key]; return next; });

    const scheduleIdle = (finalStatus: ScrapeCompareStatus) => {
      setScrapeCompareStatus((prev) => ({ ...prev, [key]: finalStatus }));
      const t = setTimeout(() => {
        scrapeIdleTimeoutsRef.current.delete(t);
        setScrapeCompareStatus((prev) => ({ ...prev, [key]: "idle" }));
      }, 4000);
      scrapeIdleTimeoutsRef.current.add(t);
    };

    // 拡張へ渡す生の顧客条件（resolve は拡張側で実施 = popupと同等）
    const rawConditions = {
      area_mode:    getAreaMode(c.id),
      rent_max:     c.rent_max      ?? null,
      rent_min:     c.rent_min      ?? null,
      walk_minutes: c.walk_minutes  ?? null,
      floor_plan:   c.floor_plan    ?? null,
      building_age: c.building_age  ?? null,
      area_min:     c.floor_area_min ?? parseAreaMin(c.floor_plan) ?? parseAreaMin(c.preferences) ?? parseAreaMin(c.other_requests) ?? null,
      area_max:     c.floor_area_max ?? null,
      pet_ok:       resolvePetOk(c),
      desired_area: c.desired_area  ?? null,
      lines:        c.lines         ?? [] as string[],
      stations:     c.stations      ?? [] as string[],
      structure_types: parseStructureTypes(c.preferences, c.other_requests),
      rp_update_days:  c.rp_update_days ?? calcRpUpdateDays(c.last_property_sent_at),
      is_wide:      isWide,
    };

    // ① 拡張への直接送信 → 1.5秒以内にACKが返れば直接パスで完結
    const ackReceived = await new Promise<boolean>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data?.from === "aixlinx-webapp-scrape-ack" && String(e.data?.customerId) === String(c.id)) {
          window.removeEventListener("message", handler);
          resolve(true);
        }
      };
      window.addEventListener("message", handler);
      window.postMessage({ from: "aixlinx-webapp-scrape", customerId: c.id, customerName: c.customer_name, isWide, conditions: rawConditions }, "*");
      setTimeout(() => { window.removeEventListener("message", handler); resolve(false); }, 1500);
    });

    if (ackReceived) {
      // ② 拡張直接パス: autofill→スクレイプ→LINE送信の完了を待つ（最大6分）
      setScrapeCompareStatus((prev) => ({ ...prev, [key]: "running" }));
      const result = await new Promise<{ ok: boolean; count?: number; error?: string }>((resolve) => {
        const handler = (e: MessageEvent) => {
          if (e.data?.from === "aixlinx-webapp-scrape-result" && String(e.data?.customerId) === String(c.id)) {
            window.removeEventListener("message", handler);
            resolve({ ok: !!e.data.ok, count: e.data.count, error: e.data.error });
          }
        };
        window.addEventListener("message", handler);
        setTimeout(() => { window.removeEventListener("message", handler); resolve({ ok: false, error: "timeout" }); }, 6 * 60_000);
      });
      if (result.ok) {
        scheduleIdle("done");
      } else {
        if (result.error) setScrapeCompareErrors((prev) => ({ ...prev, [key]: result.error!.slice(0, 200) }));
        scheduleIdle(result.error === "timeout" ? "timeout" : "error");
      }
      return;
    }

    // ③ フォールバック: Supabase automation_commands + Realtime broadcast（スマホ対応）
    // broadcast で拡張ツールが即時受信 → 30秒ポーリング待ちを解消。polling は backup として存続。
    try {
      let resolved: ResolvedSearchConditions | null = null;
      if (c.desired_area?.trim() || (c.lines?.length ?? 0) > 0 || (c.stations?.length ?? 0) > 0) {
        try {
          const res = await fetch("/api/resolve-search-conditions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ desired_area: c.desired_area ?? "", lines: c.lines ?? [], stations: c.stations ?? [], is_wide: isWide, rent_max: c.rent_max ?? null, building_age: c.building_age ?? null }),
          });
          if (res.ok) {
            resolved = await res.json() as ResolvedSearchConditions;
            if (resolved.unknown_tokens?.length) {
              fetch("/api/token-resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokens: resolved.unknown_tokens }) }).catch(() => {});
            }
          }
        } catch (e) { console.error("[handleScrapeCompare] resolve失敗:", e); }
      }

      const { data: inserted, error } = await supabase
        .from("automation_commands")
        .insert({
          command_type: "scrape_and_compare",
          payload: {
            customer_id: c.id, customer_name: c.customer_name, is_wide: isWide,
            conditions: {
              area_mode: getAreaMode(c.id),
              rent_max: c.rent_max ?? undefined,
              rent_min: c.rent_min ?? undefined,
              walk_minutes: c.walk_minutes ?? undefined,
              floor_plan: c.floor_plan ?? undefined,
              building_age: c.building_age ?? undefined,
              area_min: c.floor_area_min ?? parseAreaMin(c.floor_plan) ?? parseAreaMin(c.preferences) ?? parseAreaMin(c.other_requests) ?? undefined,
              area_max: c.floor_area_max ?? undefined,
              pet_ok: resolvePetOk(c),
              desired_area: c.desired_area ?? undefined,
              lines: c.lines ?? [], stations: c.stations ?? [],
              city_codes: resolved?.city_codes ?? [], station_names: resolved?.station_names ?? [],
              route_ids: resolved?.route_ids ?? [], itandi_line_names: resolved?.itandi_line_names ?? [],
              reins_line_names: resolved?.reins_line_names ?? [], detail_ward: resolved?.detail_ward ?? null,
              detail_area: resolved?.detail_area ?? null, unknown_tokens: resolved?.unknown_tokens ?? [],
              structure_types: parseStructureTypes(c.preferences, c.other_requests), rp_update_days: c.rp_update_days ?? calcRpUpdateDays(c.last_property_sent_at),
            },
          },
          status: "pending", created_at: new Date().toISOString(),
        })
        .select("id").single();
      if (error || !inserted) throw error ?? new Error("insert failed");

      window.postMessage({ from: "aixlinx-webapp-poll-now" }, "*");

      const cmdId = (inserted as { id: string | number }).id;
      const startedAt = Date.now();

      // ── Supabase Realtime broadcast: ext-results を購読して結果をリアルタイム受信 ──
      let sbResultDone = false;
      const resultCh = supabase.channel("ext-results");
      scrapeResultChannelsRef.current.add(resultCh);
      resultCh.on("broadcast", { event: "scrape_result" }, (event: { payload?: { customerId?: string; ok?: boolean; error?: string } }) => {
        if (sbResultDone) return;
        if (String(event.payload?.customerId) !== String(c.id)) return;
        sbResultDone = true;
        scrapeResultChannelsRef.current.delete(resultCh);
        supabase.removeChannel(resultCh).catch(() => {});
        if (event.payload?.ok) {
          scheduleIdle("done");
        } else {
          const em = event.payload?.error ?? "";
          if (em) setScrapeCompareErrors((prev) => ({ ...prev, [key]: em.slice(0, 200) }));
          scheduleIdle("error");
        }
      }).subscribe();

      // ── ext-commands broadcast で拡張ツールに即時配信（SW が起きていれば 30秒待ちを回避）──
      void (async () => {
        try {
          const cmdCh = supabase.channel("ext-commands");
          await new Promise<void>((res) => {
            cmdCh.subscribe((st) => { if (st === "SUBSCRIBED") res(); });
          });
          await cmdCh.send({
            type: "broadcast",
            event: "scrape_command",
            payload: {
              customerId: c.id, customerName: c.customer_name, isWide,
              commandId: cmdId,
              conditions: {
                ...rawConditions,
                city_codes: resolved?.city_codes ?? [], station_names: resolved?.station_names ?? [],
                route_ids: resolved?.route_ids ?? [], itandi_line_names: resolved?.itandi_line_names ?? [],
                reins_line_names: resolved?.reins_line_names ?? [],
              },
            },
          });
          await supabase.removeChannel(cmdCh);
          console.log("[WS] ext-commands broadcast 送信完了 customerId=" + c.id);
        } catch (e) {
          console.warn("[WS] broadcast 失敗（polling で継続）:", e);
        }
      })();

      // ── 既存の 5秒ポーリング（broadcast で処理できなかった場合のバックアップ）──
      const timer = setInterval(() => {
        void (async () => {
          const finish = (finalStatus: ScrapeCompareStatus) => {
            clearInterval(timer); scrapePollIntervalsRef.current.delete(timer);
            if (!sbResultDone) {
              sbResultDone = true;
              scrapeResultChannelsRef.current.delete(resultCh);
              supabase.removeChannel(resultCh).catch(() => {});
              scheduleIdle(finalStatus);
            }
          };
          try {
            const elapsed = Date.now() - startedAt;
            const { data } = await supabase.from("automation_commands").select("status, error_message").eq("id", cmdId).maybeSingle();
            const st = (data?.status as string | undefined) ?? null;
            if (st === "running") { setScrapeCompareStatus((prev) => ({ ...prev, [key]: "running" })); }
            else if (st === "done" || st === "completed") { finish("done"); return; }
            else if (st === "error") {
              const em = (data?.error_message as string | undefined) ?? "";
              if (em) setScrapeCompareErrors((prev) => ({ ...prev, [key]: em.slice(0, 200) }));
              finish("error"); return;
            } else if (st === "pending" && elapsed > 90_000) { finish("noext"); return; }
            else if (st === "pending" && elapsed > 60_000) { setScrapeCompareStatus((prev) => ({ ...prev, [key]: "noext" })); }
            if (Date.now() - startedAt > 6 * 60_000) finish("timeout");
          } catch { /* 一時的な取得失敗は無視 */ }
        })();
      }, 5000);
      scrapePollIntervalsRef.current.add(timer);
    } catch (e) {
      console.error("[handleScrapeCompare]", e);
      setScrapeCompareStatus((prev) => ({ ...prev, [key]: "error" }));
      const t = setTimeout(() => { scrapeIdleTimeoutsRef.current.delete(t); setScrapeCompareStatus((prev) => ({ ...prev, [key]: "idle" })); }, 4000);
      scrapeIdleTimeoutsRef.current.add(t);
    }
  };

  // 🏠 物件比較: /api/recommend-property に画像を送って比較実行
  const handlePropCompare = async (customerId: string) => {
    const images = propCompareImages[customerId] ?? [];
    if (images.length === 0 || propCompareLoading) return;
    setPropCompareLoading(customerId);
    try {
      const res = await fetch("/api/recommend-property", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId,
          images: images.map((img) => ({ base64: img.base64, mediaType: img.mediaType, label: img.label })),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        alert(`物件比較に失敗しました: ${err?.error ?? res.status}`);
        return;
      }
      const data = await res.json() as PropCompareResult;
      setPropCompareResults((prev) => ({ ...prev, [customerId]: data }));
    } catch (e) {
      console.error("[handlePropCompare] failed:", e);
      alert("物件比較に失敗しました（通信エラー）");
    } finally {
      setPropCompareLoading(null);
    }
  };

  // HIGH-05: キャッシュチェックを削除（毎回最新を取得）。エラー時は空配列＋エラー表示。
  // ロード中は loadingMsgs で管理し、ボタンを押したときだけローディング表示する。
  const loadMessages = async (customerId: string, conversationId: string) => {
    setLoadingMsgs(p => new Set(p).add(customerId));
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("id, text, sender, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      setMsgCache(p => ({ ...p, [customerId]: ((data ?? []) as Array<{ id: string; text: string | null; sender: string; created_at: string }>).reverse() }));
      setMsgErrors(p => { const s = new Set(p); s.delete(customerId); return s; });
    } catch {
      setMsgCache(p => ({ ...p, [customerId]: [] }));
      setMsgErrors(p => new Set(p).add(customerId));
    } finally {
      setLoadingMsgs(p => { const s = new Set(p); s.delete(customerId); return s; });
    }
  };

  // ── ボックスセルタップ: リストモードに切り替えてカード展開・スクロール ──
  const handleBoxCellTap = (c: Customer) => {
    setViewMode("list");
    setExpandedId(c.id);
    setTimeout(() => {
      document.getElementById(`customer-card-${c.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
  };

  // ── 物件検索: PC同一ブラウザ向けpostMessage ──
  // resolvedConditions は /api/resolve-search-conditions で事前解決済みのフィールド群
  type ResolvedSearchConditions = {
    station_names: string[];
    route_ids: string[];           // リアプロ用 route_id
    itandi_line_names: string[];   // itandi 用路線名（正式形式）
    reins_line_names: string[];    // レインズ用路線名
    city_codes: string[];
    detail_ward: string | null;
    detail_area: string | null;
    unknown_tokens: string[];
    rent_max_resolved?: number | null;
    building_age_resolved?: number | null;
    is_wide?: boolean;
  };

  // 修正6: 戻り値を Promise<boolean> に変更。
  // webapp-bridge.js（Chrome拡張）が postMessage を受領すると即時に
  // { from: "aixlinx-webapp-received" } を返すため、それを1.5秒待って
  // 「同一ブラウザに拡張が存在し処理を引き受けたか」を判定する。
  const firePropertySearch = (
    c: Customer,
    sites: string[] = ["realnetpro", "itandi"],
    isWide: boolean = false,
    areaMode?: "ward" | "station" | "auto",
  ): Promise<boolean> => {
    // ACKリスナーは postMessage 発火前に登録しておく
    const ackPromise = new Promise<boolean>((resolve) => {
      let settled = false;
      const onAck = (e: MessageEvent) => {
        const d = e.data as { from?: string } | null;
        if (d?.from === "aixlinx-webapp-received" && !settled) {
          settled = true;
          window.removeEventListener("message", onAck);
          resolve(true);
        }
      };
      window.addEventListener("message", onAck);
      setTimeout(() => {
        if (!settled) {
          settled = true;
          window.removeEventListener("message", onAck);
          resolve(false);
        }
      }, 1500);
    });

    // 拡張ツール側に同じ顧客リストがあるため customerId だけ送れば十分
    // 条件の解決（エリア→コード変換等）は background.js 側で実施する
    const conditions = {
      customerId:   String(c.id),
      customerName: c.customer_name ?? null,
      is_wide:      isWide,
      area_mode:    areaMode ?? getAreaMode(c.id),
    };
    let delay = 0;
    for (const site of sites) {
      const s = site;
      if (delay === 0) {
        window.postMessage({ from: "aixlinx-webapp", site: s, conditions }, "*");
      } else {
        setTimeout(() => window.postMessage({ from: "aixlinx-webapp", site: s, conditions }, "*"), delay);
      }
      delay += 3000;
    }
    return ackPromise;
  };

  // ── スマホ→PC遠隔物件検索: automationキュー経由 ──
  // スマホから押してもPCのChrome拡張（30秒ポーリング）が処理する
  const [searchQueued, setSearchQueued] = useState<string | null>(null);
  // 修正11: キュー投入失敗を消えない赤色エラーとして保持（キー: c.id + "-" + site [+ "-wide"]）
  const [queueErrors, setQueueErrors] = useState<Record<string, string>>({});
  const queuePropertySearch = async (c: Customer, sites: string[] = ["realnetpro", "itandi"], isWide: boolean = false) => {
    // 拡張ツールには生データをそのまま渡す（拡張側で resolve-search-conditions を実行するため事前変換不要）
    // webapp で事前変換すると拡張側と二重変換になりバグの原因になる
    const extHandled = await firePropertySearch(c, sites, isWide);

    const key = c.id + "-" + sites[0] + (isWide ? "-wide" : "");
    setQueueErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    if (extHandled) {
      // 修正6: 同一ブラウザの拡張が処理を引き受けた → キュー投入をスキップして
      // 即時経路+キュー経路の二重実行（検索・AI採点・LINE送信が2回）を防ぐ
      setSearchQueued(key);
      setTimeout(() => setSearchQueued(null), 3000);
      return;
    }

    // クロスデバイス対応（拡張未検出時のみ）: サーバー経由でキューに追加
    try {
      const res = await fetch("/api/automation/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 修正5: is_wide をキューへ伝搬（trigger API が payload.is_wide として保存）
        // area_mode: 地域/駅モードもキュー経路へ伝搬（"auto"=従来の自動判定）
        body: JSON.stringify({ customer_ids: [c.id], sites, is_wide: isWide, area_mode: getAreaMode(c.id), force: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSearchQueued(key);
      setTimeout(() => setSearchQueued(null), 3000);
    } catch (e) {
      console.error("[queue search] error:", e);
      // 修正11: 従来は無音失敗。消えない赤色エラー表示に変更（再押下でクリア）
      setQueueErrors((prev) => ({
        ...prev,
        [key]: "検索依頼の送信に失敗しました。通信環境を確認して再度お試しください。",
      }));
    }
  };

  // 要対応一括検索用: エリア/駅の有無に応じて自動モード判定し発火
  // 両方ある場合は ward で発火後、5秒後に station でも自動発火する
  const fireFlaggedSearch = (c: Customer) => {
    const hasArea = !!(c.desired_area?.trim());
    const hasStation = !!(c.stations?.length);
    if (hasArea && hasStation) {
      void firePropertySearch(c, ["realnetpro", "itandi"], false, "ward");
      setTimeout(() => { void firePropertySearch(c, ["realnetpro", "itandi"], false, "station"); }, 5000);
    } else {
      const mode = getAutoAreaMode(c);
      void firePropertySearch(c, ["realnetpro", "itandi"], false, mode);
    }
  };

  const startBatchSearch = async () => {
    const isFlagged = filterMode === "flagged";
    batchIsFlaggedRef.current = isFlagged;
    if (!isFlagged) setFilterMode("linked");
    const targets = sorted.filter((c) => !isDoneToday(c));
    batchListRef.current = targets;
    setBatchIndex(0);
    setBatchMode(true);
    if (targets.length > 0) {
      // 全員まとめてキューに追加（30秒以内にPC Chrome拡張が処理開始）
      try {
        await fetch("/api/automation/trigger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customer_ids: targets.map((c) => c.id), sites: ["realnetpro", "itandi"], force: true }),
        });
      } catch (e) {
        console.error("[batch trigger] error:", e);
      }
      if (isFlagged) {
        fireFlaggedSearch(targets[0]);
      } else {
        void firePropertySearch(targets[0]);
      }
    }
  };

  const goNextBatch = () => {
    const next = batchIndex + 1;
    if (next >= batchListRef.current.length) {
      setBatchMode(false);
      setBatchIndex(0);
      setBatchDone(true);
      setTimeout(() => setBatchDone(false), 4000);
      return;
    }
    setBatchIndex(next);
    const nextCustomer = batchListRef.current[next];
    if (batchIsFlaggedRef.current) {
      fireFlaggedSearch(nextCustomer);
    } else {
      void firePropertySearch(nextCustomer);
    }
  };

  const goPrevBatch = () => {
    const prev = batchIndex - 1;
    if (prev < 0) return;
    setBatchIndex(prev);
    const prevCustomer = batchListRef.current[prev];
    if (batchIsFlaggedRef.current) {
      fireFlaggedSearch(prevCustomer);
    } else {
      void firePropertySearch(prevCustomer);
    }
  };

  // タイムアウト/エラー/拡張なし → 1秒後にステータスをidleにリセット（すぐ別のお客さんを検索できるようにする）
  useEffect(() => {
    const terminalKeys = Object.entries(scrapeCompareStatus)
      .filter(([, st]) => st === "timeout" || st === "error" || st === "noext")
      .map(([k]) => k);
    if (terminalKeys.length === 0) return;
    const t = setTimeout(() => {
      setScrapeCompareStatus((prev) => {
        const next = { ...prev };
        for (const k of terminalKeys) {
          if (next[k] === "timeout" || next[k] === "error" || next[k] === "noext") {
            next[k] = "idle";
          }
        }
        return next;
      });
    }, 1000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrapeCompareStatus]);

  return (
    <div className="flex flex-col" style={{ height: "100svh", background: "#f0f2f5", overflowY: "auto" }}>

      {/* ── Header ── */}
      <div
        className="sticky top-0 z-30 px-4 pb-3"
        style={{ background: "linear-gradient(135deg, #0d1b3e 0%, #1565C0 100%)", paddingTop: "max(env(safe-area-inset-top), 14px)" }}
      >
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[18px] font-black text-white tracking-tight">お客さん</span>
            {replyCount > 0 && (
              <span className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
                未返信 {replyCount}件
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAixPanel(true)}
              className="rounded-xl border border-white/30 px-3 py-1.5 text-xs font-bold text-white active:opacity-70"
              style={{ background: "rgba(255,255,255,0.13)" }}
            >
              AIX
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="rounded-xl border border-white/30 px-3 py-1.5 text-xs font-bold text-white active:opacity-70"
              style={{ background: "rgba(255,255,255,0.13)" }}
            >
              ＋ 追加
            </button>
          </div>
        </div>

        {/* フィルター */}
        <div className="flex gap-2 mb-2 flex-wrap">
          <button
            onClick={() => setFilterMode("linked")}
            className={`rounded-full px-3 py-1.5 text-xs font-bold transition-all ${filterMode === "linked" ? "bg-white text-[#1565C0]" : "border border-white/25 text-white/70"}`}
          >
            紐付き {linkedCount}
          </button>
          <button
            onClick={() => setFilterMode("urgent")}
            className={`rounded-full px-3 py-1.5 text-xs font-bold transition-all ${filterMode === "urgent" ? "bg-orange-400 text-white" : "border border-white/25 text-white/70"}`}
          >
            🚨 未送信 {urgentCount}
          </button>
          <button
            onClick={() => setFilterMode("applying")}
            className={`rounded-full px-3 py-1.5 text-xs font-bold transition-all ${filterMode === "applying" ? "bg-pink-400 text-white" : "border border-white/25 text-white/70"}`}
          >
            申込以降 {applyingCount}
          </button>
          <button
            onClick={() => setFilterMode("all")}
            className={`rounded-full px-3 py-1.5 text-xs font-bold transition-all ${filterMode === "all" ? "bg-white text-[#1565C0]" : "border border-white/25 text-white/70"}`}
          >
            全員 {customers.filter((c) => !isApplying(c.status)).length}
          </button>
          <button
            onClick={() => setFilterMode("flagged")}
            className={`rounded-full px-3 py-1.5 text-xs font-bold transition-all ${filterMode === "flagged" ? "bg-red-500 text-white" : "border border-white/25 text-white/70"}`}
          >
            🔥 要対応 {flaggedCount}
          </button>
        </div>

        {/* バッチ物件検索バナー（batchMode中のみ表示） */}
        {batchMode && batchListRef.current.length > 0 && (() => {
          const cur = batchListRef.current[batchIndex];
          const curStatus = cur ? (scrapeCompareStatus[cur.id] ?? "idle") : "idle";
          const isAutoAdvancing = curStatus === "timeout" || curStatus === "error" || curStatus === "noext";
          return (
            <div
              className="flex items-center gap-2 rounded-xl px-3 py-2 mb-2"
              style={{ background: isAutoAdvancing ? "rgba(239,68,68,0.35)" : "rgba(255,255,255,0.18)", border: `1px solid ${isAutoAdvancing ? "rgba(239,68,68,0.6)" : "rgba(255,255,255,0.3)"}` }}
            >
              <span className="flex-1 text-white text-sm font-bold truncate min-w-0">
                {isAutoAdvancing ? "⚠️ タイムアウト — 別のお客さんを選んで検索できます" : `🔍 ${cur?.customer_name ?? ""}`}
              </span>
              <span className="text-white/70 text-xs font-bold shrink-0">
                {batchIndex + 1}/{batchListRef.current.length}
              </span>
              <button
                onClick={goPrevBatch}
                disabled={batchIndex === 0}
                className="rounded-lg px-2.5 py-1 text-xs font-bold text-white disabled:opacity-30 active:scale-95 transition-transform"
                style={{ background: "rgba(255,255,255,0.15)" }}
              >
                ←
              </button>
              <button
                onClick={goNextBatch}
                className="rounded-lg px-2.5 py-1 text-xs font-bold text-white active:scale-95 transition-transform"
                style={{ background: "rgba(255,255,255,0.3)" }}
              >
                {batchIndex + 1 >= batchListRef.current.length ? "完了" : "次へ →"}
              </button>
              <button
                onClick={() => { setBatchMode(false); setBatchIndex(0); }}
                className="rounded-lg px-1.5 py-1 text-[11px] text-white/60 active:scale-95"
              >
                ✕
              </button>
            </div>
          );
        })()}

        {/* 検索欄 + ビュー切り替えボタン + バッチ起動ボタン */}
        <div className="flex items-center gap-2">
          {/* 検索欄（flex-1） */}
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-white/50" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              placeholder="お客さんを検索..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl py-2 pl-8 pr-3 text-sm text-white placeholder-white/50 outline-none"
              style={{ background: "rgba(255,255,255,0.15)" }}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 text-xs">✕</button>
            )}
          </div>

          {/* ボックスビュー切り替えボタン */}
          <button
            onClick={() => setViewMode((v) => v === "box" ? "list" : "box")}
            className="shrink-0 h-9 w-9 rounded-xl flex items-center justify-center active:scale-95 transition-transform"
            style={{ background: viewMode === "box" ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.15)" }}
            title={viewMode === "box" ? "リスト表示" : "ボックス表示"}
          >
            {viewMode === "box" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1565C0" strokeWidth="2.5" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1"/>
                <rect x="14" y="3" width="7" height="7" rx="1"/>
                <rect x="3" y="14" width="7" height="7" rx="1"/>
                <rect x="14" y="14" width="7" height="7" rx="1"/>
              </svg>
            )}
          </button>

          {/* バッチ物件検索起動ボタン（紐付きタブのみ・バッチ非実行中のみ） */}
          {(filterMode === "linked" || filterMode === "flagged") && !batchMode && (
            <button
              onClick={startBatchSearch}
              className="shrink-0 h-9 rounded-xl px-2.5 flex items-center justify-center text-[11px] font-bold text-white active:scale-95 transition-transform"
              style={{ background: "rgba(251,146,60,0.6)", border: "1px solid rgba(251,146,60,0.4)" }}
              title="紐付き顧客を順番に物件検索"
            >
              一括
            </button>
          )}
        </div>
      </div>

      {/* ── 完了セクション ── */}
      {!loading && completedList.length > 0 && (
        <div className="mx-3 mt-2.5">
          <button
            onClick={() => setShowCompleted((v) => !v)}
            className="flex w-full items-center justify-between rounded-2xl border border-[#e9edef] bg-white px-4 py-2.5 shadow-sm active:bg-[#f5f6f6]"
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold text-[#111b21]">完了</span>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                {completedList.length}件
              </span>
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#90caf9" strokeWidth="2" strokeLinecap="round"
              className={`transition-transform duration-200 ${showCompleted ? "rotate-180" : ""}`}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {showCompleted && (
            <div className="mt-1 space-y-1">
              {completedList.map((c) => {
                const conv = c.linked_conversation;
                const { sent, viewed } = completedToday(c);
                const isExp = expandedId === c.id;
                const condLines = c.additional_conditions
                  ? c.additional_conditions.split("\n").map(parseConditionLog)
                  : [];
                return (
                  <div key={c.id} className="rounded-2xl overflow-hidden" style={{ border: "1.5px solid #e9edef", background: "#fff" }}>
                    {/* ヘッダー行 */}
                    <button
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left active:bg-[#f5f6f6]"
                      onClick={() => setExpandedId(isExp ? null : c.id)}
                    >
                      <div className="shrink-0">
                        {conv?.profile_image_url ? (
                          <img src={conv.profile_image_url} alt={c.customer_name} className="h-9 w-9 rounded-full object-cover" />
                        ) : (
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#d9fdd3] text-sm font-bold text-[#0f8f44]">
                            {initial(c.customer_name)}
                          </div>
                        )}
                      </div>
                      <span className="flex-1 truncate text-[13px] font-semibold text-[#111b21]">{c.customer_name}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {sent && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">物件送った</span>}
                        {viewed && <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-700">物件確認済</span>}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#90caf9" strokeWidth="2" strokeLinecap="round"
                          className={`transition-transform duration-200 ${isExp ? "rotate-180" : ""}`}>
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </div>
                    </button>

                    {/* 展開時：条件 + 編集ボタン */}
                    {isExp && (
                      <>
                        <div className="border-t border-[#f0f2f5] px-4 py-2.5">
                          {(c.desired_area || c.floor_plan || c.rent_min || c.rent_max || c.walk_minutes || c.move_in_time || c.initial_cost_limit || c.preferences || c.ng_points) ? (
                            <>
                              <div className="flex flex-wrap gap-1.5 mb-1.5">
                                {c.desired_area && <Tag label="エリア" value={c.desired_area} />}
                                {c.floor_plan   && <Tag label="間取り" value={c.floor_plan} />}
                                {(c.rent_min || c.rent_max) && <Tag label="家賃" value={`${c.rent_min ? Math.floor(c.rent_min/10000)+"万〜" : "〜"}${c.rent_max ? Math.floor(c.rent_max/10000)+"万" : ""}`} />}
                                {c.walk_minutes && <Tag label="徒歩" value={`${c.walk_minutes}分`} />}
                                {c.move_in_time && <Tag label="入居" value={c.move_in_time} />}
                                {c.initial_cost_limit && <Tag label="初期" value={`${Math.floor(c.initial_cost_limit/10000)}万以内`} />}
                              </div>
                              {c.preferences && <p className="text-[11px] text-[#555] mb-0.5"><span className="font-semibold text-[#8696a0]">希望　</span>{c.preferences}</p>}
                              {c.ng_points    && <p className="text-[11px] text-[#555]"><span className="font-semibold text-[#8696a0]">NG　　</span>{c.ng_points}</p>}
                            </>
                          ) : (
                            condLines.length === 0 && <p className="text-[11px] text-[#bbb]">条件未入力</p>
                          )}
                          {condLines.length > 0 && (
                            <div className="mt-1.5 space-y-1">
                              {condLines.slice(-3).map((line, i) => {
                                const txt = summarizeCondContent(line.content);
                                if (!txt) return null;
                                return <p key={i} className={`text-[11px] leading-snug ${line.isLog ? "text-[#90caf9]" : "text-[#555]"}`}>{txt}</p>;
                              })}
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2 border-t border-[#f0f2f5] bg-[#fafafa] px-4 py-2">
                          <button
                            onClick={() => openEdit(c)}
                            className="rounded-xl border border-[#d1d7db] bg-white px-3 py-1.5 text-xs font-bold text-[#444] active:scale-95 transition-transform"
                          >条件更新</button>
                          <button
                            onClick={() => { setAddCondId(c.id); setAddCondText(""); setParsedPreview(null); }}
                            className="rounded-xl border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-bold text-purple-700 active:scale-95 transition-transform"
                          >＋ 条件追加</button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── List / Box ── */}
      <div className="flex-1 pb-28">
        {loading ? (
          <div className="py-16 text-center text-sm text-[#667781]">読み込み中...</div>
        ) : viewMode === "box" ? (
          /* ── ボックスグリッドビュー ── */
          <div className="pb-4">
            {boxGroups.length === 0 ? (
              <div className="py-16 text-center text-sm text-[#667781]">お客さんがいません</div>
            ) : (
              boxGroups.map((group) => (
                <div key={group.label}>
                  {/* 月グループヘッダー */}
                  <div className="px-4 pt-4 pb-1.5">
                    <span className="text-[11px] font-bold text-[#667781] tracking-wide">{group.label}</span>
                    <span className="ml-1.5 text-[10px] text-[#8696a0]">{group.customers.length}人</span>
                  </div>
                  {/* 4列グリッド */}
                  <div className="grid px-4 gap-2" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
                    {group.customers.map((c) => {
                      const u = urgency(c);
                      const conv = c.linked_conversation;
                      const borderColor = u === "reply" ? "#ef4444" : u === "property" ? "#f97316" : "#e9edef";
                      const bgColor     = u === "reply" ? "#fef2f2"  : u === "property" ? "#fff7ed"  : "#fff";
                      return (
                        <button
                          key={c.id}
                          onClick={() => handleBoxCellTap(c)}
                          className="flex flex-col items-center gap-1 rounded-2xl p-1.5 active:scale-95 transition-transform"
                          style={{ background: bgColor, border: `1.5px solid ${borderColor}` }}
                        >
                          {/* アバター */}
                          <div className="relative shrink-0">
                            {conv?.profile_image_url ? (
                              <img
                                src={conv.profile_image_url}
                                alt={c.customer_name}
                                className="h-14 w-14 rounded-full object-cover"
                              />
                            ) : (
                              <div className="h-14 w-14 rounded-full flex items-center justify-center bg-[#d9fdd3] text-[#1565C0] font-bold text-lg">
                                {initial(c.customer_name)}
                              </div>
                            )}
                            {/* 緊急バッジ */}
                            {(u === "reply" || u === "property") && (
                              <span
                                className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-white flex items-center justify-center"
                                style={{ background: u === "reply" ? "#ef4444" : "#f97316" }}
                              >
                                <span className="text-[7px] text-white font-black">!</span>
                              </span>
                            )}
                          </div>
                          {/* 名前（6文字上限） */}
                          <span
                            className="text-[10px] font-bold text-[#111b21] w-full text-center leading-tight"
                            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          >
                            {c.customer_name.length > 6 ? c.customer_name.slice(0, 6) + "…" : c.customer_name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : sorted.length === 0 ? (
          <div className="py-16 text-center text-sm text-[#667781]">
            {searchQuery ? "検索結果なし" : filterMode === "urgent" ? "物件送信が必要なお客さんはいません" : filterMode === "linked" ? "紐付き済みのお客さんがいません" : filterMode === "applying" ? "申込以降のお客さんはいません" : "お客さんがいません"}
          </div>
        ) : (
          sorted.map((c) => {
            const u        = urgency(c);
            const conv     = c.linked_conversation;
            const propMeta = PROP_STATUS[c.status] ?? { label: c.status, dot: "bg-gray-300" };
            const isExp    = expandedId === c.id;
            const days     = c.last_property_sent_at
              ? Math.floor((Date.now() - new Date(c.last_property_sent_at).getTime()) / 86400000)
              : null;

            const borderColor = u === "reply" ? "#ef4444" : u === "property" ? "#f97316" : "#e9edef";

            // 条件ログを解析（追加日つきエントリを分離して表示）
            const condLines = c.additional_conditions
              ? c.additional_conditions.split("\n").map(parseConditionLog)
              : [];

            return (
              <div id={`customer-card-${c.id}`} key={c.id} className="mx-3 mt-2.5 rounded-2xl overflow-hidden shadow-sm"
                style={{ border: `1.5px solid ${borderColor}`, background: "#fff" }}>

                {/* ── ヘッダー行 ── */}
                <button
                  className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-[#f5f6f6]"
                  onClick={() => {
                    if (longPressActivated.current) { longPressActivated.current = false; return; }
                    setExpandedId(isExp ? null : c.id);
                  }}
                  onPointerDown={(e) => {
                    longPressStartPos.current = { x: e.clientX, y: e.clientY };
                    longPressTimer.current = setTimeout(() => {
                      longPressActivated.current = true;
                      setStatusMenuId(c.id);
                      longPressTimer.current = null;
                    }, 500);
                  }}
                  onPointerMove={(e) => {
                    if (!longPressTimer.current || !longPressStartPos.current) return;
                    const dx = e.clientX - longPressStartPos.current.x;
                    const dy = e.clientY - longPressStartPos.current.y;
                    if (Math.sqrt(dx * dx + dy * dy) > 8) {
                      clearTimeout(longPressTimer.current);
                      longPressTimer.current = null;
                    }
                  }}
                  onPointerUp={() => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } }}
                  onPointerCancel={() => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } }}
                >
                  <div
                    className="relative shrink-0"
                    onClick={(e) => {
                      if (!conv?.id) return;
                      e.stopPropagation();
                      window.location.href = `/?conv=${conv.id}`;
                    }}
                    style={{ cursor: conv?.id ? "pointer" : "default" }}
                  >
                    {conv?.profile_image_url ? (
                      <img src={conv.profile_image_url} alt={c.customer_name}
                        className="h-12 w-12 rounded-full object-cover ring-2 ring-transparent active:ring-blue-300 transition-all" />
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#d9fdd3] text-base font-bold text-[#0f8f44] active:opacity-70 transition-opacity">
                        {initial(c.customer_name)}
                      </div>
                    )}
                    <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white ${propMeta.dot}`} />
                    {conv?.id && (
                      <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#1565C0] text-[7px] font-bold text-white">
                        LINE
                      </span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                      <span className="text-[14px] font-bold text-[#111b21] truncate">{c.customer_name}</span>
                      {conv?.account && (
                        <span className="shrink-0 rounded-full bg-[#e9edef] px-1.5 py-0.5 text-[9px] font-bold text-[#667781]">
                          {ACCT_LABEL[conv.account] ?? conv.account}
                        </span>
                      )}
                      <span className="shrink-0 text-[9px] font-semibold text-[#8696a0]">{propMeta.label}</span>
                      {u === "property" && (
                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${days === null || days === undefined ? "bg-red-100 text-red-600" : days >= 7 ? "bg-red-100 text-red-600" : "bg-orange-100 text-orange-600"}`}>
                          {days === null || days === undefined ? "未送信" : `${days}日未送信`}
                        </span>
                      )}
                      {summaryJsons[c.id]?.inspection?.done && (
                        <span className="shrink-0 rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-bold text-blue-700">
                          🏠内覧済
                        </span>
                      )}
                    </div>
                    {conv?.last_message ? (
                      <p className={`truncate text-[12px] ${u === "reply" ? "font-semibold text-red-500" : "text-[#667781]"}`}>
                        {conv.last_message}
                      </p>
                    ) : (
                      <p className="text-[12px] text-[#bbb]">メッセージなし</p>
                    )}
                  </div>

                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <span className="text-[10px] text-[#667781]">{relTime(conv?.updated_at)}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#90caf9" strokeWidth="2" strokeLinecap="round"
                      className={`transition-transform duration-200 ${isExp ? "rotate-180" : ""}`}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </button>

                {/* ── 物件条件 / 申込以降情報 ── */}
                {isApplying(c.status) ? (
                  /* 申込以降：AIサマリー・社内メモ・担当者を表示 */
                  <div className="border-t border-[#f0f2f5] px-4 py-2.5 space-y-1.5">
                    {c.ai_summary ? (
                      <div>
                        <p className={`text-[11px] text-[#555] leading-relaxed ${expandedApplyingIds.has(c.id) ? "whitespace-pre-wrap" : "line-clamp-3"}`}>
                          <span className="font-semibold text-[#8696a0]">AI分析　</span>{c.ai_summary}
                        </p>
                        <button
                          onClick={(e) => { e.stopPropagation(); setExpandedApplyingIds((prev) => { const s = new Set(prev); s.has(c.id) ? s.delete(c.id) : s.add(c.id); return s; }); }}
                          className="mt-0.5 text-[9px] text-blue-400 active:opacity-60"
                        >
                          {expandedApplyingIds.has(c.id) ? "▲ 閉じる" : "▼ 続きを見る"}
                        </button>
                      </div>
                    ) : (
                      <p className="text-[11px] text-[#bbb]">AIサマリーなし</p>
                    )}
                    {c.property_memo && (
                      <p className="text-[11px] text-[#555]">
                        <span className="font-semibold text-[#8696a0]">社内メモ　</span>{c.property_memo}
                      </p>
                    )}
                    {c.assignee && (
                      <p className="text-[11px] text-[#555]">
                        <span className="font-semibold text-[#8696a0]">担当者　　</span>{c.assignee}
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    {/* 物件探し中：条件チップ */}
                    <div className="border-t border-[#f0f2f5] px-4 py-2.5">
                      {/* 元の条件 */}
                      {(c.desired_area || c.floor_plan || c.floor_area_min || c.floor_area_max || c.pet != null || c.rent_min || c.rent_max || c.walk_minutes || c.move_in_time || c.building_age || c.initial_cost_limit || c.preferences || c.ng_points) ? (
                        <>
                          {condLines.length > 0 && (
                            <p className="text-[9px] font-bold text-[#8696a0] mb-1 tracking-wide">元の条件</p>
                          )}
                          <div className="flex flex-wrap gap-1.5">
                            {c.desired_area && <Tag label="エリア" value={c.desired_area} />}
                            {c.floor_plan   && <Tag label="間取り" value={c.floor_plan} />}
                            {(c.floor_area_min || c.floor_area_max) && (
                              <Tag label="広さ" value={
                                c.floor_area_min && c.floor_area_max ? `${c.floor_area_min}〜${c.floor_area_max}㎡`
                                : c.floor_area_min ? `${c.floor_area_min}㎡以上`
                                : `〜${c.floor_area_max}㎡`
                              } />
                            )}
                            {c.pet === true && <Tag label="ペット" value="飼育あり" />}
                            {c.pet === false && <Tag label="ペット" value="なし" />}
                            {(c.rent_min || c.rent_max) && (
                              <Tag label="家賃" value={`${c.rent_min ? Math.floor(c.rent_min/10000)+"万〜" : "〜"}${c.rent_max ? Math.floor(c.rent_max/10000)+"万" : ""}`} />
                            )}
                            {c.walk_minutes && <Tag label="徒歩" value={`${c.walk_minutes}分`} />}
                            {c.move_in_time && <Tag label="入居" value={c.move_in_time} />}
                            {c.building_age && <Tag label="築年" value={`${c.building_age}年`} />}
                            {c.initial_cost_limit && <Tag label="初期" value={`${Math.floor(c.initial_cost_limit/10000)}万以内`} />}
                          </div>
                          {(c.preferences || c.ng_points) && (
                            <div className="mt-1.5 space-y-0.5">
                              {c.preferences && (
                                <p className="text-[11px] text-[#555]">
                                  <span className="font-semibold text-[#8696a0]">希望　</span>{c.preferences}
                                </p>
                              )}
                              {c.ng_points && (
                                <p className="text-[11px] text-[#555]">
                                  <span className="font-semibold text-[#8696a0]">NG　　</span>{c.ng_points}
                                </p>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        condLines.length === 0 && <p className="text-[11px] text-[#bbb]">条件未入力</p>
                      )}

                      {/* 追加・変更履歴 */}
                      {condLines.length > 0 && (() => {
                        const isExpanded = expandedCondIds.has(c.id);
                        const MAX = 3;
                        const displayed = condLines.length > MAX && !isExpanded
                          ? condLines.slice(-MAX)
                          : condLines;
                        const hiddenCount = condLines.length - MAX;
                        return (
                          <div className="mt-2 space-y-1.5">
                            <p className="text-[9px] font-bold text-[#8696a0] tracking-wide">追加・変更履歴</p>
                            {condLines.length > MAX && !isExpanded && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setExpandedCondIds(prev => { const s = new Set(prev); s.add(c.id); return s; }); }}
                                className="w-full text-center text-[10px] text-blue-500 font-semibold py-1 active:opacity-60"
                              >
                                ▲ 過去{hiddenCount}件を見る
                              </button>
                            )}
                            {displayed.map((entry, i) =>
                              entry.isLog ? (
                                entry.isAutoReflected ? (
                                  // 自動反映ログ（青緑）
                                  <div key={i} className="rounded-xl border border-teal-100 bg-teal-50 px-3 py-2">
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[10px] font-bold text-teal-600">🤖 {entry.date} 自動反映済み</span>
                                    </div>
                                    <p className="text-[11px] text-teal-800 leading-relaxed">{summarizeCondContent(entry.content)}</p>
                                  </div>
                                ) : entry.isReflected ? (
                                  // 反映済みログ（緑）
                                  <div key={i} className="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2">
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[10px] font-bold text-emerald-600">✅ {entry.date} 反映済み</span>
                                    </div>
                                    <p className="text-[11px] text-emerald-800 leading-relaxed">{summarizeCondContent(entry.content)}</p>
                                  </div>
                                ) : (
                                  // 追加ログ（青）
                                  <div key={i} className="rounded-xl border border-blue-100 bg-blue-50 px-3 py-2">
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[10px] font-bold text-blue-600">📌 {entry.date} 追加</span>
                                    </div>
                                    <p className="text-[11px] text-blue-800 leading-relaxed">{summarizeCondContent(entry.content)}</p>
                                  </div>
                                )
                              ) : (
                                // 新着要望（琥珀）
                                <div key={i} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                                  <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] font-bold text-amber-700">新着要望</span>
                                    <div className="flex items-center gap-1.5">
                                      <button
                                        onClick={(e) => { e.stopPropagation(); void handleReplace(c, entry.content); }}
                                        disabled={!!reflectLoading}
                                        className="rounded-lg border border-amber-500 bg-amber-50 px-2.5 py-1 text-[10px] font-bold text-amber-700 active:opacity-70 disabled:opacity-50"
                                      >
                                        {reflectLoading === c.id ? "解析中…" : "入れ替える"}
                                      </button>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); void handleReflect(c, entry.content); }}
                                        disabled={!!reflectLoading}
                                        className="rounded-lg bg-amber-600 px-2.5 py-1 text-[10px] font-bold text-white active:opacity-70 disabled:opacity-50"
                                      >
                                        追加する
                                      </button>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); clearAdditional(c.id); }}
                                        className="text-[9px] text-amber-400 active:opacity-60"
                                      >
                                        クリア
                                      </button>
                                    </div>
                                  </div>
                                  <p className="text-[11px] text-amber-800 leading-relaxed">{summarizeCondContent(entry.content)}</p>
                                </div>
                              )
                            )}
                            {condLines.length > MAX && isExpanded && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setExpandedCondIds(prev => { const s = new Set(prev); s.delete(c.id); return s; }); }}
                                className="w-full text-center text-[10px] text-[#8696a0] font-semibold py-1 active:opacity-60"
                              >
                                ▼ 閉じる
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {/* ── AI要約（構造化カード） ── */}
                    {(summaryJsons[c.id] || summaries[c.id]) && (() => {
                      const sj = summaryJsons[c.id];
                      const isExpanded = expandedSummaryIds.has(c.id);
                      const tab = activeTabs[c.id] ?? "summary";
                      const convId = conv?.id;
                      return (
                        <div className="border-t border-purple-100" style={{ background: "linear-gradient(to bottom, #faf5ff, #fefeff)" }}>
                          <button
                            className="flex w-full items-center justify-between px-4 py-2 active:opacity-70"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedSummaryIds((prev) => {
                                const s = new Set(prev);
                                s.has(c.id) ? s.delete(c.id) : s.add(c.id);
                                return s;
                              });
                            }}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-[10px] font-bold text-purple-400 tracking-wide flex-shrink-0">✨ AI状況</span>
                              {sj?.situation && (
                                <span className="text-[10px] text-purple-600 font-medium truncate">{sj.situation}</span>
                              )}
                              {c.ai_summary_at && <span className="text-[9px] text-purple-300 flex-shrink-0 ml-auto mr-1">{relTime(c.ai_summary_at)}</span>}
                            </div>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#c084fc" strokeWidth="2.5" strokeLinecap="round"
                              className={`transition-transform duration-200 flex-shrink-0 ${isExpanded ? "rotate-180" : ""}`}>
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>
                          {isExpanded && (
                            <>
                              {/* タブ切替 */}
                              <div className="flex border-b border-purple-100 mx-4">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setActiveTabs(p => ({ ...p, [c.id]: "summary" })); }}
                                  className={`px-3 py-1.5 text-xs font-medium ${tab !== "log" ? "border-b-2 border-blue-500 text-blue-600" : "text-gray-400"}`}
                                >✨ AI要約</button>
                                {convId && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setActiveTabs(p => ({ ...p, [c.id]: "log" })); void loadMessages(c.id, convId); }}
                                    className={`px-3 py-1.5 text-xs font-medium ${tab === "log" ? "border-b-2 border-blue-500 text-blue-600" : "text-gray-400"}`}
                                  >💬 会話ログ</button>
                                )}
                              </div>
                              {tab !== "log" ? (
                                <div className="px-4 pb-3 pt-2 space-y-1.5">
                                  {sj ? (
                                    <>
                                      {/* 内覧 */}
                                      {sj.inspection && (
                                        <div className="flex items-start gap-1.5">
                                          <span className="text-[11px] flex-shrink-0">🏠</span>
                                          <div className="min-w-0">
                                            <span className="text-[11px] font-semibold text-gray-500">内覧: </span>
                                            <span className="text-[11px] text-gray-700">
                                              {sj.inspection.requested
                                                ? (sj.inspection.done ? "済み" : "希望あり")
                                                : "なし"}
                                              {sj.inspection.properties && sj.inspection.properties.length > 0 && (
                                                <span className="text-purple-600"> → {sj.inspection.properties.join("・")}</span>
                                              )}
                                            </span>
                                          </div>
                                        </div>
                                      )}
                                      {/* 見積 */}
                                      {sj.estimate?.requested && (
                                        <div className="flex items-start gap-1.5">
                                          <span className="text-[11px] flex-shrink-0">💴</span>
                                          <span className="text-[11px] font-semibold text-gray-500">見積: </span>
                                          <span className="text-[11px] text-gray-700">希望あり</span>
                                        </div>
                                      )}
                                      {/* 要望 */}
                                      {sj.requirements && sj.requirements.length > 0 && (
                                        <div className="flex items-start gap-1.5">
                                          <span className="text-[11px] flex-shrink-0">📋</span>
                                          <div className="min-w-0">
                                            <span className="text-[11px] font-semibold text-gray-500">要望: </span>
                                            <span className="text-[11px] text-gray-700">{sj.requirements.join(" · ")}</span>
                                          </div>
                                        </div>
                                      )}
                                      {/* 意見・タイプ */}
                                      {sj.opinions && sj.opinions.length > 0 && (
                                        <div className="flex items-start gap-1.5">
                                          <span className="text-[11px] flex-shrink-0">💬</span>
                                          <div className="min-w-0">
                                            <span className="text-[11px] font-semibold text-gray-500">意見: </span>
                                            <span className="text-[11px] text-gray-700">{sj.opinions.join(" · ")}</span>
                                          </div>
                                        </div>
                                      )}
                                      {/* こちらのアクション */}
                                      {sj.our_actions && sj.our_actions.length > 0 && (
                                        <div className="flex items-start gap-1.5">
                                          <span className="text-[11px] flex-shrink-0">📤</span>
                                          <div className="min-w-0">
                                            <span className="text-[11px] font-semibold text-gray-500">アクション: </span>
                                            <span className="text-[11px] text-gray-700">{sj.our_actions.join(" → ")}</span>
                                          </div>
                                        </div>
                                      )}
                                      {/* 決まるパターン */}
                                      {sj.winning_pattern && (
                                        <div className="mt-2 rounded-lg bg-red-50 border border-red-200 px-2.5 py-1.5">
                                          <span className="text-[10px] font-bold text-red-500">★ 決まるパターン: </span>
                                          <span className="text-[11px] text-red-700 font-medium">{sj.winning_pattern}</span>
                                        </div>
                                      )}
                                      {/* 次のアクション */}
                                      {sj.next_action && (
                                        <div className="rounded-lg bg-amber-50 border border-amber-300 px-2.5 py-1.5">
                                          <span className="text-[10px] font-bold text-amber-600">🎯 次のアクション: </span>
                                          <span className="text-[11px] text-amber-800 font-medium">{sj.next_action}</span>
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    /* 旧テキスト形式のフォールバック */
                                    <p className="text-[12px] text-[#333] whitespace-pre-line leading-relaxed">{summaries[c.id]}</p>
                                  )}
                                </div>
                              ) : (
                                /* 会話ログ（改善13: 自動スクロール・日付セパレータ・送信者ラベル） */
                                <div className="px-4 pb-3 pt-2">
                                  <div
                                    ref={(el) => {
                                      // マウント時（タブを開いた瞬間）は即座に最下部へ。以降の更新はuseEffect側が担当
                                      const prevEl = msgLogRefs.current[c.id];
                                      msgLogRefs.current[c.id] = el;
                                      if (el && el !== prevEl) el.scrollTop = el.scrollHeight;
                                    }}
                                    className="space-y-1 max-h-60 overflow-y-auto"
                                  >
                                    {loadingMsgs.has(c.id) && msgCache[c.id] === undefined
                                      ? <p className="text-xs text-gray-400 text-center py-4">読み込み中...</p>
                                      : msgErrors.has(c.id)
                                        ? (
                                          <div className="text-center py-4">
                                            <p className="text-xs text-gray-400">⚠️ メッセージを取得できませんでした</p>
                                            <p className="text-[10px] text-gray-300 mt-0.5">通信状況を確認して再度お試しください</p>
                                            {convId && (
                                              <button
                                                onClick={(e) => { e.stopPropagation(); void loadMessages(c.id, convId); }}
                                                className="mt-2 rounded-lg border border-gray-200 bg-white px-3 py-1 text-[11px] font-medium text-gray-500 active:opacity-70"
                                              >再読み込み</button>
                                            )}
                                          </div>
                                        )
                                        : (msgCache[c.id] ?? []).length === 0
                                        ? (
                                          <div className="text-center py-4">
                                            <p className="text-xs text-gray-400">💬 まだメッセージがありません</p>
                                            <p className="text-[10px] text-gray-300 mt-0.5">LINEでやり取りが始まるとここに表示されます</p>
                                          </div>
                                        )
                                        : msgCache[c.id].map((msg, i, arr) => {
                                            const d = new Date(msg.created_at);
                                            const prevD = i > 0 ? new Date(arr[i - 1].created_at) : null;
                                            // 日付（年/月/日）が変わったタイミングでセパレータを表示
                                            const showDate = !prevD
                                              || prevD.getFullYear() !== d.getFullYear()
                                              || prevD.getMonth() !== d.getMonth()
                                              || prevD.getDate() !== d.getDate();
                                            // 送信者が切り替わった（または日付が変わった）ときだけラベルを表示
                                            const showSender = showDate || arr[i - 1].sender !== msg.sender;
                                            const isCustomer = msg.sender === "customer";
                                            const dateLabel = `${d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}/` : ""}${d.getMonth() + 1}/${d.getDate()}`;
                                            return (
                                              <div key={msg.id}>
                                                {showDate && (
                                                  <div className="text-center text-[10px] text-gray-400 my-1">{dateLabel}</div>
                                                )}
                                                {showSender && (
                                                  <div className={`text-[9px] text-gray-400 mb-0.5 ${isCustomer ? "text-left pl-1" : "text-right pr-1"}`}>
                                                    {isCustomer ? "お客様" : "スタッフ"}
                                                  </div>
                                                )}
                                                <div className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}>
                                                  <div className={`max-w-[75%] rounded-lg px-2 py-1 text-xs whitespace-pre-wrap break-words ${
                                                    isCustomer ? "bg-gray-100 text-gray-800" : "bg-blue-100 text-blue-800"
                                                  }`}>
                                                    {msg.text ?? "（画像）"}
                                                  </div>
                                                </div>
                                              </div>
                                            );
                                          })
                                    }
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })()}
                  </>
                )}

                {/* ── アクション行 ── */}
                <div className="flex items-center gap-2 border-t border-[#f0f2f5] bg-[#fafafa] px-4 py-2 flex-wrap">
                  {c.status !== "pending" && !isApplying(c.status) && (
                    <button
                      onClick={() => markSent(c.id)}
                      disabled={sentUpdating === c.id}
                      className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 active:scale-95 transition-transform disabled:opacity-50"
                    >
                      {sentUpdating === c.id ? "…" : "物件送った"}
                    </button>
                  )}
                  {c.status !== "pending" && !isApplying(c.status) && (
                    <button
                      onClick={() => markViewed(c.id)}
                      disabled={viewedUpdating === c.id}
                      className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 active:scale-95 transition-transform disabled:opacity-50"
                    >
                      {viewedUpdating === c.id ? "…" : "物件確認した"}
                    </button>
                  )}
                  {/* 物件検索ボタン（サイト別3ペア: 通常 + 広） */}
                  {c.status !== "pending" && !isApplying(c.status) && (
                    <div className="flex gap-1.5 flex-wrap">
                      {/* 地域/駅モード切替（3セグメントピル・6ボタン共通・セッション内のみ有効） */}
                      <div
                        className="flex items-center self-start overflow-hidden rounded-xl border border-gray-200 bg-white"
                        title="地域で検索 or 駅で検索（リアプロ/itandi/レインズ共通）"
                      >
                        {([["auto", "自動"], ["ward", "地域"], ["station", "駅"]] as const).map(([m, lbl]) => (
                          <button
                            key={m}
                            onClick={() => {
                              setAreaModeByCustomer((prev) => ({ ...prev, [c.id]: m }));
                              fetch("/api/property-customers", {
                                method: "PATCH", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ id: c.id, area_mode: m }),
                              }).catch(() => {});
                            }}
                            className={`px-1.5 py-1.5 text-[10px] font-bold transition-colors ${
                              getAreaMode(c.id) === m
                                ? "bg-blue-600 text-white"
                                : "bg-white text-gray-400"
                            }`}
                          >
                            {lbl}
                          </button>
                        ))}
                      </div>
                      {/* リアプロ（修正11: 状態表示 + 実行中の連打ガード。広は c.id+"-wide" で状態分離） */}
                      {(() => {
                        const stN = scrapeCompareStatus[c.id] ?? "idle";
                        const stW = scrapeCompareStatus[c.id + "-wide"] ?? "idle";
                        // 修正: noext（⚠️PC拡張未起動?）表示中も disabled にして重複INSERTを防ぐ
                        const busy = (s: ScrapeCompareStatus) => s === "queued" || s === "running" || s === "noext";
                        const errMsg = scrapeCompareErrors[c.id] ?? scrapeCompareErrors[c.id + "-wide"] ?? null;
                        const label = (s: ScrapeCompareStatus, idle: string) =>
                          s === "queued" ? "⏳ 依頼中…"
                          : s === "running" ? "実行中…"
                          : s === "done" ? "✅ LINE送信済み"
                          : s === "noext" ? "⚠️ PC拡張未起動?"
                          : s === "error" ? "❌ エラー"
                          : s === "timeout" ? "⏰ タイムアウト"
                          : idle;
                        // 状態別カラー（done=緑 / error=赤 / timeout・noext=オレンジ強調）
                        const tone = (s: ScrapeCompareStatus, base: string) =>
                          s === "done" ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                          : s === "error" ? "border-red-300 bg-red-50 text-red-600"
                          : s === "timeout" || s === "noext" ? "border-amber-400 bg-amber-50 text-amber-700"
                          : base;
                        return (
                          <div className="flex flex-col gap-0.5">
                            <div className="flex gap-0.5">
                              <button
                                onClick={() => void handleScrapeCompare(c, false)}
                                disabled={busy(stN)}
                                className={`rounded-xl border px-2.5 py-1.5 text-[11px] font-bold active:scale-95 transition-transform disabled:opacity-50 ${tone(stN, "border-orange-200 bg-orange-50 text-orange-700")}`}
                              >
                                {label(stN, "🖥️ リアプロ")}
                              </button>
                              <button
                                onClick={() => void handleScrapeCompare(c, true)}
                                disabled={busy(stW)}
                                className={`rounded-xl border px-2 py-1 text-[10px] font-bold active:scale-95 transition-transform disabled:opacity-50 ${tone(stW, "border-orange-300 bg-orange-100 text-orange-600")}`}
                              >
                                {label(stW, "↔️ 広")}
                              </button>
                            </div>
                            {errMsg && (
                              <div className="max-w-[280px] break-words text-[10px] leading-tight text-red-600">
                                {errMsg}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {/* itandi */}
                      <div className="flex gap-0.5">
                        <button
                          onClick={() => void queuePropertySearch(c, ["itandi"])}
                          className="rounded-xl border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[11px] font-bold text-blue-700 active:scale-95 transition-transform"
                        >
                          {searchQueued === c.id + "-itandi" ? "✓" : "🖥️"} itandi
                        </button>
                        <button
                          onClick={() => void queuePropertySearch(c, ["itandi"], true)}
                          className="rounded-xl border border-blue-300 bg-blue-100 px-2 py-1 text-[10px] font-bold text-blue-600 active:scale-95 transition-transform"
                        >
                          {searchQueued === c.id + "-itandi-wide" ? "✓" : "↔️"} 広
                        </button>
                      </div>
                      {/* レインズ */}
                      <div className="flex gap-0.5">
                        <button
                          onClick={() => void queuePropertySearch(c, ["reins"])}
                          className="rounded-xl border border-purple-200 bg-purple-50 px-2.5 py-1.5 text-[11px] font-bold text-purple-600 active:scale-95 transition-transform"
                        >
                          {searchQueued === c.id + "-reins" ? "✓" : "🖥️"} レインズ
                        </button>
                        <button
                          onClick={() => void queuePropertySearch(c, ["reins"], true)}
                          className="rounded-xl border border-purple-300 bg-purple-100 px-2 py-1 text-[10px] font-bold text-purple-500 active:scale-95 transition-transform"
                        >
                          {searchQueued === c.id + "-reins-wide" ? "✓" : "↔️"} 広
                        </button>
                      </div>
                    </div>
                  )}
                  {/* 更新日フィルター（自動計算 or アプリで上書き） */}
                  {c.status !== "pending" && !isApplying(c.status) && (() => {
                    const autoVal = calcRpUpdateDays(c.last_property_sent_at);
                    const manualVal = c.rp_update_days ?? null;
                    const displayVal = manualVal ?? autoVal;
                    const isAuto = manualVal === null;
                    return (
                      <button
                        onClick={() => void cycleRpUpdateDays(c)}
                        disabled={updateDaysUpdating === c.id}
                        title="タップで更新日を切替（1/3/7/14日・autoで自動計算）"
                        className={`rounded-xl border px-2.5 py-1.5 text-[10px] font-bold active:scale-95 transition-transform disabled:opacity-50 ${isAuto ? "border-gray-200 bg-gray-50 text-gray-500" : "border-amber-300 bg-amber-50 text-amber-700"}`}
                      >
                        {updateDaysUpdating === c.id ? "…" : displayVal ? `更新${displayVal}日${isAuto ? "▸" : "✎"}` : `更新-${isAuto ? "▸" : "✎"}`}
                      </button>
                    );
                  })()}
                  {/* 修正11: キュー投入失敗の消えない赤色エラー表示 */}
                  {Object.entries(queueErrors)
                    .filter(([k]) => k.startsWith(c.id + "-"))
                    .map(([k, msg]) => (
                      <div key={k} className="w-full text-[10px] font-bold text-red-600">
                        ⚠️ {msg}
                      </div>
                    ))}
                  {/* 物件探しフォーマットボタン: LINEの原文を表示 */}
                  {c.linked_conversation?.id && (
                    <button
                      onClick={async () => {
                        const convId = c.linked_conversation!.id;
                        setFormatMsgLoading(c.id);
                        try {
                          const res = await fetch(`/api/messages?conversation_id=${convId}`);
                          const data = await res.json() as { ok: boolean; text: string | null };
                          setFormatMsgModal({ text: data.text ?? "フォーマット文が見つかりませんでした" });
                        } finally {
                          setFormatMsgLoading(null);
                        }
                      }}
                      disabled={formatMsgLoading === c.id}
                      className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-bold text-gray-600 active:scale-95 transition-transform disabled:opacity-50"
                      title="お客様が送ったフォーマット文を表示"
                    >
                      {formatMsgLoading === c.id ? "…" : "📄 フォーマット"}
                    </button>
                  )}
                  <button
                    onClick={() => openEdit(c)}
                    className="rounded-xl border border-[#d1d7db] bg-white px-3 py-1.5 text-xs font-bold text-[#444] active:scale-95 transition-transform"
                  >
                    条件更新
                  </button>
                  {/* 条件追加ボタン */}
                  <button
                    onClick={() => { setAddCondId(c.id); setAddCondText(""); setParsedPreview(null); }}
                    className="rounded-xl border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-bold text-purple-700 active:scale-95 transition-transform"
                  >
                    ＋ 条件追加
                  </button>
                  {/* AI要約ボタン */}
                  <button
                    onClick={() => generateSummary(c)}
                    disabled={summaryLoading.has(c.id)}
                    className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-bold text-indigo-700 active:scale-95 transition-transform disabled:opacity-50"
                  >
                    {summaryLoading.has(c.id) ? "AI分析中…" : summaries[c.id] ? "✨ 再生成" : "✨ AI要約"}
                  </button>
                  {/* 物件比較ボタン */}
                  <button
                    onClick={() => setPropCompareOpen(propCompareOpen === c.id ? null : c.id)}
                    className="rounded-xl border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-bold text-green-700 active:scale-95 transition-transform"
                  >
                    🏠 物件比較
                  </button>
                  {c.phone && (
                    <a href={`tel:${c.phone}`}
                      className="rounded-xl border border-[#d1d7db] bg-white px-3 py-1.5 text-xs font-bold text-[#444] active:scale-95 transition-transform">
                      電話
                    </a>
                  )}
                  <div className="ml-auto text-[10px] text-[#8696a0]">
                    {days === null
                      ? (c.status !== "pending" ? <span className="text-orange-400 font-semibold">未送信</span> : null)
                      : days === 0 ? "今日送信"
                      : <span className={days >= 3 ? "text-red-400 font-semibold" : ""}>{days}日前</span>}
                  </div>
                </div>

                {/* ── 🏠 物件比較パネル ── */}
                {propCompareOpen === c.id && (() => {
                  const imgs = propCompareImages[c.id] ?? [];
                  const result = propCompareResults[c.id];
                  const comparing = propCompareLoading === c.id;
                  return (
                    <div className="mx-4 mt-2 mb-3 rounded-xl border border-green-200 bg-green-50 p-3">
                      <p className="text-xs font-bold text-green-800 mb-2">🏠 物件比較 — 画像をアップロード（最大5件）</p>
                      <label className="inline-block cursor-pointer rounded-lg border border-green-300 bg-white px-3 py-1.5 text-xs font-bold text-green-700 active:scale-95 transition-transform">
                        ＋ 画像を追加
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          disabled={imgs.length >= 5}
                          onChange={(e) => {
                            if (e.target.files && e.target.files.length > 0) {
                              handlePropImageUpload(c.id, e.target.files);
                            }
                            e.target.value = "";
                          }}
                        />
                      </label>
                      {imgs.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {imgs.map((img, i) => (
                            <div key={i} className="relative">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={img.preview} alt={img.label} className="w-16 h-16 object-cover rounded border border-green-200" />
                              <span className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[9px] text-center rounded-b">{img.label}</span>
                              <button
                                onClick={() => handlePropImageRemove(c.id, i)}
                                className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-gray-700 text-white text-[10px] leading-none flex items-center justify-center"
                                aria-label={`${img.label}を削除`}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <button
                        onClick={() => handlePropCompare(c.id)}
                        disabled={imgs.length === 0 || comparing}
                        className={`mt-2 block rounded-lg px-3 py-1.5 text-xs font-bold text-white active:scale-95 transition-transform ${
                          imgs.length === 0 || comparing ? "bg-gray-300" : "bg-green-600"
                        }`}
                      >
                        {comparing ? "AI比較中…" : "🔍 どれが一番合う？"}
                      </button>
                      {result && (
                        <div className="mt-3 space-y-1.5">
                          {result.best ? (
                            <div className="bg-white border-2 border-green-400 rounded-lg p-2">
                              <p className="text-xs font-bold text-green-800">🏆 {result.best.property_name} がおすすめ！</p>
                              <p className="text-[11px] text-gray-700 mt-0.5">{result.best.summary}</p>
                              {result.best.breakdown.length > 0 && (
                                <p className="text-[10px] text-gray-500 mt-1">
                                  内訳: {result.best.breakdown.map((b) => `${b.label}${b.point > 0 ? "✅" : "❌"}`).join(" ")}
                                </p>
                              )}
                            </div>
                          ) : (
                            <p className="text-[11px] text-red-500">条件に合う物件がありませんでした</p>
                          )}
                          {result.ranked.filter((r) => r.index !== result.best?.index).length > 0 && (
                            <>
                              <p className="text-[10px] font-bold text-gray-500">他の物件:</p>
                              {result.ranked
                                .filter((r) => r.index !== result.best?.index)
                                .map((r, i) => (
                                  <div key={r.index} className="bg-gray-50 border border-gray-200 rounded-lg p-1.5 text-xs">
                                    {r.hardNG ? (
                                      <span className="text-red-400 line-through">{r.property_name}</span>
                                    ) : (
                                      <span className="text-gray-700">{i + 2}位: {r.property_name}（{r.score}点）</span>
                                    )}
                                    {r.hardNG && <span className="ml-1 text-red-400 text-[10px] no-underline">NG: {r.hardNG}</span>}
                                  </div>
                                ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* ── 展開パネル ── */}
                {isExp && (
                  <div className="border-t border-[#f0f2f5] px-4 py-3 space-y-2.5">
                    {(c.property_memo || c.other_requests || c.assignee) && (
                      <div className="text-[11px] text-[#555] space-y-0.5">
                        {c.assignee       && <p><span className="font-semibold text-[#8696a0]">担当　　</span>{c.assignee}</p>}
                        {c.property_memo  && <p><span className="font-semibold text-[#8696a0]">メモ　　</span>{c.property_memo}</p>}
                        {c.other_requests && <p><span className="font-semibold text-[#8696a0]">その他　</span>{c.other_requests}</p>}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {(isApplying(c.status)
                        ? ["applying","screening","contract","closed_won","pending"]
                        : ["new_inquiry","hot","property_search","pending","applying"]
                      ).filter((s) => s !== c.status)
                        .map((s) => {
                          const m = PROP_STATUS[s];
                          return (
                            <button key={s}
                              onClick={async () => {
                                await fetch("/api/property-customers", { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({id:c.id, status:s}) });
                                setCustomers((p) => p.map((x) => x.id === c.id ? {...x, status:s} : x));
                                setExpandedId(null);
                              }}
                              className="rounded-xl border border-[#e9edef] bg-white px-3 py-1.5 text-xs font-bold text-[#555] active:scale-95 transition-transform"
                            >
                              {m.label}に変更
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ── ステータス変更シート（長押し） ── */}
      {statusMenuId && (() => {
        const target = customers.find((c) => c.id === statusMenuId);
        if (!target) return null;
        const options = isApplying(target.status)
          ? ["applying", "screening", "contract", "closed_won", "pending"]
          : ["new_inquiry", "hot", "property_search", "pending", "applying"];
        return (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
            onClick={() => setStatusMenuId(null)}
          >
            <div
              className="w-full max-w-md rounded-t-3xl bg-white pb-safe"
              style={{ paddingBottom: "max(env(safe-area-inset-bottom), 16px)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 pt-5 pb-3">
                <p className="text-[11px] font-bold text-[#8696a0] tracking-wide mb-1">ステータス変更</p>
                <p className="text-[15px] font-bold text-[#111b21]">{target.customer_name}</p>
              </div>
              <div className="flex flex-col divide-y divide-[#f0f2f5]">
                {options.filter((s) => s !== target.status).map((s) => {
                  const m = PROP_STATUS[s] ?? { label: s, dot: "bg-gray-300" };
                  return (
                    <button
                      key={s}
                      onClick={async () => {
                        await fetch("/api/property-customers", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ id: target.id, status: s }),
                        });
                        setCustomers((p) => p.map((x) => x.id === target.id ? { ...x, status: s } : x));
                        setStatusMenuId(null);
                      }}
                      className="flex items-center gap-3 px-5 py-4 text-left active:bg-[#f5f6f7]"
                    >
                      <span className={`h-3 w-3 rounded-full flex-shrink-0 ${m.dot}`} />
                      <span className="text-[15px] font-semibold text-[#111b21]">{m.label}</span>
                    </button>
                  );
                })}
              </div>
              <button
                onClick={async () => {
                  if (!confirm(`「${target.customer_name}」を削除しますか？`)) return;
                  await fetch(`/api/property-customers?id=${target.id}`, { method: "DELETE" });
                  setCustomers((p) => p.filter((x) => x.id !== target.id));
                  setStatusMenuId(null);
                }}
                className="mx-5 mt-3 mb-1 w-[calc(100%-2.5rem)] rounded-2xl bg-[#fff0f0] py-3.5 text-[14px] font-bold text-[#e53935] active:bg-[#ffd7d7]"
              >
                削除
              </button>
              <button
                onClick={() => setStatusMenuId(null)}
                className="mx-5 mt-1 mb-1 w-[calc(100%-2.5rem)] rounded-2xl bg-[#f0f2f5] py-3.5 text-[14px] font-bold text-[#667781] active:bg-[#e9edef]"
              >
                キャンセル
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── 条件編集モーダル ── */}
      {editId && editFields && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => { if (e.target === e.currentTarget) { setEditId(null); setEditFields(null); } }}>
          <div className="w-full rounded-t-2xl bg-white overflow-y-auto"
            style={{ maxHeight: "85svh", paddingBottom: "max(env(safe-area-inset-bottom),20px)" }}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#f0f2f5] sticky top-0 bg-white z-10">
              <div>
                <h2 className="font-bold text-[#111b21] text-[15px]">条件更新</h2>
                <p className="text-[11px] text-[#8696a0]">{customers.find((c) => c.id === editId)?.customer_name}</p>
              </div>
              <button onClick={() => { setEditId(null); setEditFields(null); }} className="text-[#aaa] text-xl leading-none">✕</button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <Field label="地域" placeholder="例: 城東区・東大阪市・摂津市"
                value={editFields.area_input} onChange={(v) => setEditFields((f) => f && ({ ...f, area_input: v }))} />
              <Field label="駅・路線" placeholder="例: 阪急京都線・梅田駅"
                value={editFields.station_input} onChange={(v) => setEditFields((f) => f && ({ ...f, station_input: v }))} />
              {/* 間取り バッジ選択 */}
              <div>
                <label className="text-[11px] font-semibold text-[#8696a0] mb-1.5 block">間取り（複数選択可）</label>
                <div className="flex flex-wrap gap-1.5">
                  {FLOOR_PLAN_OPTIONS.map((opt) => {
                    const isSelected = editFields.floor_plan.split(/[・、,\s]+/).includes(opt);
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => {
                          const curr = editFields.floor_plan.split(/[・、,\s]+/).filter((x) => (FLOOR_PLAN_OPTIONS as readonly string[]).includes(x));
                          const next = curr.includes(opt) ? curr.filter((x) => x !== opt) : [...curr, opt];
                          setEditFields((f) => f && ({ ...f, floor_plan: next.join("・") }));
                        }}
                        className={`text-[12px] font-bold px-3 py-1 rounded-full border transition-colors ${
                          isSelected ? "bg-[#1565C0] text-white border-[#1565C0]" : "bg-[#f8f9fa] text-[#333] border-[#e9edef]"
                        }`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* 敷礼なしバッジ */}
              <div>
                <label className="text-[11px] font-semibold text-[#8696a0] mb-1.5 block">敷金礼金</label>
                <button
                  type="button"
                  onClick={() => setEditFields((f) => f && ({ ...f, shikirei_free: !f.shikirei_free }))}
                  className={`text-[12px] font-bold px-4 py-1 rounded-full border transition-colors ${
                    editFields.shikirei_free ? "bg-[#1565C0] text-white border-[#1565C0]" : "bg-[#f8f9fa] text-[#333] border-[#e9edef]"
                  }`}
                >
                  {editFields.shikirei_free ? "敷礼なし ✓" : "敷礼なし"}
                </button>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Field label="㎡数 下限" placeholder="例: 25" type="number"
                    value={editFields.floor_area_min} onChange={(v) => setEditFields((f) => f && ({ ...f, floor_area_min: v }))} />
                </div>
                <div className="flex-1">
                  <Field label="㎡数 上限" placeholder="例: 50" type="number"
                    value={editFields.floor_area_max} onChange={(v) => setEditFields((f) => f && ({ ...f, floor_area_max: v }))} />
                </div>
              </div>
              <div>
                <label className="text-[11px] font-semibold text-[#8696a0] mb-1 block">ペット飼育</label>
                <select
                  value={editFields.pet}
                  onChange={(e) => setEditFields((f) => f && ({ ...f, pet: e.target.value }))}
                  className="w-full border border-[#e9edef] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#2196F3]"
                >
                  <option value="">未設定</option>
                  <option value="true">あり（ペット飼育している）</option>
                  <option value="false">なし</option>
                </select>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Field label="家賃 下限（万）" placeholder="5" type="number"
                    value={editFields.rent_min} onChange={(v) => setEditFields((f) => f && ({ ...f, rent_min: v }))} />
                </div>
                <div className="flex-1">
                  <Field label="家賃 上限（万）" placeholder="7" type="number"
                    value={editFields.rent_max} onChange={(v) => setEditFields((f) => f && ({ ...f, rent_max: v }))} />
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Field label="駅徒歩（分）" placeholder="15" type="number"
                    value={editFields.walk_minutes} onChange={(v) => setEditFields((f) => f && ({ ...f, walk_minutes: v }))} />
                </div>
                <div className="flex-1">
                  <Field label="築年数以内" placeholder="20" type="number"
                    value={editFields.building_age} onChange={(v) => setEditFields((f) => f && ({ ...f, building_age: v }))} />
                </div>
              </div>
              <Field label="入居時期" placeholder="例: 7月・なるべく早く"
                value={editFields.move_in_time} onChange={(v) => setEditFields((f) => f && ({ ...f, move_in_time: v }))} />
              <Field label="初期費用上限（万）" placeholder="30" type="number"
                value={editFields.initial_cost_limit} onChange={(v) => setEditFields((f) => f && ({ ...f, initial_cost_limit: v }))} />
              <Field label="こだわり" placeholder="例: オートロック・ペット可・駐車場あり" textarea
                value={editFields.preferences} onChange={(v) => setEditFields((f) => f && ({ ...f, preferences: v }))} />
              <Field label="NG条件" placeholder="例: 1階NG・木造NG" textarea
                value={editFields.ng_points} onChange={(v) => setEditFields((f) => f && ({ ...f, ng_points: v }))} />
              <Field label="メモ" placeholder="社内メモ" textarea
                value={editFields.property_memo} onChange={(v) => setEditFields((f) => f && ({ ...f, property_memo: v }))} />
              <Field label="その他" placeholder="その他の要望" textarea
                value={editFields.other_requests} onChange={(v) => setEditFields((f) => f && ({ ...f, other_requests: v }))} />
            </div>
            <div className="px-5">
              <button onClick={saveEdit} disabled={editSaving}
                className="w-full py-3 rounded-xl font-bold text-white text-sm disabled:opacity-40 active:scale-[0.98] transition-transform"
                style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
                {editSaving ? "保存中..." : "保存する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 条件追加モーダル ── */}
      {addCondId && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => { if (e.target === e.currentTarget) { setAddCondId(null); setAddCondText(""); setParsedPreview(null); setAddCondImage(null); setAddCondImagePreview(""); } }}>
          <div className="w-full rounded-t-2xl bg-white overflow-y-auto"
            style={{ maxHeight: "85svh", paddingBottom: "max(env(safe-area-inset-bottom),20px)" }}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#f0f2f5] sticky top-0 bg-white z-10">
              <div>
                <h2 className="font-bold text-[#111b21] text-[15px]">条件追加</h2>
                <p className="text-[11px] text-[#8696a0]">
                  {customers.find((c) => c.id === addCondId)?.customer_name} ・ {formatLogDate()}
                </p>
              </div>
              <button onClick={() => { setAddCondId(null); setAddCondText(""); setParsedPreview(null); setAddCondImage(null); setAddCondImagePreview(""); }} className="text-[#aaa] text-xl leading-none">✕</button>
            </div>
            <div className="px-5 py-4 space-y-3">
              {/* スクショアップロード */}
              <div>
                <label className="text-[11px] font-semibold text-[#8696a0] mb-1 block">
                  📎 スクショから読み取る（任意）
                </label>
                {addCondImagePreview ? (
                  <div className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={addCondImagePreview} alt="条件スクショ" className="w-full max-h-48 object-contain rounded-xl border border-[#e9edef] bg-[#f8f8f8]" />
                    <button
                      onClick={() => { setAddCondImage(null); setAddCondImagePreview(""); }}
                      className="absolute top-2 right-2 rounded-full bg-black/50 w-6 h-6 flex items-center justify-center text-white text-xs"
                    >✕</button>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center gap-1.5 w-full rounded-xl border-2 border-dashed border-[#c8b8ff] bg-[#faf5ff] py-4 cursor-pointer active:bg-[#f3e8ff] transition-colors">
                    <span className="text-2xl">🖼️</span>
                    <span className="text-[12px] font-semibold text-[#7c3aed]">スクショを選択</span>
                    <span className="text-[10px] text-[#8696a0]">LINEのやり取り・条件メモなど</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        if (file.size > 10 * 1024 * 1024) {
                          alert("10MB以内の画像を選択してください");
                          e.target.value = "";
                          return;
                        }
                        const reader = new FileReader();
                        reader.onload = () => {
                          const dataUrl = String(reader.result ?? "");
                          setAddCondImagePreview(dataUrl);
                          const [header, base64] = dataUrl.split(",");
                          const mediaType = header.match(/data:([^;]+)/)?.[1] ?? "image/jpeg";
                          setAddCondImage({ base64, mediaType });
                          setParsedPreview(null);
                        };
                        reader.readAsDataURL(file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>

              {/* テキスト入力 */}
              <div>
                <label className="text-[11px] font-semibold text-[#8696a0] mb-1 block">
                  追加する条件（自由に書いてOK）
                </label>
                <textarea
                  className="w-full border border-[#e9edef] rounded-xl px-3 py-2.5 text-sm text-[#111b21] focus:outline-none focus:border-[#7c3aed]"
                  rows={4}
                  placeholder={"例: 家賃を7万以内に変更\nオートロック必須になった\nエリアを大阪北区に絞る"}
                  value={addCondText}
                  onChange={(e) => { setAddCondText(e.target.value); setParsedPreview(null); }}
                  style={{ resize: "none" }}
                />
              </div>

              {/* AI自動解析ボタン */}
              <button
                onClick={parseAddCond}
                disabled={(!addCondText.trim() && !addCondImage) || addCondParsing}
                className="w-full py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform"
                style={{ background: "linear-gradient(135deg, #7c3aed, #a855f7)" }}
              >
                {addCondParsing ? "AI解析中..." : addCondImage ? "✨ スクショから条件を読み取る" : "✨ AIで自動解析"}
              </button>

              {/* AI解析結果プレビュー */}
              {parsedPreview && (
                <div className="rounded-xl border border-purple-100 bg-purple-50 px-4 py-3 space-y-1.5">
                  <p className="text-[11px] font-bold text-purple-700 mb-2">AI解析結果（自動入力）</p>
                  {parsedPreview.desired_area       && <PreviewRow label="エリア"   value={parsedPreview.desired_area} />}
                  {parsedPreview.floor_plan         && <PreviewRow label="間取り"   value={parsedPreview.floor_plan} />}
                  {parsedPreview.floor_area_min     && <PreviewRow label="広さ"     value={`${parsedPreview.floor_area_min}㎡以上`} />}
                  {parsedPreview.rent_min           && <PreviewRow label="家賃下限" value={`${parsedPreview.rent_min}万`} />}
                  {parsedPreview.rent_max           && <PreviewRow label="家賃上限" value={`${parsedPreview.rent_max}万`} />}
                  {parsedPreview.walk_minutes       && <PreviewRow label="駅徒歩"   value={`${parsedPreview.walk_minutes}分`} />}
                  {parsedPreview.move_in_time       && <PreviewRow label="入居"     value={parsedPreview.move_in_time} />}
                  {parsedPreview.building_age       && <PreviewRow label="築年数"   value={`${parsedPreview.building_age}年以内`} />}
                  {parsedPreview.initial_cost_limit && <PreviewRow label="初期費用" value={`${parsedPreview.initial_cost_limit}万以内`} />}
                  {parsedPreview.preferences        && <PreviewRow label="こだわり" value={parsedPreview.preferences} />}
                  {parsedPreview.ng_points          && <PreviewRow label="NG"       value={parsedPreview.ng_points} />}
                  <p className="text-[10px] text-purple-500 pt-1">「追加のみ」→ログ記録のみ（タグ変わらず）　「追加＋タグ更新」→上記フィールドも反映</p>
                </div>
              )}
            </div>
            <div className="px-5 space-y-2">
              {/* AI解析結果がある場合のみ「タグも更新」ボタンを表示 */}
              {parsedPreview && (
                <button
                  onClick={() => saveAddCond(true)}
                  disabled={!addCondText.trim() || addCondSaving}
                  className="w-full py-3 rounded-xl font-bold text-white text-sm disabled:opacity-40 active:scale-[0.98] transition-transform"
                  style={{ background: "linear-gradient(135deg, #7c3aed, #a855f7)" }}
                >
                  {addCondSaving ? "保存中..." : "追加 ＋ 条件タグも更新する"}
                </button>
              )}
              <button
                onClick={() => saveAddCond(false)}
                disabled={!addCondText.trim() || addCondSaving}
                className={`w-full py-3 rounded-xl font-bold text-sm disabled:opacity-40 active:scale-[0.98] transition-transform ${parsedPreview ? "border border-[#d1d7db] bg-white text-[#444]" : "text-white"}`}
                style={parsedPreview ? {} : { background: "linear-gradient(135deg, #1565C0, #2196F3)" }}
              >
                {addCondSaving ? "追加中..." : parsedPreview ? "追加のみ（タグ変えない）" : "追加する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 追加モーダル ── */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}>
          <div className="w-full rounded-t-2xl bg-white px-5 py-5 space-y-3"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom),20px)" }}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-[#111b21] text-base">お客さん追加</h2>
              <button onClick={() => setShowAdd(false)} className="text-[#aaa] text-xl leading-none">✕</button>
            </div>
            <Field label="お客さん名 *" placeholder="例: 田中さん" value={newName} onChange={setNewName} />
            <Field label="電話番号" placeholder="090-1234-5678" type="tel" value={newPhone} onChange={setNewPhone} />
            <Field label="担当者" placeholder="例: 竹内" value={newAssignee} onChange={setNewAssignee} />
            <button onClick={addCustomer} disabled={!newName.trim() || addLoading}
              className="w-full py-3 rounded-xl font-bold text-white text-sm disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
              {addLoading ? "追加中..." : "追加する"}
            </button>
          </div>
        </div>
      )}

      {/* ── フォーマット文モーダル ── */}
      {formatMsgModal && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setFormatMsgModal(null)}>
          <div className="w-full rounded-t-2xl bg-white"
            style={{ maxHeight: "80svh", paddingBottom: "max(env(safe-area-inset-bottom),20px)" }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#f0f2f5] sticky top-0 bg-white">
              <h2 className="font-bold text-[#111b21]">📄 お客様のフォーマット</h2>
              <button onClick={() => setFormatMsgModal(null)} className="text-[#aaa] text-xl leading-none">✕</button>
            </div>
            <div className="overflow-y-auto px-5 py-4" style={{ maxHeight: "55svh" }}>
              <pre className="whitespace-pre-wrap text-[13px] text-[#111b21] leading-relaxed font-sans">
                {formatMsgModal.text}
              </pre>
            </div>
            <div className="px-5 pt-3 border-t border-[#f0f2f5]">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(formatMsgModal.text).then(() => {
                    setFormatCopied("modal");
                    setTimeout(() => setFormatCopied(null), 2000);
                  });
                }}
                className="w-full rounded-xl py-3 text-sm font-bold text-white active:opacity-80 transition"
                style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}
              >
                {formatCopied === "modal" ? "✓ コピーしました" : "コピー"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* バッチ完了トースト */}
      {batchDone && (
        <div className="fixed bottom-28 left-1/2 z-50 rounded-2xl px-5 py-3 shadow-xl"
          style={{ background: "#1565C0", transform: "translateX(-50%)" }}>
          <span className="text-white text-sm font-bold">全員分の検索が完了しました！</span>
        </div>
      )}

      {/* AIXパネル — アツい・要対応・ターゲット顧客一覧 */}
      {showAixPanel && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowAixPanel(false); }}
        >
          <div
            className="w-full max-w-md rounded-t-3xl bg-white shadow-2xl flex flex-col overflow-hidden"
            style={{ maxHeight: "75svh" }}
          >
            {/* パネルヘッダー */}
            <div
              className="flex items-center justify-between px-5 py-4 flex-shrink-0"
              style={{ background: "linear-gradient(135deg, #0d1b3e 0%, #1565C0 100%)" }}
            >
              <span className="text-base font-black text-white tracking-tight">AIX</span>
              <button
                onClick={() => setShowAixPanel(false)}
                className="text-white/70 text-xl leading-none active:opacity-60"
              >
                ✕
              </button>
            </div>

            {/* スクロール可能なボディ */}
            <div className="overflow-y-auto flex-1 pb-6">
              <AixPanelSection
                title="🔥 アツい"
                badge={aixPanelData.hot.length}
                badgeColor="bg-orange-400"
                emptyLabel="アツい顧客なし（14日以内）"
                items={aixPanelData.hot.map((c) => ({
                  id: c.id,
                  name: c.customer_name,
                  account: c.linked_conversation?.account ?? c.account,
                  status: c.status,
                  subLabel: c.linked_conversation?.updated_at ? relTime(c.linked_conversation.updated_at) : "",
                  flagged: !!c.linked_conversation?.is_flagged,
                }))}
              />
              <AixPanelSection
                title="🚨 要対応"
                badge={aixPanelData.flagged.length}
                badgeColor="bg-red-500"
                emptyLabel="要対応顧客なし"
                items={aixPanelData.flagged.map((c) => ({
                  id: c.id,
                  name: c.customer_name,
                  account: c.linked_conversation?.account ?? c.account,
                  status: c.status,
                  subLabel: c.linked_conversation?.updated_at ? relTime(c.linked_conversation.updated_at) : "",
                  flagged: true,
                }))}
              />
              <AixPanelSection
                title="🎯 ターゲット"
                badge={aixPanelData.target.length}
                badgeColor="bg-blue-500"
                emptyLabel="物件出し対象なし"
                items={aixPanelData.target.map((c) => ({
                  id: c.id,
                  name: c.customer_name,
                  account: c.linked_conversation?.account ?? c.account,
                  status: c.status,
                  subLabel: c.last_property_sent_at ? `最終送信 ${relTime(c.last_property_sent_at)}` : "未送信",
                  flagged: false,
                }))}
              />
            </div>
          </div>
        </div>
      )}

      <BottomNav />
    </div>
  );
}

function Tag({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1 rounded-lg border border-[#e9edef] bg-[#f8f9fa] px-2 py-0.5">
      <span className="text-[9px] font-semibold text-[#8696a0] shrink-0">{label}</span>
      <span className="text-[11px] font-semibold text-[#333]">{value}</span>
    </span>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold text-purple-500 w-14 shrink-0">{label}</span>
      <span className="text-[11px] text-purple-800 font-semibold">{value}</span>
    </div>
  );
}

function Field({
  label, placeholder, value, onChange, textarea = false, type = "text",
}: {
  label: string; placeholder: string; value: string;
  onChange: (v: string) => void; textarea?: boolean; type?: string;
}) {
  const base = "w-full border border-[#e9edef] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#2196F3]";
  return (
    <div>
      <label className="text-[11px] font-semibold text-[#8696a0] mb-1 block">{label}</label>
      {textarea ? (
        <textarea className={base} rows={2} placeholder={placeholder} value={value}
          onChange={(e) => onChange(e.target.value)} style={{ resize: "none" }} />
      ) : (
        <input type={type} className={base} placeholder={placeholder} value={value}
          onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

type AixPanelItem = {
  id: string;
  name: string;
  account?: string | null;
  status: string;
  subLabel: string;
  flagged: boolean;
};

function AixPanelSection({
  title, badge, badgeColor, emptyLabel, items,
}: {
  title: string;
  badge: number;
  badgeColor: string;
  emptyLabel: string;
  items: AixPanelItem[];
}) {
  return (
    <div className="border-b border-[#f0f2f5] last:border-b-0">
      <div className="flex items-center gap-2 px-5 py-3 bg-[#f8f9fa] sticky top-0">
        <span className="text-[13px] font-black text-[#111b21]">{title}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold text-white ${badgeColor}`}>
          {badge}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="px-5 py-4 text-[12px] text-[#8696a0]">{emptyLabel}</div>
      ) : (
        <ul>
          {items.map((item) => {
            const s = PROP_STATUS[item.status];
            return (
              <li
                key={item.id}
                className="flex items-center gap-3 px-5 py-3 border-b border-[#f0f2f5] last:border-b-0 active:bg-[#f5f6f6]"
              >
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[13px] font-black shrink-0"
                  style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}
                >
                  {item.name?.trim()?.charAt(0) ?? "?"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[13px] font-bold text-[#111b21] truncate">{item.name}</span>
                    {item.account && (
                      <span className="text-[9px] font-bold text-[#8696a0] shrink-0">
                        {ACCT_LABEL[item.account] ?? item.account}
                      </span>
                    )}
                    {item.flagged && (
                      <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[9px] font-bold text-white shrink-0">
                        要対応
                      </span>
                    )}
                  </div>
                  {item.subLabel && (
                    <div className="text-[11px] text-[#8696a0] mt-0.5">{item.subLabel}</div>
                  )}
                </div>
                {s && (
                  <span className="flex items-center gap-1 shrink-0">
                    <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                    <span className="text-[10px] font-semibold text-[#54656f]">{s.label}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function CustomersPage() {
  return (
    <Suspense>
      <CustomersPageInner />
    </Suspense>
  );
}
