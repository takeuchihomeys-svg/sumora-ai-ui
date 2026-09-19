// app/lib/viewing-thread.ts
// 「内覧の流れが続いているか」を会話から決定論で判定し、AIX【物件確認した】の会話を合わせるの締めを縛る（純関数・DB 依存なし）。
//
// 2026-09-16 竹内（カイナ事例）「会話を合わせるおしたら会話の内容と合わせた実際に送ったような内容（内覧の話しだったので内覧）で LINE 送るようにする。
//   会話を合わせるで重要な部分を読めていなかった可能性がある。根本的な部分を改善する」:
//   前日にこちらが内覧を提案（9/16 15:30〜17:00・返事待ち）→ お客様が別物件の画像で「この物件対応できますか」→ 物件確認した（物件あった・御見積書なし・
//   資料3枚）の会話を合わせるが「最大限割引しました初期費用の御見積書作成しお送りさせて頂きます」で締めた。実送信は
//   「こちらの3部屋現在募集中となっております！！／よろしければご案内させて頂きます！！」。
//   原因（Fable5 の調査）: ①会話の糸口（内覧打診中・お客様が見たいと言っている）を決定論で拾って締めを縛る層が無い ②「入れなかった事柄」
//   （御見積書なし・部屋数）を約束させない指示が無い ③通常返信用の規則（物件画像→御見積書の作成宣言・内覧案内を混ぜるな）が会話を合わせる経路にも
//   流れ込み、ブレインの avoid_topics「見積書」は参考扱いで負けた ④画面の「内覧誘導」は新しい日程を出す専用で「打診中の続き」を表す入力が無い。
//   実データ（180日・生成⇄実送信 193ペア）: 生成は御見積書を約束する型（141件）、内覧の流れがある会話では実送信で内覧語が足される（13件 vs 流れなし4件）。
//   複数の資料を送った時は「こちらN件／N部屋」と書くのがスタッフの型（入力に複数物件がある13件で77%）
import { parseCandidateSlots } from "./viewing-hold";

export type ThreadMsg = { sender: string; text?: string | null; rawCreatedAt?: string | null };
export type ViewingThreadKind = "proposed_waiting_reply" | "customer_wants_viewing" | "scheduled" | "none";
export type ViewingThreadVerdict = {
  /** 内覧の流れが続いている（締めを内覧の続きにする） */
  pending: boolean;
  kind: ViewingThreadKind;
  proposalText: string;
  proposedAtMs: number | null;
  /** こちらが提案した候補（「9/16(水) 15:30〜17:00」） */
  slots: string[];
  /** お客様の内覧の希望の言葉（「こちら1度見てみたいです！」） */
  customerWish: string | null;
  /** 「2部屋とも」のような部屋数 */
  roomsWanted: number | null;
  reason: string;
};

