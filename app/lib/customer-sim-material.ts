// app/lib/customer-sim-material.ts
// お客様役（テスト・YUMA 専用）のスタッフ役が AIX を送る時の「材料の選び方」（純関数・DB も fetch も持たない）。
// 2026-09-27 竹内「ほかにも見積書や物件資料は保存されてると思うから使いながらためしていく／AIXもテストでおくるかたちにする」
//
// 材料の決まり（守ること）:
//   ・見積書 … YUMA の会話に保存済みの見積書（estimate_records ＋送った時の画像・本文）だけ。金額は保存済みの値だけ（創作しない）。
//              他のお客様の見積書の画像は個人情報が入り得るので使わない（ここに渡すのは YUMA の会話の物だけ＝呼ぶ側が絞る）
//   ・物件資料 … YUMA のお客様の保存済みピックアップ（property_pickups）の画像・PDF・本文
//   ・内覧・待ち合わせの日時 … 会話の中で決まった日時／お客様役が出した候補 → 無ければ明日以降の固定の候補
//   ・物件確認した（募集状況の確認の結果）… 本番の生成に「募集中」の入力で作る（入力値は筋書きの設定として記録に残す）
// 揃わない物は送らずに止めて、理由を返す（planStaffAction が aix_needs_material にする）。
//
// 呼ぶ側: scripts/customer-sim.ts（DB から材料の候補を集めて SimMaterialPool にし、pickSimMaterial で選ぶ）
// テスト: app/lib/__tests__/customer-sim-material.test.ts
import { WEEKDAYS_JA } from "@/app/lib/jst-date";

// ─── 材料の候補（呼ぶ側が DB から集める） ───

/** 保存済みの見積書（YUMA の会話の estimate_records ＋ 送った時の画像） */
export type SimEstimateSource = {
  recordId: number;
  conversationId: string;
  propertyName: string;
  roomNo: string | null;
  /** 初期費用（保存済みの値） */
  initialCostYen: number | null;
  /** 割引（保存済みの値） */
  discountYen: number | null;
  /** 送った時の見積書の画像（同じ会話の messages.image_url） */
  imageUrl: string | null;
  /** 送った時の本文（aix_usage_logs.generated_text） */
  sentText: string | null;
  estimatedAt: string | null;
};

/** 保存済みのピックアップ（property_pickups） */
export type SimPickupSource = {
  id: number;
  propertyName: string;
  roomNo: string | null;
  /** お客様に送れる画像（元の資料の1ページ目そのまま＝trim_image_url だけ・app/lib/pickup-send-image.ts pickSendImageUrl。page_image_url は送らない） */
  imageUrl: string | null;
  pdfUrl: string | null;
  summaryText: string | null;
  /** 資料の本文から読んだ所在地（pdf_text の「所在地」の次の行） */
  address: string | null;
  rank: number | null;
  status: string | null;
  sentAt: string | null;
  completeGroupId: string | null;
  /** 送った印（mark_sent）に渡す元の回 */
  batchId: string | null;
};

export type SimMaterialPool = {
  conversationId: string;
  /** 見積書（新しい順）。YUMA の会話の物だけを入れる */
  estimates: ReadonlyArray<SimEstimateSource>;
  /** ピックアップ（点の高い順＝complete_rank / rank の昇順） */
  pickups: ReadonlyArray<SimPickupSource>;
  /** こちらが送った物件の名前（新しい順・sent_properties） */
  sentPropertyNames: ReadonlyArray<string>;
  /** 主のお部屋（customer-state の focus・無ければ null） */
  focusPropertyName: string | null;
  /** 会話（古→新） */
  history: ReadonlyArray<{ sender: string; text: string | null; createdAt?: string | null }>;
  /** 今（テストで固定できるように） */
  nowMs: number;
};

// ─── 選んだ材料 ───

export type SimViewingSlot = { ymd: string; label: string; start: string; end: string | null };

