// app/lib/viewing-property-candidates.ts
// 内覧の AIX（待ち合わせ・内覧誘導・内覧へ！）で「この会話で送った物件」から選ぶ候補（純関数・DB 依存なし・画面から import してよい）。
//
// 2026-10-06 13:45 竹内さん（会話「ゆいと」・お客様 13:41「ここも行けますか？」＝10/4 のこちらの画像を引用・AIX【待ち合わせ】を開いた画面）:
//   「待ち合わせした際 送った物件選択してそこから おこなえるようにする 物件資料の上に その候補の部分をつくる （見積書作成の時のように）」
// 2026-10-06 15:23 竹内さん（会話「チンシャン」・内覧誘導の画面＝物件ごとに写真を選択＋物件名＋号室）:
//   「内覧誘導の部分実際に送った物件のところ 読み取って選択できるようにする」
//
// 材料は見積書作成と同じ（GET /api/estimate-handoff → estimate-handoff.selectEstimateTarget の target・candidates・others）。
//   物件の決め方（引用＞名前＞持ち込み・送付の回・🌟）・資料（売上サポの資料／送った画像）・資料の文字（所在地）を1か所で決める＝見積書と同じ物件を指す。
// 先に選ぶのは「お客様の発言で決まった物件」だけ（引用・名前・持ち込み）。こちらの送付・🌟・会話の主のお部屋からは選ばない（推測しない）。
// 待ち合わせ＝1件目の内覧の物件（10/02 竹内さん）なので、
//   ・既に1件目の決まり（aix-prefill.meetingPropertyPrefill＝ご案内の文の「先に」・一番早い時刻・並べた順の1件目）で物件名が入っていれば、その候補を選ぶ
//   ・お客様の発言が「ここも行けますか？」の形（追加の内覧）なら、引用した物件は追加の1件＝待ち合わせには先に選ばない（印だけ付ける）
// 住所は資料の文字の「所在地」（meeting-address.materialAddressFromPdfText・字のまま）。番地が無い時は入れて画面の赤字で止める（feedback_meeting_address_full）。
import type { EstimateTarget, EstimateTargetChoice, EstimateTargetSource } from "./estimate-handoff";
import { materialAddressFromPdfText, hasBanchi } from "./meeting-address";
import { matchKnownProperty, buildingNumeral, MATCH_MIN_SCORE } from "./property-name-match";

export type ViewingPropertyCandidate = {
  key: string;
  name: string;
  room: string | null;
  /** 「物件名 号室」 */
  label: string;
  /** 資料の画像（売上サポの資料＞送った画像＞お客様の画像） */
  imageUrl: string | null;
  /** 資料の所在地（字のまま・無ければ空） */
  address: string;
  addressHasBanchi: boolean;
  source: EstimateTargetSource;
  sourceLabel: string;
  at: string | null;
  ended: boolean;
  dealStatus: string | null;
  /** お客様の発言（引用・名前・持ち込み）で決まった物件 */
  customerPointed: boolean;
};

const CUSTOMER_SOURCES = new Set<EstimateTargetSource>(["customer_quoted", "customer_named", "customer_brought"]);
const keyOf = (name: string, room: string | null) =>
  `${name.normalize("NFKC").replace(/[\s　・･\-ー－()（）【】🌟]/g, "").toLowerCase()}|${String(room ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/^0+/, "")}`;

/**
 * 物件ではない見出し（監査 86通: 申込フォーマットの【お申込者様記入欄】【同居人記入欄】【緊急連絡先欄】【連帯保証人欄】・【法人御契約】・
 * 「（室内イメージ）」・「特典あり」が見積書の【】の読み取りで候補に混ざった）
 */
