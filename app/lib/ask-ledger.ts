// app/lib/ask-ledger.ts — 要件の帳面（この番のお客様の要件1つずつに id と「何通目で答えるか」を付け、組・書き手・AIX のブレイン・送った記録・次の番が同じ id で読む）
//   純関数・DB/LLM なし・画面とサーバーの両方から読める。作業員M・2026-11-15。
//
// 竹内さん 11/15（強い順）:
//   1「どの部分を返信で答えているか、どの部分は AIX で送る必要があるから AIX で送るかを把握する。細かく細分化して強化」（P0 ca55d42b の要件の単位）
//   2「2行に分けている場合や、返信と AIX で分けて繋いでいる部分も具体的に強化・土台と細分化」「統括が把握できるように連携も細かく」
//   3「前の返信の内容・前に送った文を把握する部分が弱い可能性」「組み合わせを把握する部分が弱い可能性」
// 統括役の決定（11/15）: 新しい帳面を作らず、turn_contract.asks（quote・kind・route・aix・basis・about・property）に
//   「要件の id」と「何通目で答えるか（msg）」を足す。何通目は two-message-plan（組み立て）の通の番号＝組と同じ物差し。
//
// id の決め方: お客様の言葉（quote）を正規化して短い hash＝誰が計算しても同じ（組・書き手・AIX のブレイン・送った記録・次の番が別々に計算しても一致）。
//   ブレインが次の番で言い回しを少し変えた時は、前の番の帳面の id を引き継ぐ（matchPrevId・先頭6字の重なり＝turn-contract.buildTurnContract と同じ決まり）。
//
// 確かめる3つ（checkAskLedger）:
//   取りこぼし dropped  … 行き先（reply/promise/aix）があるのに、どの通も答えない
//   重ね       doubled  … 返信の通と AIX の通の両方が同じ要件に答える（約束→後で結果の AIX は重ねではない）
//   取り違え   misrouted… AIX の番（スタッフだけが知る事）を返信の通で答える／空き・募集状況を返信で答える
// 送った所まで（progressAfterSends＝継ぎ目②の純関数）: 実際に送った通（返信／AIX の種類）を組み立てに当て、答えた要件・約束した要件・残りの要件・次の通を出す。
// 次の番（openAsksFrom）: まだ答えていない要件（残り）と、約束して結果がまだの要件を id のまま渡す。
//
// スイッチ ASK_LEDGER（11/18 から既定 shadow・off＝何もしない／shadow＝meta.ask_ledger に記録だけ／on＝記録＋meta.turn_contract.asks に id・msg を書き足す）。
//   on でも道（返信か AIX か）と組み立ては決め直さない（読んで番号を付けるだけ・KB 0dbfbc97「後の役は決め直さない」）。
// テスト: app/lib/__tests__/ask-ledger.test.ts

import { planFromMeta, planMessages, aixFamilyKey, type PlanAsk, type PlanSlot, type TwoMessagePlan } from "./two-message-plan";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