export type SimAixMaterial =
  | { kind: "estimate"; recordId: number; imageUrl: string; propertyName: string; roomNo: string | null; initialCostYen: number; discountYen: number; savedText: string | null }
  | { kind: "check_result"; checkPattern: "available"; propertyName: string; setting: "募集中"; imageUrl: string | null; pickupId: number | null }
  | { kind: "pickups"; items: SimPickupSource[] }
  | { kind: "viewing_slots"; slots: SimViewingSlot[]; source: "conversation" | "fixed"; propertyName: string | null }
  | { kind: "meeting"; date: string; time: string; propertyName: string; address: string | null; source: "conversation" | "fixed" };

export type SimMaterialPick = { ok: true; material: SimAixMaterial } | { ok: false; reason: string };

/** 材料の要る AIX のうち、スタッフ役が材料を選んで送れる種類（それ以外の材料の要る AIX は止める） */
export const SIM_MATERIAL_AIX: ReadonlySet<string> = new Set([
  "estimate_sheet", "property_check_result", "property_send", "property_recommendation", "viewing_invite", "meeting_place",
]);

/** 止める AIX と理由（材料が保存されていない・お客様以外に送る・外の操作が要る） */
export const SIM_UNSUPPORTED_AIX_REASON: Readonly<Record<string, string>> = {
  acknowledge_check: "管理会社・オーナーへの確認文を作る AIX（お客様に送る文ではない）",
  cost_explain: "報酬・還元額（管理会社の広告料）の入力が要る。保存された値が無い",
  cost_breakdown: "御見積書の内訳の入力が要る（保存済みの見積書は総額・割引だけ）",
  guarantor_info: "物件ごとの保証会社名と種類の入力が要る。保存された値が無い",
  phone_call: "LINE コールの電話ボタンを送る（テストでは電話をかけない）",
  phone_followup: "電話で話した内容の入力が要る（テストでは電話をしていない）",
};

// ─── 見積書 ───

/** 見積書を選ぶ: 主のお部屋（無ければ直近）の保存済みの見積書。金額・画像が揃っている物だけ */
export function pickEstimate(pool: SimMaterialPool, propertyName?: string | null): SimMaterialPick {
  const usable = pool.estimates.filter((e) =>
    e.conversationId === pool.conversationId && !!e.imageUrl && (e.initialCostYen ?? 0) > 0 && e.discountYen !== null && e.discountYen >= 0);
  if (usable.length === 0) {
    return { ok: false, reason: pool.estimates.length === 0 ? "この会話に保存済みの見積書が無い" : "保存済みの見積書に画像か金額が無い" };
  }
  const want = propertyName ?? pool.focusPropertyName;
  const hit = want ? usable.find((e) => sameBuilding(e.propertyName, want)) : null;
  if (want && !hit) return { ok: false, reason: `${want} の見積書が保存されていない（あるのは ${usable.map((e) => e.propertyName).join("・")}）` };
  const e = hit ?? usable[0];
  return {
    ok: true,
    material: { kind: "estimate", recordId: e.recordId, imageUrl: e.imageUrl!, propertyName: e.propertyName, roomNo: e.roomNo, initialCostYen: e.initialCostYen!, discountYen: e.discountYen!, savedText: e.sentText },
  };
}

/** 同じ建物か（全角半角・空白・記号の違いを無視して、片方がもう片方を含む） */
export function sameBuilding(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string | null | undefined) => String(s ?? "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　・･\-－ー―()（）【】]/g, "").toLowerCase();
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
}

/**
 * 生成された見積書の本文の物件名を保存済みの名前にそろえる（スタッフの手直しと同じ・was_edited=true で記録する）。
 *   保存済みの見積書 264 は画像の物件名（別の建物）を竹内さんの指示で本文だけ「エステムコート大阪WEST」にして送った物。
 *   画像を読み直すと画像の名前が出るので、送った時と同じ手直しをする。金額は触らない。
 *   金額が保存済みの値と食い違う時（読み違い）は null＝送らない（創作・読み違いの金額を送らない）。
 */