const NOT_PROPERTY_RE = /記入欄|(?:連帯保証人|緊急連絡先|同居人|保証人)欄?$|^(?:お?申込者様?|入居者様?|法人御?契約|契約者様?)$|イメージ|^特典|^[（(]/u;

/** 送付の記録の名前の飾り（「★築浅★ペット可★ディアコート曽根」）を外す */
function stripDecoration(name: string): string {
  const s = String(name ?? "").trim();
  const m = s.match(/^(?:[★☆◆◇■□●○【][^★☆◆◇■□●○】]{0,12}[★☆◆◇■□●○】])+\s*(.+)$/u);
  return (m ? m[1] : s).replace(/^[★☆◆◇■□●○]+/u, "").trim();
}

function toCandidate(t: EstimateTarget): ViewingPropertyCandidate {
  const room = t.room && String(t.room).trim() ? String(t.room).trim().replace(/号室?$/, "") : null;
  t = { ...t, name: stripDecoration(t.name) };
  const address = materialAddressFromPdfText(t.materialText);
  const img = t.materials.find((m) => m.kind === "pickup_page") ?? t.materials.find((m) => m.kind === "sent_image") ?? t.materials[0] ?? null;
  return {
    key: keyOf(t.name, room),
    name: t.name,
    room,
    label: room ? `${t.name} ${room}号室` : t.name,
    imageUrl: img?.url ?? null,
    address,
    addressHasBanchi: !!address && hasBanchi(address),
    source: t.source,
    sourceLabel: t.sourceLabel,
    at: t.at,
    ended: t.ended,
    dealStatus: t.dealStatus,
    customerPointed: CUSTOMER_SOURCES.has(t.source),
  };
}

/** 見積書作成と同じ選び（target → candidates → others）を候補の並びにする（名前の無い物・同じ物は1つ） */
export function viewingCandidatesFromChoice(choice: Pick<EstimateTargetChoice, "target" | "candidates" | "others"> | null | undefined): ViewingPropertyCandidate[] {
  if (!choice) return [];
  const out: ViewingPropertyCandidate[] = [];
  for (const t of [choice.target, ...choice.candidates, ...choice.others]) {
    if (!t || stripDecoration(t.name ?? "").length < 2 || NOT_PROPERTY_RE.test(stripDecoration(t.name ?? ""))) continue;
    const c = toCandidate(t);
    // 同じお部屋（建物名の芯が含み合う・号室が同じか片方なし）は1つに寄せ、先の方に無い所在地・資料を後の方から補う
    //   （ゆいと: 引用で決まった「ディアコート曽根 302」は所在地なし・送付の記録の「★築浅★…ディアコート曽根 302」に所在地あり）
    const same = out.find((x) => candidateMatchesName(x, c.name, c.room) && (!x.room || !c.room || x.room === c.room));
    if (same) {
      if (!same.address && c.address) { same.address = c.address; same.addressHasBanchi = c.addressHasBanchi; }
      if (!same.imageUrl && c.imageUrl) same.imageUrl = c.imageUrl;
      if (!same.room && c.room) { same.room = c.room; same.label = `${same.name} ${c.room}号室`; same.key = keyOf(same.name, c.room); }
      continue;
    }
    out.push(c);
  }
  return out.slice(0, 10);
}

/** お客様の発言が「追加の内覧」の形か（ここも／こちらも／〇〇も行けますか・一緒に） */
const ADDITION_RE = /(?:ここ|こちら|そこ|そちら|これ|この(?:物件|お部屋|部屋))も|も(?:一緒に|あわせて|合わせて|併せて)?\s*(?:行け|いけ|見|内覧|内見|見学|案内)|追加で/;
export function isAdditionalViewingRequest(customerText: string | null | undefined): boolean {
  return ADDITION_RE.test(String(customerText ?? "").normalize("NFKC"));
}

/** 欄の物件名（「〇〇 203号室」「〇〇203」）がその候補か */
export function candidateMatchesName(c: ViewingPropertyCandidate, name: string | null | undefined, room?: string | null): boolean {
  const raw = String(name ?? "").normalize("NFKC").trim();
  if (raw.length < 2) return false;
  const m = raw.match(/^(.*?)[\s　]*([0-9]{2,4}[A-Za-z]?)(?:号室)?$/);
  const n = m ? m[1] : raw;
  const r = room ?? (m ? m[2] : null);
  const a = keyOf(c.name, null).split("|")[0];
  const b = keyOf(n, null).split("|")[0];
  // 含み合う（建物の番号 Ⅱ・III・2号館 が違えば別＝「ドミール桜川III」と「ドミール桜川II」）・または property-name-match の線 0.7 で近い（迷う物は寄せない）
  if (a.length < 2 || b.length < 2) return false;
  const contains = (a.includes(b) || b.includes(a)) && buildingNumeral(c.name) === buildingNumeral(n);
  if (!contains && !matchKnownProperty(n, [c.name], MATCH_MIN_SCORE)) return false;
  const rn = (s: string | null | undefined) => String(s ?? "").replace(/号室?$/, "").replace(/^0+/, "");
  return !r || !c.room || rn(r) === rn(c.room);
}

export type ViewingPickMode = "meeting" | "guide" | "invite";
export type ViewingPreselect = { keys: string[]; reason: string };

/**
 * 開いた時に先に選ぶ候補（決定論・推測しない）。
 *   meeting … 欄に既に入った物件名（1件目の決まり）と同じ候補 → それ。無ければお客様の発言で決まった物件（追加の内覧の形なら選ばない）
 *   guide   … お客様の発言で決まった物件（複数可）
 *   invite  … 欄に入った物件名と同じ候補 → それ。無ければお客様の発言で決まった物件
 */
export function preselectViewingCandidates(cands: ReadonlyArray<ViewingPropertyCandidate>, o: {
  mode: ViewingPickMode;
  /** お客様の最新の発言（latestCustomerTurnText） */
  customerText?: string | null;
  /** 欄に既に入っている物件名 */
  currentName?: string | null;
  /** お客様の最新の発言（連投）の始まりの時刻。渡した時は、その発言の中の引用・名前・持ち込みで決まった物件だけ先に選ぶ（前の日の引用を持ち越さない） */
  turnStartAt?: string | null;
}): ViewingPreselect {
  if (o.mode !== "guide" && o.currentName) {
    const hit = cands.find((c) => candidateMatchesName(c, o.currentName));
    if (hit) return { keys: [hit.key], reason: "欄に入った物件名（会話の決まり）と同じお部屋" };
  }
  const since = o.turnStartAt ? Date.parse(o.turnStartAt) : NaN;
  const pointed = cands.filter((c) => c.customerPointed && !c.ended
    && (!Number.isFinite(since) || (!!c.at && Date.parse(c.at) >= since - 1000)));
  if (!pointed.length) return { keys: [], reason: "" };
  if (o.mode === "meeting" && isAdditionalViewingRequest(o.customerText)) {
    return { keys: [], reason: `お客様の「${String(o.customerText ?? "").trim().slice(0, 20)}」は追加の内覧（${pointed[0].label}）＝待ち合わせ（1件目）には先に選んでいません` };
  }
  const keys = o.mode === "guide" ? pointed.map((c) => c.key) : [pointed[0].key];
  return { keys, reason: pointed[0].sourceLabel };
}

/** お客様の最新の発言（最後のスタッフ発言より後の連投・最後がスタッフならその前の連投）の始まりの時刻（viewing-date-request.latestCustomerTurnText と同じ区切り） */
export function latestCustomerTurnStartAt(messagesOldestFirst: ReadonlyArray<{ sender?: string | null; rawCreatedAt?: string | null; createdAt?: string | null; created_at?: string | null }>): string | null {
  let end = messagesOldestFirst.length - 1;
  while (end >= 0 && messagesOldestFirst[end].sender !== "customer") end--;
  if (end < 0) return null;
  let start = end;
  while (start - 1 >= 0 && messagesOldestFirst[start - 1].sender === "customer") start--;
  const m = messagesOldestFirst[start];
  return m.rawCreatedAt ?? m.createdAt ?? m.created_at ?? null;
}

/**
 * 内覧誘導の物件の枠（複数）に候補を入れる／外す。入れる時は空いている最初の枠（無ければ足す）、外す時はその物件の枠を空にする
 * （枠が2つ以上ある時は枠ごと消す）。images は枠と同じ並びの資料の画像。
 */
export function toggleCandidateInSlots(
  slots: ReadonlyArray<{ name: string; roomNumber: string }>,
  images: ReadonlyArray<string>,
  c: ViewingPropertyCandidate,
  select: boolean,
): { slots: Array<{ name: string; roomNumber: string }>; images: string[] } {
  const s = slots.map((x) => ({ ...x }));
  const im = slots.map((_, i) => images[i] ?? "");
  const idx = s.findIndex((x) => candidateMatchesName(c, x.name, x.roomNumber || null));
  if (select) {
    if (idx >= 0) return { slots: s, images: im };
    const empty = s.findIndex((x) => !x.name.trim());
    const v = { name: c.name, roomNumber: c.room ?? "" };
    if (empty >= 0) { s[empty] = v; im[empty] = c.imageUrl ?? ""; }
    else { s.push(v); im.push(c.imageUrl ?? ""); }
    return { slots: s, images: im };
  }
  if (idx < 0) return { slots: s, images: im };
  if (s.length > 1) { s.splice(idx, 1); im.splice(idx, 1); }
  else { s[idx] = { name: "", roomNumber: "" }; im[idx] = ""; }
  return { slots: s, images: im };
}