export type AskLedgerMode = "off" | "shadow" | "on";
export function askLedgerMode(env: Env = envOf()): AskLedgerMode {
  // 2026-11-18 作業員M（統括役の案）: 既定 shadow＝meta.ask_ledger に記録だけ（道・組み立て・プロンプトは変えない・Haiku の差分の材料からは外してある）。
  //   試験 M1115-aixaix-p1/p2 は ASK_LEDGER=shadow を入れて確かな悪化0。止める ASK_LEDGER=off／asks に id・msg を書き足すのは =on
  const v = (env.ASK_LEDGER ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "shadow";
}

/** 要件の言葉の正規化（空白・句読点・括弧を落とす）。turn-contract.buildTurnContract の keyOf と同じ落とし方（長さは切らない） */
export function askKeyOf(quote: string | null | undefined): string {
  return String(quote ?? "").normalize("NFKC").replace(/[\s。、，,．.！!？?「」『』（）()【】・…〜~ー-]/g, "");
}
/** 要件の id（"q" + 正規化した言葉の FNV-1a 32bit の36進）。同じ言葉なら誰が計算しても同じ */
export function askIdOf(quote: string | null | undefined): string {
  const s = askKeyOf(quote);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `q${h.toString(36).padStart(7, "0")}`;
}
/** 前の番の帳面の要件と同じ要件か（先頭6字が相手に含まれる＝turn-contract の重ね合わせと同じ決まり）。同じなら前の id、無ければ null */
export function matchPrevId(quote: string, prev: ReadonlyArray<{ id: string; quote: string }> | null | undefined): string | null {
  const k = askKeyOf(quote);
  if (!k || !prev?.length) return null;
  for (const p of prev) {
    const x = askKeyOf(p.quote);
    if (!x) continue;
    if (x === k || x.includes(k.slice(0, 6)) || k.includes(x.slice(0, 6))) return p.id;
  }
  return null;
}

export type AskRoute = "reply" | "promise" | "aix" | "none";
export type AskEntry = {
  id: string;
  quote: string;
  kind: string | null;
  route: AskRoute;
  aix: string | null;
  about: string | null;
  basis: string | null;
  /** 何通目で答えるか（この番の組み立ての通の番号・1始まり）。答える通が無い・none は null */
  msg: number | null;
  /** その通の種類（返信／AIX／AIX テンプレート） */
  slot: PlanSlot | null;
  /** 2つ以上の通に載っている時の、残りの通の番号（重ねの印） */
  alsoMsg?: number[];
  /** 約束（確認・作成・探す）＝結果は後の番の AIX で果たす */
  later: boolean;
  /** 前の番の帳面から引き継いだ id か */
  carried?: boolean;
};
export type AskIssueCode = "dropped" | "doubled" | "misrouted";
export type AskIssue = { id: string; code: AskIssueCode; why: string };
export type AskCheck = { ok: boolean; dropped: string[]; doubled: string[]; misrouted: string[]; issues: AskIssue[] };
export type AskLedger = {
  v: 1;
  /** この帳面が見た一番新しいお客様の発言の時刻（meta.analyzed_msg_ts・古さの見分け） */
  seen_customer_at: string | null;
  /** 組み立ての型（R・A・AT・RAT・AR・ATR・RAR）と通の数 */
  shape: string;
  count: number;
  /** 組み立ての出所（統括が置いた meta.two_message_plan か、ここで作り直したか） */
  plan_from: "meta" | "rebuilt";
  /** ブレインの最終の AIX（meta.action の鍵の頭・無ければ null） */
  final_aix: string | null;
  /** 通ごとの種類と AIX（送った所までを当てる時に使う） */
  msgs: Array<{ no: number; slot: PlanSlot; aix: string | null }>;
  items: AskEntry[];
  check: AskCheck;
  /** 短い印（記録・試験の数え用）: 例 "3:m1r,m2a,-|d1" */
  digest: string;
};

const ROUTES = new Set<AskRoute>(["reply", "promise", "aix", "none"]);
const str = (v: unknown, n = 60): string | null => (typeof v === "string" && v.trim() && v !== "null" ? v.trim().slice(0, n) : null);
const baseKey = (k: unknown): string | null => { const s = String(k ?? "").split("/")[0].trim(); return s && s !== "null" ? s : null; };
const isAixSlot = (s: PlanSlot | null | undefined) => s === "aix" || s === "aix_template";

/** 生の asks（meta.turn_contract.asks の形）を、組み立ての入力の形にそろえる（壊れた行は落とす） */
export function asksOf(raw: unknown): PlanAsk[] {
  const xs = Array.isArray(raw) ? raw : [];
  return xs.filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && typeof (a as { quote?: unknown }).quote === "string" && !!(a as { quote: string }).quote.trim())
    .map((a) => ({
      quote: String(a.quote),
      route: ROUTES.has(String(a.route) as AskRoute) ? String(a.route) : "reply",
      answer: str(a.answer),
      aix: str(a.aix),
      about: str(a.about, 30),
      kind: str(a.kind, 20),
      ...(str(a.basis, 20) ? { basis: str(a.basis, 20) } : {}),
    })) as PlanAsk[];
}

/**
 * 組み立てと asks から帳面を作る（純関数）。plan が無ければ planMessages で作る（aix-template-generate・reply-compose-conductor と同じ作り方＝同じ番号になる）。
 *   prev: 前の番の帳面の items（言い回しの変わった同じ要件の id を引き継ぐ）
 */
