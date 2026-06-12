"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import BottomNav from "@/app/components/BottomNav";

type LinkedConv = {
  id: string;
  last_message?: string | null;
  last_sender?: string | null;
  updated_at?: string | null;
  account?: string | null;
  status?: string | null;
  profile_image_url?: string | null;
  customer_name?: string | null;
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
  property_send_count?: number | null;
  property_viewed_at?: string | null;
  additional_conditions?: string | null;
  ai_summary?: string | null;
  ai_summary_at?: string | null;
  created_at: string;
  updated_at: string;
  is_linked?: boolean;
  linked_conversation?: LinkedConv | null;
};

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

// 条件ログエントリのパース: "【2026/06/07追加】" or "【2026/06/07反映済み】" 形式を検出
function parseConditionLog(text: string): { isLog: boolean; isReflected: boolean; date: string; content: string } {
  const m = text.match(/^【(\d{4}\/\d{2}\/\d{2})(追加|反映済み)】([\s\S]*)$/);
  if (m) return { isLog: true, isReflected: m[2] === "反映済み", date: m[1], content: m[3].trim() };
  return { isLog: false, isReflected: false, date: "", content: text };
}

function formatLogDate(): string {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
}

type EditFields = {
  desired_area: string; floor_plan: string;
  rent_min: string; rent_max: string;
  walk_minutes: string; move_in_time: string;
  building_age: string; initial_cost_limit: string;
  floor_area_min: string;
  preferences: string; ng_points: string;
  other_requests: string; property_memo: string;
};

function toEditFields(c: Customer): EditFields {
  return {
    desired_area:       c.desired_area       ?? "",
    floor_plan:         c.floor_plan         ?? "",
    rent_min:           c.rent_min           ? String(Math.floor(c.rent_min / 10000)) : "",
    rent_max:           c.rent_max           ? String(Math.floor(c.rent_max / 10000)) : "",
    walk_minutes:       c.walk_minutes       ? String(c.walk_minutes) : "",
    move_in_time:       c.move_in_time       ?? "",
    building_age:       c.building_age       ? String(c.building_age) : "",
    initial_cost_limit: c.initial_cost_limit ? String(Math.floor(c.initial_cost_limit / 10000)) : "",
    floor_area_min:     c.floor_area_min     ? String(c.floor_area_min) : "",
    preferences:        c.preferences        ?? "",
    ng_points:          c.ng_points          ?? "",
    other_requests:     c.other_requests     ?? "",
    property_memo:      c.property_memo      ?? "",
  };
}