export function alignEstimateText(generated: string, m: { propertyName: string; initialCostYen: number; discountYen: number }): { text: string; edited: boolean } | null {
  const t = String(generated ?? "");
  const nums = (s: string) => [...s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).matchAll(/([0-9][0-9,]*)\s*円/g)].map((x) => Number(x[1].replace(/,/g, "")));
  const found = nums(t);
  if (!found.includes(m.initialCostYen)) return null;
  if (m.discountYen > 0 && !found.includes(m.discountYen)) return null;
  // 【物件名 号室】の見出しを保存済みの名前に（見出しが無ければそのまま）
  let edited = false;
  const text = t.replace(/【([^】\n]{1,80})】/, (whole, inner: string) => {
    if (sameBuilding(inner, m.propertyName)) return whole;
    edited = true;
    return `【${m.propertyName}】`;
  });
  return { text, edited };
}

// ─── ピックアップ ───

/** 送るピックアップを選ぶ: まだ送っていない物を点の高い順に max 件（画像が無い物は外す） */
export function pickPickups(pool: SimMaterialPool, max = 3): SimMaterialPick {
  const sentNames = pool.sentPropertyNames;
  const fresh = pool.pickups.filter((p) =>
    !!p.imageUrl && !p.sentAt && p.status !== "sent" && p.status !== "excluded"
    && !sentNames.some((n) => sameBuilding(n, p.propertyName)));
  if (pool.pickups.length === 0) return { ok: false, reason: "保存済みのピックアップが無い" };
  if (fresh.length === 0) return { ok: false, reason: "送っていない・送れる画像（元の資料の1ページ目＝trim_image_url）のあるピックアップが残っていない" };
  return { ok: true, material: { kind: "pickups", items: fresh.slice(0, Math.max(1, max)) } };
}

/** 資料の本文（pdf_text）から所在地を読む（「所在地」の次の行・大阪府… の形だけ） */
export function addressFromPdfText(pdfText: string | null | undefined): string | null {
  const lines = String(pdfText ?? "").split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^所在地\s*[:：]?\s*(\S.*)$/);
    const cand = inline?.[1] ?? (lines[i] === "所在地" ? lines[i + 1] : null);
    if (cand && /^(?:大阪府|京都府|兵庫県|奈良県|和歌山県|滋賀県|東京都)?\S*[市区町村]/.test(cand)) return cand.replace(/\s+/g, "");
  }
  return null;
}

// ─── 物件確認した（募集中） ───

/**
 * 物件確認した（募集中）の対象: 主のお部屋 → 直近に送ったお部屋。資料の画像は同じ建物の保存済みピックアップ（無ければ本文だけ）。
 *   御見積書は同封しない: 保存済みの見積書は全部もう送った物（同じ見積書をもう一度貼る場面は材料から決められない）
 */
export function pickCheckResult(pool: SimMaterialPool, checkPattern: string | null): SimMaterialPick {
  if (checkPattern && checkPattern !== "available") {
    return { ok: false, reason: `物件確認した の「${checkPattern}」は管理会社の回答の入力が要る（テストの設定は募集中＝available だけ）` };
  }
  const name = pool.focusPropertyName ?? pool.sentPropertyNames[0] ?? null;
  if (!name) return { ok: false, reason: "確認する物件が決まっていない（主のお部屋も送った物件も無い）" };
  const pk = pool.pickups.find((p) => p.imageUrl && sameBuilding(p.propertyName, name)) ?? null;
  return { ok: true, material: { kind: "check_result", checkPattern: "available", propertyName: name, setting: "募集中", imageUrl: pk?.imageUrl ?? null, pickupId: pk?.id ?? null } };
}

// ─── 内覧・待ち合わせの日時 ───

const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/：/g, ":").replace(/／/g, "/");
const pad2 = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400_000;
const JST = 9 * 3600_000;

function ymdOf(ms: number): { y: number; m: number; d: number; dow: number; ymd: string } {
  const j = new Date(ms + JST);
  const y = j.getUTCFullYear(), m = j.getUTCMonth() + 1, d = j.getUTCDate();
  return { y, m, d, dow: j.getUTCDay(), ymd: `${y}-${pad2(m)}-${pad2(d)}` };
}
/** 「9/28(月)」の形（画面のカレンダーのラベルと同じ・曜日は日本時間の暦） */
export function dayLabel(ms: number): string {
  const p = ymdOf(ms);
  return `${p.m}/${p.d}(${WEEKDAYS_JA[p.dow]})`;
}