export function buildAskLedger(i: {
  asks: ReadonlyArray<PlanAsk> | null | undefined;
  plan?: TwoMessagePlan | null;
  finalAix?: string | null;
  seenCustomerAt?: string | null;
  prev?: ReadonlyArray<{ id: string; quote: string }> | null;
}): AskLedger {
  const asks = (i.asks ?? []).filter((a) => a && typeof a.quote === "string" && a.quote.trim());
  const planFrom: AskLedger["plan_from"] = i.plan ? "meta" : "rebuilt";
  const plan = i.plan ?? planMessages({ asks, finalAix: i.finalAix ?? null });
  const q = (a: PlanAsk) => a.quote.slice(0, 40); // two-message-plan の answers と同じ切り方
  const used = new Set<string>();
  const items: AskEntry[] = asks.map((a) => {
    const prevId = matchPrevId(a.quote, i.prev);
    let id = prevId ?? askIdOf(a.quote);
    // 同じ番の中で同じ id（同じ言葉の要件が2つ）は2つ目に印を足して分ける
    if (used.has(id)) { let n = 2; while (used.has(`${id}_${n}`)) n++; id = `${id}_${n}`; }
    used.add(id);
    const hits = plan.messages.filter((m) => m.answers.includes(q(a)));
    const route = (ROUTES.has(a.route as AskRoute) ? a.route : "reply") as AskRoute;
    const first = route === "none" ? null : hits[0] ?? null;
    const also = route === "none" ? [] : hits.slice(1).map((m) => m.no);
    return {
      id, quote: a.quote.slice(0, 40), kind: a.kind ?? null, route, aix: baseKey(a.aix), about: a.about ?? null,
      basis: (a as { basis?: string | null }).basis ?? null,
      msg: first ? first.no : null, slot: first ? first.slot : null,
      ...(also.length ? { alsoMsg: also } : {}),
      later: route === "promise",
      ...(prevId ? { carried: true } : {}),
    };
  });
  const finalAix = baseKey(i.finalAix);
  const check = checkAskLedger(items, plan, finalAix);
  const digest = `${items.length}:${items.map((e) => (e.msg ? `m${e.msg}${e.slot === "reply" ? "r" : e.slot === "aix" ? "a" : "t"}` : "-")).join(",")}${check.ok ? "" : `|${check.dropped.length ? `d${check.dropped.length}` : ""}${check.doubled.length ? `w${check.doubled.length}` : ""}${check.misrouted.length ? `x${check.misrouted.length}` : ""}`}`;
  return {
    v: 1, seen_customer_at: i.seenCustomerAt ?? null, shape: plan.shape, count: plan.count, plan_from: planFrom, final_aix: finalAix,
    msgs: plan.messages.map((m) => ({ no: m.no, slot: m.slot, aix: m.aix ?? null })), items, check, digest,
  };
}

/**
 * 取りこぼし・重ね・取り違えの確かめ（純関数）。
 *   plan があれば「その通が実際に載せている要件」も見る（items の msg と alsoMsg から読めるので無くてもよい）。
 */
