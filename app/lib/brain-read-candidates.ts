// app/lib/brain-read-candidates.ts — 案2: お客様の一通の読みの候補を立て、こちらの直前の送信・事実で1つに決める欄（read_candidates・作業員16・2026-11-12）
//
// 竹内さん 11/12「人間のように『こうだからこうじゃないか』と仮定して想定する等で当てはめる」（KB P1 d030d496・親 P0 575a7cd5）。
// 竹内さんの型（check-order.ts）: T4 お客様が物件を送ってきた（空きか・費用か・条件の参考か）／T5 お礼・了承だけ（何への了承か）／T11 初回（何を求めているか）は、
//   一通の言葉だけでは読みが決まらず、こちらの直前の送信（our_last_send）を見て候補から選ぶ。本番 11264（参考の物件を見積と決め打ち）・q078・q173 の外れの形。
// 置き方: 事実の欄として道の前に置く（候補・選んだ読み・根拠の事実だけ）。次の一手・押す・誘導の言葉は入れない（q406・q057・q065・q022 の教訓）。
//   our-send-uptake（こちらの送信の部分ごとの受け取られ方・BRAIN_OUR_SEND_UPTAKE）と同じ段に並べる。
// スイッチ: BRAIN_READ_CANDIDATES（既定 off＝プロンプトも結果も1文字も変わらない）。

type Env = Record<string, string | undefined>;
export function readCandidatesOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.BRAIN_READ_CANDIDATES ?? "").trim().toLowerCase() === "on";
}

export const READ_CANDIDATE_TURNS = ["ack_only", "brought_property", "first_contact", "short_unclear", "none"] as const;
export type ReadCandidateTurn = typeof READ_CANDIDATE_TURNS[number];
export type ReadCandidates = { turn: ReadCandidateTurn; options: string[]; chosen: number | null; by: string | null };

export const READ_CANDIDATES_FIELD = `"read_candidates": {"turn": "ack_only（お礼・了承だけ）| brought_property（お客様が物件を送ってきた）| first_contact（初回）| short_unclear（短くて何を指すか言葉だけでは決まらない）| none（どれでもない）", "options": ["turn が none でない時だけ: この一通の読みの候補を2〜3（各30字以内・例: 'ピックアップの約束への了承' '物件を送ってほしい' '条件の参考に送った' '空きを知りたい'）"], "chosen": 0, "by": "その読みに決めた根拠の事実（こちらの直前の送信・前の約束・送った物件・会社の事実・物件の資料のどれか。30字以内）"}`;

export const READ_CANDIDATES_RULES = `【一通の読みの候補（read_candidates・事実の欄・JSON の最初の方に書く）】お礼・了承だけの番、お客様が物件を送ってきた番、初回の番、短くて何を指すか言葉だけでは決まらない番は、竹内さんのように「こうだからこうじゃないか」と読みの候補を2〜3立て、こちらの直前の送信・前の約束・送った物件・会社の事実・物件の資料で確かめて1つに決める（chosen はその候補の番号・by は決めた根拠の事実）。
- お礼・了承だけ: 何への了承かは、こちらの直前の送信（物件を送った／見積書を送った／内覧の日時を決めた／ピックアップを約束した）で決める。
- お客様が物件を送ってきた: 空きを知りたいのか・初期費用を知りたいのか・条件の参考に送ったのかを、同じ一通の言葉と前の流れ（条件をもらった直後か）で決める。
- それ以外の番は turn を none にし、options は [] にする。ここには読みと根拠だけを書き、どう返すか・どこへつなぐかは書かない。`;

export function normalizeReadCandidates(raw: unknown): ReadCandidates | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const turn = (READ_CANDIDATE_TURNS as readonly string[]).includes(String(o.turn ?? "").trim()) ? (String(o.turn).trim() as ReadCandidateTurn) : null;
  if (!turn) return null;
  const options = Array.isArray(o.options) ? o.options.map((x) => (typeof x === "string" ? x.trim().slice(0, 40) : "")).filter(Boolean).slice(0, 3) : [];
  const c = o.chosen == null || o.chosen === "" ? NaN : Number(o.chosen); // null を 0 番に読まない
  const chosen = turn !== "none" && options.length && Number.isInteger(c) && c >= 0 && c < options.length ? c : null;
  const by = typeof o.by === "string" && o.by.trim() && !/^(null|なし|無し)$/i.test(o.by.trim()) ? o.by.trim().slice(0, 40) : null;
  return { turn, options: turn === "none" ? [] : options, chosen, by };
}