export type SimDateMention = { ymd: string; label: string; time: string | null; ampm: "am" | "pm" | null };

/**
 * 文の中の日時（お客様役の候補・こちらの案内）を読む（決定論）。今日より前・今日は採らない（明日以降だけ）。
 *   「10/3」「10月3日」「土曜」「日曜の午前」「明日の14時」「14:00」「午後」
 *   曜日だけの時は次に来るその曜日（明日以降）。時刻が無く午前/午後だけなら 午前=11:00・午後=14:00。
 */
export function extractDateMentions(text: string | null | undefined, nowMs: number): SimDateMention[] {
  const t = toHalf(String(text ?? ""));
  if (!t.trim()) return [];
  const today = ymdOf(nowMs);
  const todayStart = Date.UTC(today.y, today.m - 1, today.d) - JST;
  const out: SimDateMention[] = [];
  const push = (ms: number, rest: string) => {
    if (ms < todayStart + DAY) return; // 明日以降だけ
    const p = ymdOf(ms);
    if (out.some((o) => o.ymd === p.ymd)) return;
    const tm = rest.match(/(\d{1,2})\s*(?::(\d{2})|時(?:\s*(\d{1,2})分?|半)?)/);
    let time: string | null = null;
    if (tm) {
      let h = Number(tm[1]);
      const mm = tm[2] ?? tm[3] ?? (/半/.test(tm[0]) ? "30" : "00");
      if (/午後|夕方/.test(rest.slice(0, tm.index ?? 0)) && h < 12) h += 12;
      if (h >= 8 && h <= 21) time = `${pad2(h)}:${pad2(Number(mm))}`;
    }
    const ampm: "am" | "pm" | null = /午前|朝/.test(rest) ? "am" : /午後|夕方|昼から|昼過ぎ/.test(rest) ? "pm" : null;
    out.push({ ymd: p.ymd, label: dayLabel(ms), time, ampm });
  };
  // 月日
  for (const m of t.matchAll(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?(?:\s*[（(][日月火水木金土][)）])?((?:(?![日月火水木金土]曜|\d{1,2}\s*[\/月]\s*\d|明後?日|あした|あさって)[^\n、。,]){0,16})/g)) {
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    let y = today.y;
    let ms = Date.UTC(y, mo - 1, d) - JST;
    if (ms < todayStart - 60 * DAY) { y += 1; ms = Date.UTC(y, mo - 1, d) - JST; }
    push(ms, m[3] ?? "");
  }
  // 明日・明後日
  for (const m of t.matchAll(/(明後日|あさって|明日|あした)((?:(?![日月火水木金土]曜|\d{1,2}\s*[\/月]\s*\d|明後?日|あした|あさって)[^\n、。,]){0,16})/g)) {
    const add = /明後日|あさって/.test(m[1]) ? 2 : 1;
    push(todayStart + add * DAY, m[2] ?? "");
  }
  // 曜日（今週・来週の）
  for (const m of t.matchAll(/(来週の?|今週の?)?\s*([日月火水木金土])曜(?:日)?((?:(?![日月火水木金土]曜|\d{1,2}\s*[\/月]\s*\d|明後?日|あした|あさって)[^\n、。,]){0,16})/g)) {
    const dow = WEEKDAYS_JA.indexOf(m[2] as typeof WEEKDAYS_JA[number]);
    let add = (dow - today.dow + 7) % 7;
    if (add === 0) add = 7;
    if (m[1]?.startsWith("来週") && add < 7) add += 7;
    push(todayStart + add * DAY, m[3] ?? "");
  }
  return out;
}

/**
 * 明日以降の固定の候補（会話に日時が無い時）: 明日 11:00〜13:00・明後日 14:00〜16:00。
 * 2026-09-30 竹内「内覧は1件なら1〜2時間の枠・始まり 11:00〜終了 18:30」: スタッフ役の候補も本番の枠の決まり（viewing-slot-plan.ts）と同じ形にする
 *   （旧 11:00〜14:00・14:00〜17:00 の3時間。日にちだけの時は 10:30〜18:30 の丸1日を出していた）
 */