export function checkAskLedger(items: ReadonlyArray<AskEntry>, plan?: TwoMessagePlan | null, finalAix?: string | null): AskCheck {
  const issues: AskIssue[] = [];
  const slotOf = (no: number): PlanSlot | null => plan?.messages.find((m) => m.no === no)?.slot ?? null;
  const aixOfMsg = (no: number): string | null => plan?.messages.find((m) => m.no === no)?.aix ?? null;
  for (const e of items) {
    if (e.route === "none") continue;
    if (e.msg == null) {
      issues.push({ id: e.id, code: "dropped", why: `行き先は${ROUTE_JA[e.route]}なのに、どの通も「${e.quote.slice(0, 16)}」に答えていない` });
      continue;
    }
    // 重ね: 返信の通と AIX の通の両方に載っている（同じ側の2通は重ねにしない＝AIX→テンプレートで中身を続けるのは竹内さんの AT）
    if (e.alsoMsg?.length && plan) {
      const sides = new Set([e.slot, ...e.alsoMsg.map(slotOf)].map((s) => (isAixSlot(s) ? "aix" : "reply")));
      if (sides.size > 1) issues.push({ id: e.id, code: "doubled", why: `返信と AIX の両方が「${e.quote.slice(0, 16)}」に答える（${[e.msg, ...e.alsoMsg].join("・")}通目）` });
    }
    // 取りこぼし②: AIX の要件が2種類あるのに、AIX の通は1つ目の AIX だけ（組み立ては AIX を1つしか持たない）＝2つ目の AIX を送る通が無い
    const mAix = aixOfMsg(e.msg);
    //   内覧調整・待ち合わせの席が確認の要件を文の中で受ける形（TWO_MESSAGE_SEAT_FOLLOWS_FINAL の (i)・viewCheckInAix）は取りこぼしにしない
    const foldedInView = !!mAix && VIEW_SEAT.has(mAix) && !!e.aix && CHECK_KEYS.has(e.aix);
    if (e.route === "aix" && e.slot === "aix" && e.aix && mAix && !foldedInView && aixFamilyKey(mAix) !== aixFamilyKey(e.aix)) {
      issues.push({ id: e.id, code: "dropped", why: `AIX の要件（${e.aix}）に、その AIX の通が無い（${e.msg}通目は ${mAix}）` });
      continue;
    }
    // 取り違え③: 要件の AIX とブレインの最終の AIX（押される AIX）が違い、最終の AIX の要件が1つも無い＝組み立ては要件の AIX、押されるのは最終の AIX
    //   組み立てに最終の AIX の席がある時（TWO_MESSAGE_SEAT_FOLLOWS_FINAL）は取り違えにしない＝押された AIX を組みが読める
    const finalSeat = !!finalAix && !!plan?.messages.some((m) => m.slot === "aix" && m.aix && aixFamilyKey(m.aix) === aixFamilyKey(finalAix));
    if (e.route === "aix" && e.aix && finalAix && !finalSeat && aixFamilyKey(e.aix) !== aixFamilyKey(finalAix) && !items.some((x) => x.route === "aix" && x.aix && aixFamilyKey(x.aix) === aixFamilyKey(finalAix))) {
      issues.push({ id: e.id, code: "misrouted", why: `要件の AIX（${e.aix}）と最終の AIX（${finalAix}）が違う` });
    }
    // 取り違え①: AIX の番（スタッフだけが知る事）を返信の通で答える
    if (e.route === "aix" && e.slot === "reply") issues.push({ id: e.id, code: "misrouted", why: `AIX の番（${e.aix ?? "AIX"}）を返信の通（${e.msg}通目）で答える` });
    // 取り違え②: 空き・募集状況を返信で言い切る（P0 ca55d42b: 募集状況はスタッフだけが知る）。約束（promise）は取り違えではない
    //   不安・気持ち（「埋まる可能性高いですか」の焦り＝q072）は受け止めを返信で書くので除く＝問い・依頼だけ
    //   一般の見込み（「埋まる可能性は高いか」＝好条件はすぐ埋まる・試験 q072 の正解は返信）と、一般の事で答える（basis=general）番も除く
    else if (e.route === "reply" && e.about === "vacancy" && e.slot === "reply" && (e.kind === "question" || e.kind === "request") && e.basis !== "general" && !/埋ま|決まって?しま|すぐ(?:に)?(?:無く|なく)/.test(e.quote)) issues.push({ id: e.id, code: "misrouted", why: `空き・募集状況（「${e.quote.slice(0, 16)}」）を返信で答える＝確認の約束か AIX の番` });
  }
  const ids = (c: AskIssueCode) => [...new Set(issues.filter((x) => x.code === c).map((x) => x.id))];
  return { ok: issues.length === 0, dropped: ids("dropped"), doubled: ids("doubled"), misrouted: ids("misrouted"), issues };
}
const VIEW_SEAT = new Set(["viewing_invite", "meeting_place"]);
const CHECK_KEYS = new Set(["property_check_result", "acknowledge_check"]);
const ROUTE_JA: Record<AskRoute, string> = { reply: "返信", promise: "約束", aix: "AIX", none: "触れない" };

/** 判断の後の meta から帳面を作る（meta は変えない）。asks が無い番は null */
export function askLedgerFromMeta(meta: Record<string, unknown> | null | undefined, o: { prev?: ReadonlyArray<{ id: string; quote: string }> | null } = {}): AskLedger | null {
  if (!meta) return null;
  const asks = asksOf((meta.turn_contract as { asks?: unknown } | null | undefined)?.asks);
  if (!asks.length) return null;
  const finalAix = meta.reply_mode === "auto_reply" ? null : (typeof meta.action === "string" && meta.action ? meta.action : null);
  const plan = planFromMeta(meta) ?? null;
  return buildAskLedger({ asks, plan, finalAix, seenCustomerAt: typeof meta.analyzed_msg_ts === "string" ? meta.analyzed_msg_ts : null, prev: o.prev ?? null });
}