const nfkc = (s: string | null | undefined) => (s ?? "").normalize("NFKC");
export const MEDIA_RE = /^\[(?:画像|動画|スタンプ|ファイル)/;
/** こちらの内覧の打診（日程を出して都合を聞いた）。「ご案内させて頂きます」単独・「お部屋のご案内もさせていただきます」は打診にしない */
export const STAFF_VIEWING_PROPOSAL_RE = /(?:ご内覧|内覧|内見|ご案内).{0,25}(?:如何|いかが|ご都合)|ご都合(?:の)?よろしいお日にち|ご案内可能です|直近ですと|\d{1,2}[:時]\d{0,2}.{0,12}(?:ご案内|案内可能)/;
/** お客様の内覧の希望 */
export const CUSTOMER_VIEWING_WISH_RE = /見に行き|見に行け|内覧|内見|見学|見てみたい|見たいです|拝見|見させて|(?:案内|ご案内)(?:して|お願い|希望)/;
const CUSTOMER_WISH_NEGATE_RE = /まだ|考えて(?:い)?ません|考えてない|後で|いったん|一旦|しません|しないです/;
/** 提案した日時の受諾（行全体の一致は「この物件もお願いします」を受諾にしないため） */
export const CUSTOMER_SLOT_ACCEPT_RE = /(?:\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}[:時]\d{0,2}|明日|明後日|本日|今日|その(?:日|時間|お時間))[^\n]{0,20}(?:大丈夫|お願い|伺|行け|いけ|可能|OK)|^(?:はい[、。]?)?(?:大丈夫です|お願いします|伺います|向かいます|行けます)[！!。😊]*$/m;
export const CUSTOMER_VIEWING_CANCEL_RE = /キャンセル|中止|(?:やめ|辞め)(?:ます|たい|ておき)|見送|行けなく|難しく|都合が(?:悪|つか)|延期|また今度|別日|他の日/;
const STAFF_MEETING_PLACE_RE = /待ち合わせ|集合(?:場所|時間)|現地(?:集合|にて)|(?:駅|改札)[^\n]{0,10}(?:集合|お待ち)/;
const STAFF_VIEWING_DONE_RE = /(?:本日|昨日)(?:は)?(?:お時間|ご内覧)(?:を)?(?:頂|いただ)き(?:まして)?ありがとうございました/;
const ROOMS_WANTED_RE = /([2-9])\s*(?:部屋|件|室)(?:とも|共|全て|すべて)/;
/** 御見積書の「これからの約束」（同封させて頂きました・お送りさせて頂きました の過去形は当たらない） */
export const ESTIMATE_PROMISE_LINE_RE = /見積[^\n]{0,24}(?:作成|お送り|送付|ご用意|とあわせて|と合わせて)[^\n]{0,16}(?:させて(?:頂|いただ)きます|いたします|致します|ご連絡)/;
/** 新しい内覧日時の行 */
export const NEW_SLOT_LINE_RE = /直近ですと|ご都合(?:の)?よろしいお日にち|ご案内可能です|^\s*(?:明日|明後日|本日)?\s*\d{1,2}\/\d{1,2}\s*[（(]|\d{1,2}:\d{2}\s*[〜~～]\s*\d{1,2}:\d{2}/m;
/** 内覧の続きの一文（カイナの実送信そのまま） */
export const VIEWING_CONTINUATION_LINE = "よろしければご案内させて頂きます！！";
const HOUR_MS = 3600_000;

/**
 * 内覧の流れの判定。messages は古い順。窓は rawCreatedAt から48時間（無い発言は「今」扱い・全て無ければ末尾 fallbackLookback 件）
 */
export function resolveViewingThread(
  messagesOldestFirst: readonly ThreadMsg[],
  opts: { nowMs?: number; windowHours?: number; fallbackLookback?: number } = {},
): ViewingThreadVerdict {
  const nowMs = opts.nowMs ?? Date.now();
  const windowHours = opts.windowHours ?? 48;
  const fallbackLookback = opts.fallbackLookback ?? 12;
  const none = (reason: string, kind: ViewingThreadKind = "none"): ViewingThreadVerdict =>
    ({ pending: false, kind, proposalText: "", proposedAtMs: null, slots: [], customerWish: null, roomsWanted: null, reason });

  const anyTs = messagesOldestFirst.some((m) => m.rawCreatedAt && Number.isFinite(Date.parse(m.rawCreatedAt)));
  const tsOf = (m: ThreadMsg): number | null => (m.rawCreatedAt && Number.isFinite(Date.parse(m.rawCreatedAt)) ? Date.parse(m.rawCreatedAt) : null);
  const fromMs = nowMs - windowHours * HOUR_MS;
  let reasonSuffix = "";
  const inWindow: Array<{ m: ThreadMsg; i: number }> = anyTs
    ? messagesOldestFirst.map((m, i) => ({ m, i })).filter(({ m }) => { const t = tsOf(m); return t === null ? true : t >= fromMs; })
    : (() => { reasonSuffix = "+fallback_lookback"; const start = Math.max(0, messagesOldestFirst.length - fallbackLookback); return messagesOldestFirst.slice(start).map((m, k) => ({ m, i: start + k })); })();
  const textOf = (m: ThreadMsg) => nfkc(m.text).trim();
  const isText = (m: ThreadMsg) => !!textOf(m) && !MEDIA_RE.test(textOf(m));

  // (b) 最後の打診
  let p: { m: ThreadMsg; i: number } | null = null;
  for (const x of inWindow) if (x.m.sender === "staff" && isText(x.m) && STAFF_VIEWING_PROPOSAL_RE.test(textOf(x.m))) p = x;
  const wishOf = (list: readonly ThreadMsg[]): string | null => {
    let wish: string | null = null;
    for (const m of list) {
      if (m.sender !== "customer" || !isText(m)) continue;
      for (const s of textOf(m).split(/\n|(?<=[。！!？?])/).map((x) => x.trim()).filter(Boolean)) {
        if (CUSTOMER_VIEWING_WISH_RE.test(s) && !CUSTOMER_WISH_NEGATE_RE.test(s)) wish = s.slice(0, 60);
      }
    }
    return wish;
  };
  if (p) {
    const after = messagesOldestFirst.slice(p.i + 1);
    // (c) 打診の後のこちらの発言
    for (const m of after) {
      if (m.sender !== "staff" || !isText(m)) continue;
      if (STAFF_VIEWING_DONE_RE.test(textOf(m))) return none("viewing_done" + reasonSuffix);
      if (STAFF_MEETING_PLACE_RE.test(textOf(m))) return none("meeting_place_sent" + reasonSuffix, "scheduled");
    }
    // (d) 打診の後のお客様の発言
    for (const m of after) {
      if (m.sender !== "customer" || !isText(m)) continue;
      if (CUSTOMER_VIEWING_CANCEL_RE.test(textOf(m))) return none("customer_cancelled" + reasonSuffix);
      if (CUSTOMER_SLOT_ACCEPT_RE.test(textOf(m))) return none("customer_accepted" + reasonSuffix, "scheduled");
    }
    // (e) 候補の枠が全部過ぎている（返事も無い）
    const slotsParsed = parseCandidateSlots(textOf(p.m), tsOf(p.m) ?? nowMs);
    const slots = slotsParsed.map((s) => s.label);
    if (slotsParsed.length > 0 && slotsParsed.every((s) => Date.parse(`${s.ymd}T${s.end}:00+09:00`) + 3 * HOUR_MS < nowMs)) return none("slots_expired" + reasonSuffix);
    // (f) 打診済み・返事待ち
    const before = messagesOldestFirst.slice(Math.max(0, p.i - 6), p.i + 1);
    const rw = textOf(p.m).match(ROOMS_WANTED_RE);
    return {
      pending: true, kind: "proposed_waiting_reply", proposalText: textOf(p.m), proposedAtMs: tsOf(p.m), slots,
      customerWish: wishOf([...before, ...after]), roomsWanted: rw ? Number(rw[1]) : null, reason: "staff_proposed_no_reply" + reasonSuffix,
    };
  }
  // (g) 打診は無いがお客様が内覧を希望している（その後にキャンセルが無い）
  const custMsgs = inWindow.map((x) => x.m);
  const wish = wishOf(custMsgs);
  if (wish) {
    let lastWishIdx = -1, cancelAfter = false;
    custMsgs.forEach((m, i) => { if (m.sender === "customer" && isText(m) && CUSTOMER_VIEWING_WISH_RE.test(textOf(m)) && !CUSTOMER_WISH_NEGATE_RE.test(textOf(m))) lastWishIdx = i; });
    custMsgs.slice(lastWishIdx + 1).forEach((m) => { if (m.sender === "customer" && isText(m) && CUSTOMER_VIEWING_CANCEL_RE.test(textOf(m))) cancelAfter = true; });
    if (!cancelAfter) return { pending: true, kind: "customer_wants_viewing", proposalText: "", proposedAtMs: null, slots: [], customerWish: wish, roomsWanted: null, reason: "customer_wish_no_proposal" + reasonSuffix };
  }
  return none("no_viewing_thread" + reasonSuffix);
}

/** LLM に渡す糸口のブロック（active=false なら空） */
export function buildViewingThreadBlock(
  v: ViewingThreadVerdict,
  // 2026-09-19 竹内「実際の成約データや直近でスタッフが書き直したのも参考にして」:
  //   lineForced = スタッフが画面で「流れを続ける」を選んだか。**自動判定では締めの1文を書かせない**。
  //   実送信365日 11,918通中「よろしければご案内させて頂きます」は1件（この仕組みの元にしたカイナのその1通）で、
  //   自動判定で毎回書かせた結果、会話を合わせる51件の49%でスタッフが削っていた。
  //   日程を出さない縛りは自動判定のまま（提案中にもう一度日程を出すのは実害がある）。
  opts: { customerName: string; estimateEnclosed: boolean; active: boolean; staffForced: boolean; lineForced?: boolean },
): string {
  if (!opts.active) return "";
  const lines: string[] = ["【会話の糸口: 内覧の流れが続いている（確定事実・締めはこれに合わせる）】"];
  if (v.kind === "proposed_waiting_reply") {
    lines.push(`・こちらが ${v.slots.length ? v.slots.join(" / ") : "内覧"} のご案内を提案済み（お客様の返事待ち）${v.customerWish ? `／お客様:「${v.customerWish}」` : ""}${v.roomsWanted ? `（${v.roomsWanted}部屋）` : ""}`);
  } else if (v.kind === "customer_wants_viewing") {
    lines.push(`・お客様が内覧を希望している:「${v.customerWish ?? ""}」（日程はまだ出していない）`);
  } else if (opts.staffForced) {
    lines.push("・スタッフの指定: お客様と内覧の話が進んでいる");
  } else {
    return "";
  }
  lines.push(
    opts.lineForced
      ? `・今回確認した物件はこの内覧の続きとして扱う → 締めは「${VIEWING_CONTINUATION_LINE}」の1文だけ。新しい日時・「ご都合よろしいお日にち」「直近ですと」は書かない（日程は AIX【内覧日調整】で送る）`
      : "・今回確認した物件はこの内覧の続きとして扱う → **新しい日時・「ご都合よろしいお日にち」「直近ですと」は書かない**（日程は AIX【内覧日調整】で送る）。"
        + "内覧のご案内・お申込み等の**次の一手も書かない**（結果の報告で終え、同封しているなら「お手隙の際にご査収ください😌！！」で締める）",
  );
  if (!opts.estimateEnclosed) lines.push("・この返信に御見積書は同封しない → 「御見積書を作成しお送りします」「お見積書とあわせてご連絡」等の約束は書かない（御見積書は別の AIX）");
  return lines.join("\n");
}

/** 御見積書を同封しない時、御見積書の「これからの約束」の行を落とす（直後の同じ段落の「ご査収ください」も一緒に） */
export function stripEstimatePromiseLines(text: string, opts: { estimateEnclosed: boolean }): { text: string; removed: string[] } {
  if (opts.estimateEnclosed) return { text, removed: [] };
  const lines = text.split("\n");
  const removed: string[] = [];
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (ESTIMATE_PROMISE_LINE_RE.test(nfkc(l))) {
      removed.push(l.trim());
      const next = lines[i + 1];
      if (next !== undefined && next.trim() && /ご査収|ご確認ください/.test(next)) { removed.push(next.trim()); i++; }
      continue;
    }
    out.push(l);
  }
  if (removed.length === 0) return { text, removed };
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

/** 新しい内覧日時の行を落とす（「よろしければご案内させて頂きます」は残る） */
export function stripNewSlotLines(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const kept = text.split("\n").filter((l) => { if (NEW_SLOT_LINE_RE.test(nfkc(l))) { removed.push(l.trim()); return false; } return true; });
  if (removed.length === 0) return { text, removed };
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

/** 内覧の続きの一文が無ければ足す（ご査収の行の前・改行1つ＝カイナの実送信は募集中の行の直後） */
export function ensureViewingContinuationLine(text: string, active: boolean): { text: string; added: string | null } {
  if (!active || /ご案内|内覧|内見/.test(text)) return { text, added: null };
  const lines = text.split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/ご査収|ご確認ください/.test(lines[i])) { idx = i; break; }
  if (idx < 0) return { text: `${text.trimEnd()}\n${VIEWING_CONTINUATION_LINE}`, added: VIEWING_CONTINUATION_LINE };
  const before = lines.slice(0, idx).join("\n").trimEnd();
  return { text: `${before}\n${VIEWING_CONTINUATION_LINE}\n${lines.slice(idx).join("\n")}`, added: VIEWING_CONTINUATION_LINE };
}

export type EnclosedRooms = { rooms: number | null; docs: number; source: "room_counts" | "cards" | "staff_note" | null };
/** 今回募集中と伝える部屋数（スタッフの入力＝正。資料の枚数から部屋数を推定しない） */
export function resolveEnclosedRooms(input: { propertyCount: number; roomCounts?: ReadonlyArray<number | null> | null; imageCount: number; staffNote?: string }): EnclosedRooms {
  const docs = Math.max(0, input.imageCount);
  const n = Math.max(0, input.propertyCount);
  const rc = input.roomCounts ?? null;
  if (rc && rc.slice(0, n).some((x) => typeof x === "number" && x >= 1)) {
    const rooms = rc.slice(0, n).reduce<number>((a, x) => a + (typeof x === "number" && x >= 1 ? x : 1), 0);
    return { rooms, docs, source: "room_counts" };
  }
  if (n >= 2) return { rooms: n, docs, source: "cards" };
  const m = nfkc(input.staffNote).match(/([2-9])\s*(?:部屋|件|室)/);
  if (m) return { rooms: Number(m[1]), docs, source: "staff_note" };
  return { rooms: null, docs, source: null };
}

export function buildEnclosedCountLines(r: EnclosedRooms): string[] {
  if (r.rooms !== null && r.rooms >= 2) return [`・今回募集中と伝えるお部屋の数: ${r.rooms}部屋 → 「こちらの${r.rooms}部屋現在募集中となっております！！」のように件数を本文に入れる`];
  if (r.rooms === null && r.docs >= 2) return [`・資料${r.docs}枚を同封（部屋数はスタッフの入力に無いので「${r.docs}部屋」「${r.docs}件」と数は書かない）`];
  return [];
}

/** 部屋数が本文に無ければ「募集中」の最初の行に「こちらのN部屋」を差し込む */
export function ensureRoomCountPhrase(text: string, rooms: number | null): { text: string; fixed: boolean } {
  if (rooms === null || rooms < 2 || /\d+\s*(?:部屋|件|室)/.test(nfkc(text))) return { text, fixed: false };
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => /募集中/.test(l));
  if (idx < 0) return { text, fixed: false };
  const replaced = lines[idx].replace(/(現在(?:も)?)?(募集中)/, (_m, cur: string | undefined, b: string) => `こちらの${rooms}部屋${cur ?? ""}${b}`);
  if (replaced === lines[idx]) return { text, fixed: false };
  lines[idx] = replaced;
  return { text: lines.join("\n"), fixed: true };
}