export function fixedViewingSlots(nowMs: number): SimViewingSlot[] {
  const today = ymdOf(nowMs);
  const todayStart = Date.UTC(today.y, today.m - 1, today.d) - JST;
  return [
    { ms: todayStart + DAY, start: "11:00", end: "13:00" },
    { ms: todayStart + 2 * DAY, start: "14:00", end: "16:00" },
  ].map((s) => ({ ymd: ymdOf(s.ms).ymd, label: dayLabel(s.ms), start: s.start, end: s.end }));
}

/** 直近のお客様の発言から新しい順に日時を探す（こちらの発言より後の物を優先＝お客様役が出した候補） */
function customerDateMentions(pool: SimMaterialPool, lookback = 6): SimDateMention[] {
  const cust = pool.history.filter((h) => h.sender === "customer").slice(-lookback).reverse();
  for (const h of cust) {
    const ds = extractDateMentions(h.text, pool.nowMs);
    if (ds.length > 0) return ds;
  }
  return [];
}

/** 内覧へ！の候補日時: お客様が出した日時 → 無ければ明日以降の固定の候補 */
export function pickViewingSlots(pool: SimMaterialPool): SimMaterialPick {
  const ds = customerDateMentions(pool);
  const propertyName = pool.focusPropertyName ?? pool.sentPropertyNames[0] ?? null;
  if (ds.length > 0) {
    const slots = ds.slice(0, 3).map((d) => {
      const [start, end] = d.time ? [d.time, null] : d.ampm === "am" ? ["11:00", "13:00"] : d.ampm === "pm" ? ["14:00", "16:00"] : ["13:00", "15:00"];
      return { ymd: d.ymd, label: d.label, start, end };
    });
    return { ok: true, material: { kind: "viewing_slots", slots, source: "conversation", propertyName } };
  }
  return { ok: true, material: { kind: "viewing_slots", slots: fixedViewingSlots(pool.nowMs), source: "fixed", propertyName } };
}

/**
 * 待ち合わせ場所の日時と物件: お客様が選んだ日時（時刻まで）→ こちらが出した候補の最初 → 固定の候補の最初。
 *   物件は主のお部屋 → 直近に送ったお部屋。住所は同じ建物のピックアップの資料から（無ければ null・創作しない）。
 */
export function pickMeeting(pool: SimMaterialPool): SimMaterialPick {
  const propertyName = pool.focusPropertyName ?? pool.sentPropertyNames[0] ?? null;
  if (!propertyName) return { ok: false, reason: "待ち合わせる物件が決まっていない（主のお部屋も送った物件も無い）" };
  const address = pool.pickups.find((p) => sameBuilding(p.propertyName, propertyName) && p.address)?.address ?? null;
  const cust = customerDateMentions(pool);
  const withTime = cust.find((d) => d.time) ?? null;
  if (withTime) return { ok: true, material: { kind: "meeting", date: withTime.label, time: withTime.time!, propertyName, address, source: "conversation" } };
  if (cust[0]?.ampm) {
    return { ok: true, material: { kind: "meeting", date: cust[0].label, time: cust[0].ampm === "am" ? "11:00" : "14:00", propertyName, address, source: "conversation" } };
  }
  // こちらが出した候補（内覧へ！の本文）
  const staff = pool.history.filter((h) => h.sender === "staff").slice(-4).reverse();
  for (const h of staff) {
    const ds = extractDateMentions(h.text, pool.nowMs).filter((d) => d.time);
    if (ds[0]) return { ok: true, material: { kind: "meeting", date: ds[0].label, time: ds[0].time!, propertyName, address, source: "conversation" } };
  }
  const f = fixedViewingSlots(pool.nowMs)[0];
  return { ok: true, material: { kind: "meeting", date: f.label, time: f.start, propertyName, address, source: "fixed" } };
}

/**
 * 画面の待ち合わせ場所（時間あり）と同じ文（AixModal の meeting_place・時間ありは API を呼ばずに画面で作る）。
 * ⚠ 文面は AixModal.tsx の meeting_place（時間あり）と一字一句同じ（テストで照合）
 */