/** 前の番の帳面（meta.ask_ledger）を読む（形が合わなければ null） */
export function askLedgerOf(meta: unknown): AskLedger | null {
  const v = (meta as { ask_ledger?: unknown } | null | undefined)?.ask_ledger as Partial<AskLedger> | undefined;
  if (!v || typeof v !== "object" || v.v !== 1 || !Array.isArray(v.items) || !Array.isArray(v.msgs)) return null;
  if (!v.items.every((e) => e && typeof e.id === "string" && typeof e.quote === "string")) return null;
  return v as AskLedger;
}

/** on の時: meta.turn_contract.asks の各行に id と msg を書き足した写しを返す（元は変えない・行の順は同じ） */
export function annotateAsks<T extends Record<string, unknown>>(rawAsks: ReadonlyArray<T>, ledger: AskLedger): Array<T & { id?: string; msg?: number | null }> {
  let k = 0;
  return rawAsks.map((a) => {
    if (!a || typeof a !== "object" || typeof a.quote !== "string" || !a.quote.trim()) return a;
    const e = ledger.items[k++];
    return e ? { ...a, id: e.id, msg: e.msg } : a;
  });
}

// ── 送った所まで（継ぎ目②の純関数）───────────────────────────────────
/** 送った通。template＝AIX のテンプレートの通として送った（AIX の画面の2通目）。手打ちの返信は template を付けない */
export type SentMove = { kind: "reply" | "aix"; aix?: string | null; template?: boolean };
export type AskProgress = {
  /** 組み立ての何通目まで送ったか（0＝まだ） */
  sentUpTo: number;
  /** 答えた要件（返信・AIX で答えた） */
  answered: string[];
  /** 約束を送った要件（結果は後の AIX） */
  promised: string[];
  /** まだ答えていない要件（行き先があるのに残っている） */
  remaining: string[];
  /** 次に送る通（無ければ null） */
  next: { no: number; slot: PlanSlot; aix: string | null; answers: string[] } | null;
  /** 組み立てと違う通を送った（AIX の種類が違う・AIX の通が無いのに AIX を送った 等）。違った所から先は当てない */
  offPlan: string | null;
};
/**
 * 実際に送った通を、帳面の組み立てに順に当てる（純関数）。
 *   返信の送信は、次の AIX の通の手前までで「返信」の通に当てる（template の印がある時はテンプレートの通）。手前に返信の通が無ければテンプレートの通に当てる
 *   （竹内さんの AT の T は手打ちの文＝印が無くてもテンプレートの席を埋める）。
 *   AIX の送信は次の「AIX」の通に当てる。種類が違えば offPlan に書いて止める（推し直さない＝3か所が別々に推し直して食い違う元を作らない）。
 *   組み立てで飛ばした通（例: テンプレートを送らずに返信）は、飛ばした通の要件を残りに入れる。
 */
export function progressAfterSends(ledger: AskLedger, sends: ReadonlyArray<SentMove>): AskProgress {
  const done = new Set<number>();
  let cursor = 0; // 次に当てる通の位置（msgs の添字）
  let offPlan: string | null = null;
  for (const s of sends) {
    let hit = -1;
    if (s.kind === "aix") {
      for (let j = cursor; j < ledger.msgs.length; j++) if (ledger.msgs[j].slot === "aix") { hit = j; break; }
    } else {
      // 次の AIX の通の手前まで（そこまでの返信・テンプレートの通が候補）
      let end = ledger.msgs.length;
      for (let j = cursor; j < ledger.msgs.length; j++) if (ledger.msgs[j].slot === "aix") { end = j; break; }
      const win = ledger.msgs.slice(cursor, end).map((m, k) => ({ m, j: cursor + k }));
      const want = s.template ? "aix_template" : "reply";
      hit = (win.find((x) => x.m.slot === want) ?? win[0])?.j ?? -1;
    }
    if (hit < 0) { offPlan = s.kind === "aix" ? `組み立てに無い AIX（${baseKey(s.aix) ?? "?"}）を送った` : "組み立ての通より多く返信を送った"; break; }
    const m = ledger.msgs[hit];
    const k = baseKey(s.aix);
    if (s.kind === "aix" && k && m.aix && aixFamilyKey(k) !== aixFamilyKey(m.aix)) { offPlan = `組み立ての AIX（${m.aix}）と違う AIX（${k}）を送った`; break; }
    done.add(m.no);
    cursor = hit + 1;
  }
  const sentUpTo = done.size ? Math.max(...done) : 0;
  const answered: string[] = [], promised: string[] = [], remaining: string[] = [];
  for (const e of ledger.items) {
    if (e.route === "none") continue;
    const nos = [e.msg, ...(e.alsoMsg ?? [])].filter((n): n is number => typeof n === "number");
    if (nos.some((n) => done.has(n))) (e.later ? promised : answered).push(e.id);
    else remaining.push(e.id);
  }
  const nm = offPlan ? null : ledger.msgs.find((m) => m.no > sentUpTo && !done.has(m.no)) ?? null;
  const next = nm ? { ...nm, answers: ledger.items.filter((e) => e.msg === nm.no).map((e) => e.id) } : null;
  return { sentUpTo, answered, promised, remaining, next, offPlan };
}