/** 選んだ読み（無ければ null） */
export const chosenReading = (r: ReadCandidates | null | undefined): string | null => (r && r.chosen != null ? r.options[r.chosen] ?? null : null);
/** 根拠が事実に当たっているか（こちらの送信・約束・送った物件・会社・資料の語） */
export const readByFact = (r: ReadCandidates | null | undefined): boolean => !!r?.by && /直前|送信|送った|お送り|約束|ピックアップ|見積|内覧|日時|会社|資料|物件|条件/.test(r.by);
export function readCandidatesDigest(r: ReadCandidates | null | undefined): string | null {
  if (!r) return null;
  return `${r.turn}:${r.options.length}${r.chosen != null ? `>${r.chosen}` : ""}${readByFact(r) ? "+事実" : ""}`;
}

// ─── 2026-11-13 点検役（S3＝読みの仮説を立てて事実で確かめる段が本番に無い・read_candidates も check_order も本番で0件）────
//   BRAIN_READ_CANDIDATES=shadow: 欄を JSON の最後（判断を書き終えた後の振り返り）に置き、記録だけにする（道を引っぱらない・q406・q022 の教訓）。
//   on: 今まで通り JSON の最初の事実の欄。off: 何も足さない。
export type ReadCandidatesMode = "off" | "shadow" | "on";
export function readCandidatesMode(env: Env = typeof process !== "undefined" ? process.env : {}): ReadCandidatesMode {
  const v = String(env.BRAIN_READ_CANDIDATES ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}
/** 確かめる事実の取り先: こちらの直前の送信のどの部分か／送った物件の点／開いている約束／会社の事実 */
export const READ_CHECK_FROMS = ["our_last_send", "sent_property_point", "open_promise", "company_fact"] as const;
export type ReadCheckFrom = typeof READ_CHECK_FROMS[number];
export type ReadCheck = { from: ReadCheckFrom; fact: string; supports: number | null };
export const READ_CANDIDATES_FIELD_SHADOW = `"read_candidates": {"turn": "ack_only|brought_property|first_contact|short_unclear|none", "options": ["この一通の読みの候補を2つ以上（各30字以内）"], "checks": [{"from": "${READ_CHECK_FROMS.join("|")}", "fact": "確かめに使った事実（こちらの直前の送信のどの部分・送った物件のどの点・どの約束・どの会社の事実か。30字以内）", "supports": 0}], "chosen": 0, "by": "選んだ根拠（30字以内）"}`;
export const READ_CANDIDATES_RULES_SHADOW = `【振り返り: 一通の読みの候補（read_candidates・判断を全部書き終えた後に書く・この欄で判断を変えない）】この一通の読みの候補を2つ以上立て、こちらの直前の送信のどの部分・送った物件の点・開いている約束・会社の事実で確かめて1つ選ぶ（checks の supports は支える候補の番号）。読みと根拠だけを書く。`;

export type ReadCandidatesFull = ReadCandidates & { checks: ReadCheck[] };
export function normalizeReadCandidatesFull(raw: unknown): ReadCandidatesFull | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const base = normalizeReadCandidates({ ...o, turn: typeof o.turn === "string" && o.turn !== "none" ? o.turn : "short_unclear" });
  if (!base) return null;
  const arr = Array.isArray(o.checks) ? o.checks : [];
  const checks: ReadCheck[] = arr.slice(0, 4).map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>) : {}))
    .filter((c) => (READ_CHECK_FROMS as readonly string[]).includes(String(c.from)) && typeof c.fact === "string" && String(c.fact).trim())
    .map((c) => {
      const n = Number(c.supports);
      return { from: c.from as ReadCheckFrom, fact: String(c.fact).trim().slice(0, 40), supports: Number.isInteger(n) && n >= 0 && n < base.options.length ? n : null };
    });
  return { ...base, checks };
}

/** 選んだ読みを、潜在の5段の「なぜ」「想定」と、設計図の主の行に渡す形（受け渡しだけ・ここで判断しない） */
export type ReadingHandoff = { reading: string; whyKind: "our_last_send" | "condition_check" | "earlier_circumstance" | null; whyQuote: string | null; latentText: string };
export function readingHandoff(r: ReadCandidatesFull | null | undefined): ReadingHandoff | null {
  const reading = chosenReading(r);
  if (!r || !reading) return null;
  const sup = r.checks.find((c) => c.supports === r.chosen) ?? r.checks[0] ?? null;
  const whyKind = sup?.from === "our_last_send" || sup?.from === "sent_property_point" ? "our_last_send" : sup?.from === "open_promise" ? "earlier_circumstance" : sup?.from === "company_fact" ? "condition_check" : null;
  return { reading, whyKind, whyQuote: sup?.fact ?? null, latentText: [reading, r.by, sup?.fact].filter(Boolean).join("／") };
}