export function buildMeetingPlaceText(m: { date: string; time: string; propertyName: string; address: string | null }): string {
  const dateNoWd = m.date.replace(/[（(][日月火水木金土][）)]/, "");
  const dateFixed = m.date.replace(/[（(]([日月火水木金土])[）)]/, "（$1）");
  let msg = `かしこまりました！！\n${dateFixed}ご案内させて頂きます！！\n\n${dateNoWd} ${m.time}に${m.propertyName}\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！`;
  if (m.address?.trim()) msg += `\n住所: ${m.address}`;
  return msg;
}

// ─── まとめ ───

/** AIX の種類ごとに材料を選ぶ（揃わなければ理由） */
export function pickSimMaterial(action: string, checkPattern: string | null, pool: SimMaterialPool): SimMaterialPick {
  if (SIM_UNSUPPORTED_AIX_REASON[action]) return { ok: false, reason: SIM_UNSUPPORTED_AIX_REASON[action] };
  switch (action) {
    case "estimate_sheet": return pickEstimate(pool);
    case "property_check_result": return pickCheckResult(pool, checkPattern);
    case "property_send":
    case "property_recommendation": return pickPickups(pool, action === "property_recommendation" ? 1 : 3);
    case "viewing_invite": return pickViewingSlots(pool);
    case "meeting_place": return pickMeeting(pool);
    default: return { ok: false, reason: `AIX【${action}】の材料の選び方がまだ無い` };
  }
}

/** 使った材料の1行（記録・表示用） */
export function describeSimMaterial(m: SimAixMaterial): string {
  switch (m.kind) {
    case "estimate": return `見積書#${m.recordId}（${m.propertyName}・初期費用${m.initialCostYen.toLocaleString()}円・割引${m.discountYen.toLocaleString()}円・画像）`;
    case "check_result": return `物件確認した（設定=${m.setting}/${m.checkPattern}・${m.propertyName}${m.pickupId ? `・資料=ピックアップ#${m.pickupId}` : "・資料なし"}）`;
    case "pickups": return `ピックアップ${m.items.length}件（${m.items.map((p) => `#${p.id} ${p.propertyName}${p.roomNo ? ` ${p.roomNo}` : ""}`).join("・")}）`;
    case "viewing_slots": return `内覧の候補（${m.source === "conversation" ? "会話から" : "固定"}: ${m.slots.map((s) => `${s.label} ${s.start}${s.end ? `〜${s.end}` : ""}`).join("／")}）`;
    case "meeting": return `待ち合わせ（${m.source === "conversation" ? "会話から" : "固定"}: ${m.date} ${m.time} ${m.propertyName}${m.address ? ` ${m.address}` : "・住所なし"}）`;
  }
}

/** 検査の根拠に足す文字列（材料で知っている事実: 金額・日時・物件名） */
export function groundingOfMaterial(m: SimAixMaterial): string[] {
  switch (m.kind) {
    case "estimate": return [m.propertyName, `${m.initialCostYen}円`, `${m.discountYen}円`, m.savedText ?? ""];
    case "check_result": return [m.propertyName];
    case "pickups": return m.items.flatMap((p) => [p.propertyName, p.roomNo ? `${p.roomNo}号室` : "", p.summaryText ?? ""]);
    case "viewing_slots": return m.slots.flatMap((s) => [s.label, s.start, s.end ?? ""]);
    case "meeting": return [m.date, m.time, m.propertyName, m.address ?? ""];
  }
}

/**
 * 送った文に入っているべき材料の事実（検査 auditSimTurn の materialMustShow）。
 *   見積書: 初期費用の金額／物件確認した: 物件名／内覧へ: 最初の候補の月日／待ち合わせ: 月日・時刻・物件名／ピックアップ: 本文に名前を書かない形なので見ない
 */
export function mustShowOfMaterial(m: SimAixMaterial): string[] {
  const md = (label: string) => label.match(/\d{1,2}\/\d{1,2}/)?.[0] ?? label;
  switch (m.kind) {
    case "estimate": return [`${m.initialCostYen.toLocaleString("ja-JP")}円`];
    case "check_result": return [m.propertyName];
    case "pickups": return [];
    case "viewing_slots": return m.slots[0] ? [md(m.slots[0].label)] : [];
    case "meeting": return [md(m.date), m.time, m.propertyName];
  }
}