/** 次の番に渡す要件（まだ答えていない物＋約束して結果がまだの物）。id と言葉と状態のまま */
export function openAsksFrom(ledger: AskLedger | null | undefined, progress: AskProgress | null | undefined): Array<{ id: string; quote: string; state: "open" | "promised"; route: AskRoute; aix: string | null }> {
  if (!ledger || !progress) return [];
  const byId = new Map(ledger.items.map((e) => [e.id, e]));
  const out: Array<{ id: string; quote: string; state: "open" | "promised"; route: AskRoute; aix: string | null }> = [];
  for (const id of progress.remaining) { const e = byId.get(id); if (e) out.push({ id, quote: e.quote, state: "open", route: e.route, aix: e.aix }); }
  for (const id of progress.promised) { const e = byId.get(id); if (e) out.push({ id, quote: e.quote, state: "promised", route: e.route, aix: e.aix }); }
  return out;
}

/** 画面・統括の1行（取りこぼし・重ね・取り違えがある時だけ）。無ければ null */
export function askLedgerAlert(ledger: AskLedger | null | undefined): string | null {
  if (!ledger || ledger.check.ok) return null;
  return `要件の帳面: ${ledger.check.issues.slice(0, 3).map((x) => `${x.code === "dropped" ? "取りこぼし" : x.code === "doubled" ? "重ね" : "取り違え"}（${x.why}）`).join("／")}`;
}

// ── 送り済み・残りの書き戻し（継ぎ目②・conversations.ask_progress・ASK_PROGRESS=on の時だけ）────────────
/** 既定 off（ASK_PROGRESS=on の時だけ返信・AIX の送信の後に conversations.ask_progress を書く） */
export function askProgressOn(env: Env = envOf()): boolean {
  return (env.ASK_PROGRESS ?? "").trim().toLowerCase() === "on";
}
/** conversations.ask_progress の形。seen_customer_at が今の帳面と同じ時だけ続きとして読む（新しいお客様の発言の後は数え直し） */
export type AskProgressRecord = AskProgress & { v: 1; seen_customer_at: string | null; sends: SentMove[]; at: string };
/** 前の記録に今の送信を1つ足して数え直す（純関数）。帳面が無い・送信の数が多すぎる時は null（書かない） */
export function nextAskProgress(ledger: AskLedger | null | undefined, prev: unknown, move: SentMove, nowIso: string): AskProgressRecord | null {
  if (!ledger) return null;
  const p = prev as Partial<AskProgressRecord> | null | undefined;
  const same = !!p && p.v === 1 && Array.isArray(p.sends) && (p.seen_customer_at ?? null) === (ledger.seen_customer_at ?? null);
  const sends = [...(same ? (p!.sends as SentMove[]) : []), { kind: move.kind, ...(move.aix ? { aix: String(move.aix).slice(0, 60) } : {}), ...(move.template ? { template: true } : {}) }];
  if (sends.length > 12) return null;
  return { v: 1, seen_customer_at: ledger.seen_customer_at ?? null, sends, ...progressAfterSends(ledger, sends), at: nowIso };
}
/** 読む側（AIX の2通目・画面の帯・次の番）: 今の帳面の続きの記録だけ返す（古い番の記録は null） */
export function askProgressOf(ledger: AskLedger | null | undefined, raw: unknown): AskProgressRecord | null {
  const p = raw as Partial<AskProgressRecord> | null | undefined;
  if (!ledger || !p || p.v !== 1 || !Array.isArray(p.sends)) return null;
  if ((p.seen_customer_at ?? null) !== (ledger.seen_customer_at ?? null)) return null;
  return p as AskProgressRecord;
}