function emptyEditFields(): EditFields {
  return { desired_area:"", floor_plan:"", rent_min:"", rent_max:"", walk_minutes:"", move_in_time:"", building_age:"", initial_cost_limit:"", floor_area_min:"", preferences:"", ng_points:"", other_requests:"", property_memo:"" };
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filterMode, setFilterMode] = useState<"linked" | "all" | "urgent" | "applying">("linked");
  const [expandedId, setExpandedId]     = useState<string | null>(null);
  const [sentUpdating, setSentUpdating]   = useState<string | null>(null);
  const [viewedUpdating, setViewedUpdating]   = useState<string | null>(null);
  const [showCompleted, setShowCompleted]     = useState(true);
  const [reflectLoading, setReflectLoading]   = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // 条件に反映する → 保存後に生テキストを「反映済み」ログに変換するために使用
  const convertRawOnSave = useRef<{ id: string; raw: string } | null>(null);
  const summaryInitDone = useRef(false);
  const [statusMenuId, setStatusMenuId] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartPos = useRef<{ x: number; y: number } | null>(null);

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

  // 条件追加モーダル
  const [addCondId, setAddCondId]       = useState<string | null>(null);
  const [addCondText, setAddCondText]   = useState("");
  const [addCondParsing, setAddCondParsing] = useState(false);
  const [addCondSaving, setAddCondSaving]   = useState(false);
  const [parsedPreview, setParsedPreview]   = useState<EditFields | null>(null);

  const [summaries, setSummaries]           = useState<Record<string, string>>({});
  const [summaryLoading, setSummaryLoading] = useState<Set<string>>(new Set());

  const fetchCustomers = async () => {
    const res = await fetch("/api/property-customers");
    if (res.ok) setCustomers(await res.json());
    setLoading(false);
  };
  useEffect(() => { fetchCustomers(); }, []);

  // ロード完了後: DB保存済み要約をstateに読み込み → 未生成の紐付き客を順次自動生成
  useEffect(() => {
    if (loading || summaryInitDone.current || customers.length === 0) return;
    summaryInitDone.current = true;

    const fromDb: Record<string, string> = {};
    for (const c of customers) {
      if (c.ai_summary) fromDb[c.id] = c.ai_summary;
    }
    if (Object.keys(fromDb).length > 0) setSummaries(fromDb);

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
        const ta = a.last_property_sent_at ? new Date(a.last_property_sent_at).getTime() : 0;
        const tb = b.last_property_sent_at ? new Date(b.last_property_sent_at).getTime() : 0;
        return tb - ta;
      }),
  [base, filterMode]);

  const linkedCount    = customers.filter((c) => c.is_linked && !isApplying(c.status)).length;
  const replyCount     = customers.filter((c) => urgency(c) === "reply" && !isApplying(c.status)).length;
  const urgentCount    = customers.filter((c) => c.is_linked && urgency(c) === "property" && !isApplying(c.status)).length;
  const applyingCount  = customers.filter((c) => isApplying(c.status)).length;

  const markSent = async (id: string) => {
    setSentUpdating(id);
    const now = new Date().toISOString();
    const res = await fetch("/api/property-customers", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, last_property_sent_at: now }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCustomers((p) => p.map((c) => c.id === id ? { ...c, ...updated } : c));
    } else {
      setCustomers((p) => p.map((c) => c.id === id ? { ...c, last_property_sent_at: now } : c));
    }
    setSentUpdating(null);
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

  const handleReflect = async (c: Customer) => {
    if (!c.additional_conditions || reflectLoading) return;
    setReflectLoading(c.id);
    try {
      // ログエントリ（【日付追加/反映済み】形式）を除外して生テキストのみ送る
      const rawLines = c.additional_conditions.split("\n")
        .filter(line => line.trim() && !parseConditionLog(line).isLog);
      if (rawLines.length === 0) return;
      // 最新の1件のみ解析（複数raw行がある場合も直近のみ対象）
      const rawText = rawLines[rawLines.length - 1];

      const res = await fetch("/api/parse-additional-conditions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawText }),
      });
      const data = await res.json() as { ok: boolean; parsed?: Record<string, unknown> };
      if (!data.ok || !data.parsed) return;

      const p = data.parsed;
      // 言及されたフィールドのみ更新（truthy チェックで null/""/0 は無視）
      const appendStr = (orig: string | null | undefined, add: string) => orig ? `${orig}、${add}` : add;
      const patch: Record<string, unknown> = { id: c.id };

      if (p.desired_area)       patch.desired_area       = appendStr(c.desired_area, String(p.desired_area));
      if (p.floor_plan)         patch.floor_plan         = String(p.floor_plan);  // 間取りは上書き（追記しない）
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

      // 変更項目がない場合はスキップ
      if (Object.keys(patch).length <= 1) return;

      // 直接DBに保存（モーダル経由なし）
      const saveRes = await fetch("/api/property-customers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!saveRes.ok) return;
      const updated = await saveRes.json() as Customer;
      setCustomers((prev) => prev.map((x) => x.id === c.id ? { ...x, ...updated } : x));

      // raw エントリを「反映済み」ログに変換（削除しない）
      const logified = c.additional_conditions.split("\n").map(line => {
        const pl = parseConditionLog(line);
        return pl.isLog ? line : `【${formatLogDate()}反映済み】${pl.content}`;
      }).filter(Boolean).join("\n");
      await fetch("/api/property-customers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id, additional_conditions: logified || null }),
      });
      setCustomers((prev) => prev.map((x) => x.id === c.id ? { ...x, additional_conditions: logified || null } : x));

      // 紐付き顧客はAI要約を自動再生成
      if (c.is_linked) void generateSummary({ ...c, ...updated } as Customer);
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
    const patch = {
      id: editId,
      desired_area:       editFields.desired_area       || null,
      floor_plan:         editFields.floor_plan         || null,
      rent_min:           editFields.rent_min           ? Number(editFields.rent_min) * 10000           : null,
      rent_max:           editFields.rent_max           ? Number(editFields.rent_max) * 10000           : null,
      walk_minutes:       editFields.walk_minutes       ? Number(editFields.walk_minutes)               : null,
      move_in_time:       editFields.move_in_time       || null,
      building_age:       editFields.building_age       ? Number(editFields.building_age)               : null,
      initial_cost_limit: editFields.initial_cost_limit ? Number(editFields.initial_cost_limit) * 10000 : null,
      floor_area_min:     editFields.floor_area_min     ? Number(editFields.floor_area_min)              : null,
      preferences:        editFields.preferences        || null,
      ng_points:          editFields.ng_points          || null,
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

  // 条件追加: AIでテキスト→構造化フィールドを自動解析
  const parseAddCond = async () => {
    if (!addCondText.trim() || addCondParsing) return;
    setAddCondParsing(true);
    try {
      const res = await fetch("/api/parse-additional-conditions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: addCondText }),
      });
      const data = await res.json() as { ok: boolean; parsed?: Record<string, unknown> };
      if (!data.ok || !data.parsed) return;
      const p = data.parsed;
      const f = emptyEditFields();
      const preview: EditFields = {
        desired_area:       p.desired_area       != null ? String(p.desired_area)       : f.desired_area,
        floor_plan:         p.floor_plan         != null ? String(p.floor_plan)         : f.floor_plan,
        rent_min:           p.rent_min           != null ? String(Math.floor((p.rent_min as number)/10000)) : f.rent_min,
        rent_max:           p.rent_max           != null ? String(Math.floor((p.rent_max as number)/10000)) : f.rent_max,
        walk_minutes:       p.walk_minutes       != null ? String(p.walk_minutes)       : f.walk_minutes,
        move_in_time:       p.move_in_time       != null ? String(p.move_in_time)       : f.move_in_time,
        building_age:       p.building_age       != null ? String(p.building_age)       : f.building_age,
        floor_area_min:     p.floor_area_min     != null ? String(p.floor_area_min)     : f.floor_area_min,
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

      const logEntry = `【${formatLogDate()}追加】${addCondText.trim()}`;
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
        const data = await res.json() as { summary: string };
        setSummaries((prev) => ({ ...prev, [c.id]: data.summary }));
        const generatedAt = new Date().toISOString();
        setCustomers((prev) => prev.map((cust) => cust.id === c.id ? { ...cust, ai_summary_at: generatedAt } : cust));
      }
    } finally {
      setSummaryLoading((prev) => { const s = new Set(prev); s.delete(c.id); return s; });
    }
  };

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
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-xl border border-white/30 px-3 py-1.5 text-xs font-bold text-white active:opacity-70"
            style={{ background: "rgba(255,255,255,0.13)" }}
          >
            ＋ 追加
          </button>
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
        </div>

        {/* 検索欄 */}
        <div className="relative">
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
                return (
                  <div key={c.id}
                    className="flex items-center gap-3 rounded-2xl border border-[#e9edef] bg-white px-4 py-2.5">
                    <div className="shrink-0">
                      {conv?.profile_image_url ? (
                        <img src={conv.profile_image_url} alt={c.customer_name}
                          className="h-9 w-9 rounded-full object-cover" />
                      ) : (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#d9fdd3] text-sm font-bold text-[#0f8f44]">
                          {initial(c.customer_name)}
                        </div>
                      )}
                    </div>
                    <span className="flex-1 truncate text-[13px] font-semibold text-[#111b21]">
                      {c.customer_name}
                    </span>
                    <div className="flex shrink-0 gap-1.5">
                      {sent && (
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                          物件送った
                        </span>
                      )}
                      {viewed && (
                        <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                          物件確認済
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── List ── */}
      <div className="flex-1 pb-28">
        {loading ? (
          <div className="py-16 text-center text-sm text-[#667781]">読み込み中...</div>
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
              <div key={c.id} className="mx-3 mt-2.5 rounded-2xl overflow-hidden shadow-sm"
                style={{ border: `1.5px solid ${borderColor}`, background: "#fff" }}>

                {/* ── ヘッダー行 ── */}
                <button
                  className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-[#f5f6f6]"
                  onClick={() => setExpandedId(isExp ? null : c.id)}
                  onPointerDown={(e) => {
                    longPressStartPos.current = { x: e.clientX, y: e.clientY };
                    longPressTimer.current = setTimeout(() => {
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
                      <p className="text-[11px] text-[#555] leading-relaxed">
                        <span className="font-semibold text-[#8696a0]">AI分析　</span>{c.ai_summary}
                      </p>
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
                      {(c.desired_area || c.floor_plan || c.floor_area_min || c.rent_min || c.rent_max || c.walk_minutes || c.move_in_time || c.building_age || c.initial_cost_limit || c.preferences || c.ng_points) ? (
                        <>
                          {condLines.length > 0 && (
                            <p className="text-[9px] font-bold text-[#8696a0] mb-1 tracking-wide">元の条件</p>
                          )}
                          <div className="flex flex-wrap gap-1.5">
                            {c.desired_area && <Tag label="エリア" value={c.desired_area} />}
                            {c.floor_plan   && <Tag label="間取り" value={c.floor_plan} />}
                            {c.floor_area_min && <Tag label="広さ" value={`${c.floor_area_min}㎡以上`} />}
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
                                entry.isReflected ? (
                                  // 反映済みログ（緑）
                                  <div key={i} className="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2">
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[10px] font-bold text-emerald-600">✅ {entry.date} 反映済み</span>
                                    </div>
                                    <p className="text-[11px] text-emerald-800 leading-relaxed">{entry.content}</p>
                                  </div>
                                ) : (
                                  // 追加ログ（青）
                                  <div key={i} className="rounded-xl border border-blue-100 bg-blue-50 px-3 py-2">
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[10px] font-bold text-blue-600">📌 {entry.date} 追加</span>
                                    </div>
                                    <p className="text-[11px] text-blue-800 leading-relaxed">{entry.content}</p>
                                  </div>
                                )
                              ) : (
                                // 新着要望（琥珀）
                                <div key={i} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                                  <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] font-bold text-amber-700">新着要望</span>
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={(e) => { e.stopPropagation(); handleReflect(c); }}
                                        disabled={reflectLoading === c.id}
                                        className="rounded-lg bg-amber-600 px-2.5 py-1 text-[10px] font-bold text-white active:opacity-70 disabled:opacity-50"
                                      >
                                        {reflectLoading === c.id ? "解析中…" : "条件に反映する"}
                                      </button>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); clearAdditional(c.id); }}
                                        className="text-[9px] text-amber-400 active:opacity-60"
                                      >
                                        クリア
                                      </button>
                                    </div>
                                  </div>
                                  <p className="text-[11px] text-amber-800 leading-relaxed">{entry.content}</p>
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

                    {/* ── AI要約 ── */}
                    {summaries[c.id] && (
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
                          <div className="flex items-center gap-1.5">
                            <p className="text-[10px] font-bold text-purple-400 tracking-wide">✨ AI要約（LINE参考用）</p>
                            {c.ai_summary_at && <span className="text-[9px] text-purple-300">{relTime(c.ai_summary_at)}</span>}
                          </div>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#c084fc" strokeWidth="2.5" strokeLinecap="round"
                            className={`transition-transform duration-200 ${expandedSummaryIds.has(c.id) ? "rotate-180" : ""}`}>
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                        {expandedSummaryIds.has(c.id) && (
                          <div className="px-4 pb-3">
                            <p className="text-[12px] text-[#333] whitespace-pre-line leading-relaxed">{summaries[c.id]}</p>
                          </div>
                        )}
                      </div>
                    )}
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
                onClick={() => setStatusMenuId(null)}
                className="mx-5 mt-3 mb-1 w-[calc(100%-2.5rem)] rounded-2xl bg-[#f0f2f5] py-3.5 text-[14px] font-bold text-[#667781] active:bg-[#e9edef]"
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
              <Field label="エリア" placeholder="例: 城東区・東大阪市"
                value={editFields.desired_area} onChange={(v) => setEditFields((f) => f && ({ ...f, desired_area: v }))} />
              <Field label="間取り" placeholder="例: 1LDK・2DK"
                value={editFields.floor_plan} onChange={(v) => setEditFields((f) => f && ({ ...f, floor_plan: v }))} />
              <Field label="広さ（㎡以上）" placeholder="例: 30" type="number"
                value={editFields.floor_area_min} onChange={(v) => setEditFields((f) => f && ({ ...f, floor_area_min: v }))} />
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
          onClick={(e) => { if (e.target === e.currentTarget) { setAddCondId(null); setAddCondText(""); setParsedPreview(null); } }}>
          <div className="w-full rounded-t-2xl bg-white overflow-y-auto"
            style={{ maxHeight: "85svh", paddingBottom: "max(env(safe-area-inset-bottom),20px)" }}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#f0f2f5] sticky top-0 bg-white z-10">
              <div>
                <h2 className="font-bold text-[#111b21] text-[15px]">条件追加</h2>
                <p className="text-[11px] text-[#8696a0]">
                  {customers.find((c) => c.id === addCondId)?.customer_name} ・ {formatLogDate()}
                </p>
              </div>
              <button onClick={() => { setAddCondId(null); setAddCondText(""); setParsedPreview(null); }} className="text-[#aaa] text-xl leading-none">✕</button>
            </div>
            <div className="px-5 py-4 space-y-3">
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
                disabled={!addCondText.trim() || addCondParsing}
                className="w-full py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform"
                style={{ background: "linear-gradient(135deg, #7c3aed, #a855f7)" }}
              >
                {addCondParsing ? "AI解析中..." : "✨ AIで自動解析"}
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