// ── 読む側（2026-11-19 作業員M・統括役の割り振り: AIX の2通目・画面の帯・統括の指示書）────────────
/** 読む側の既定 off（ASK_PROGRESS_READ=on の時だけ ask_progress を読んで渡す）。書く側 ASK_PROGRESS とは別（書いて貯めてから読む側を試験する） */
export function askProgressReadOn(env: Env = envOf()): boolean {
  return (env.ASK_PROGRESS_READ ?? "").trim().toLowerCase() === "on";
}
const quoteOf = (led: AskLedger, id: string) => led.items.find((e) => e.id === id)?.quote ?? id;
const SLOT_JA: Record<PlanSlot, string> = { reply: "返信", aix: "AIX", aix_template: "AIX の続きの通" };
/** AIX の2通目・AIX の後の返信の書き手への1段（送った所まで・まだ答えていない要件・約束して結果がまだの要件・次の通）。渡す物が無ければ "" */
export function askProgressNote(led: AskLedger | null | undefined, pr: AskProgressRecord | null | undefined): string {
  if (!led || !pr) return "";
  const L: string[] = [];
  if (pr.offPlan) L.push(`・組み立てと違う送り方をした（${pr.offPlan}）＝下の残りは目安`);
  if (pr.remaining.length) L.push(`・まだ答えていない要件: ${pr.remaining.slice(0, 4).map((id) => `「${quoteOf(led, id)}」`).join("・")}`);
  if (pr.answered.length) L.push(`・もう答えた要件（繰り返さない）: ${pr.answered.slice(0, 4).map((id) => `「${quoteOf(led, id)}」`).join("・")}`);
  if (pr.promised.length) L.push(`・約束して結果がまだの要件（結果は確かめてから）: ${pr.promised.slice(0, 3).map((id) => `「${quoteOf(led, id)}」`).join("・")}`);
  if (pr.next) L.push(`・次の通: ${pr.next.no}通目の${SLOT_JA[pr.next.slot]}${pr.next.aix ? `（${pr.next.aix}）` : ""}`);
  return L.length ? `【この番の送った所まで（要件の帳面・${pr.sentUpTo}通目まで送った）】\n${L.join("\n")}` : "";
}
/** 画面の帯の1行（送った所まで・残り）。無ければ null */
export function askProgressBand(led: AskLedger | null | undefined, pr: AskProgressRecord | null | undefined): string | null {
  if (!led || !pr || (!pr.remaining.length && !pr.next)) return null;
  const rest = pr.remaining.slice(0, 2).map((id) => `「${quoteOf(led, id).slice(0, 14)}」`).join("・");
  return `${pr.sentUpTo}/${led.count}通 送った${rest ? `・まだ: ${rest}` : ""}${pr.next ? `・次は${SLOT_JA[pr.next.slot]}` : ""}${pr.offPlan ? "・⚠組み立てと違う" : ""}`;
}
/**
 * 次の番の統括へ（前の番の帳面と送った所まで → まだの要件・約束して結果がまだの要件）。
 *   名前は作業員L の situation_now（asks.open・asks.promised・ask_id）とそろえる＝id は askIdOf。前の帳面の続きでない記録（古い）は読まない
 */
export type AskCarry = { from_seen: string | null; open: string[]; promised: string[]; items: Array<{ ask_id: string; quote: string; state: "open" | "promised"; route: AskRoute; aix: string | null }> };
export function askCarryFrom(prevLed: AskLedger | null | undefined, rawProgress: unknown): AskCarry | null {
  const pr = askProgressOf(prevLed, rawProgress);
  if (!prevLed || !pr) return null;
  const items = openAsksFrom(prevLed, pr).map((x) => ({ ask_id: x.id, quote: x.quote, state: x.state, route: x.route, aix: x.aix }));
  if (!items.length) return null;
  return { from_seen: prevLed.seen_customer_at, open: items.filter((x) => x.state === "open").map((x) => x.ask_id), promised: items.filter((x) => x.state === "promised").map((x) => x.ask_id), items };
}
