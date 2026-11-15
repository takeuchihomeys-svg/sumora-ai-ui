// app/lib/compose-brief-uptake.ts — 統括の指示書の欄 → 文の役目 → 書き手への1行 の対応表と、書いた後に「渡した物を下書きが入れたか」の確かめ（純関数・LLM/DB なし）
//   2026-11-15 作業員I（竹内さん 11/15「文生成する部分もちゃんと具体的に強化していく。そして統括も強化とともにちゃんと強化されていくように」・統括役の頼み）
//   統括を強くしても書き手が使わなければ文は変わらない＝欄ごとに「渡した → 文に入ったか」を1組で持つ。
//
// ■ 名前: 欄＝conductor-brief の指示書の欄（main・facts・open・next・next_concrete・feeling …）／役目＝decided-subfields の SubRole（head・press・trust・latent・bridge・close・aix1・aix2）／
//   要素＝作業員H の本番の毎日の物差し（compose-prod-elements の PROD_ELEMENTS: 頭・押さえ・信頼・潜在・つなぎ・締め・事実・2通目）
// ■ 確かめ（決まった形・網）: 欄ごとに「下書きに入るべき語」を指示書の値から作り、1つも無ければ入れ漏れ。値を作らない（指示書に無い語は求めない）
//   q136 の形: 次の一手の具体の when.word（明日一番に・管理会社の営業時間外の頭）を落とした下書きを拾う
// ■ スイッチ COMPOSE_BRIEF_UPTAKE: off（既定）／shadow＝記録だけ（tpo_debug.brief_uptake）／note＝スタッフへの注記の候補（出口では直さない）。
//   書き手に1回直させる形は、過去の下書きで誤って付ける物が0か確かめてから（scripts/audit-brief-uptake.ts）
import { BRIEF_NONE, BRIEF_SECTION_SUBS, type ConductorBrief } from "./conductor-brief";
import { SUB_FIELDS, type SubRole } from "./decided-subfields";

type Env = Record<string, string | undefined>;
export type UptakeMode = "off" | "shadow" | "note";
export function briefUptakeMode(env: Env = typeof process !== "undefined" ? process.env : {}): UptakeMode {
  const v = String(env.COMPOSE_BRIEF_UPTAKE ?? "").trim().toLowerCase();
  return v === "note" ? "note" : v === "shadow" || v === "on" ? "shadow" : "off";
}

/** 役目 → 作業員H の要素の名前 */
export const ROLE_TO_PROD_EL: Readonly<Record<SubRole, string>> = { head: "頭", press: "押さえ", trust: "信頼", latent: "潜在", bridge: "つなぎ", close: "締め", aix1: "2通目", aix2: "2通目" };

export type BriefRoleRow = { section: string; subs: string[]; roles: SubRole[]; els: string[] };
/** ① 対応表: 指示書の欄 → 下の欄（decided-subfields）→ 役目 → 要素（コードの表から作る＝表を2つ持たない） */
export function briefRoleTable(): BriefRoleRow[] {
  return Object.entries(BRIEF_SECTION_SUBS).map(([section, subs]) => {
    const roles = [...new Set(subs.flatMap((s) => SUB_FIELDS.find((f) => f.sub === s)?.roles ?? []))] as SubRole[];
    return { section, subs: [...subs], roles, els: [...new Set(roles.map((r) => ROLE_TO_PROD_EL[r]))] };
  });
}

type O = Record<string, unknown>;
const obj = (v: unknown): O | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as O) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const norm = (t: string) => t.normalize("NFKC").replace(/[\s,、。！!？?]/g, "");
/** 値から下書きに入るべき語: 数（単位つき）→ 物件名の頭 → 6字以上の値はそのうちの漢字・カタカナの2字以上の塊 */
export function tokensOfValue(v: string): string[] {
  const t = v.normalize("NFKC");
  const nums = (t.match(/\d[\d,.]*\s*(?:円|万円|帖|㎡|m2|ヶ月|か月|分|日|時)/g) ?? []).map((x) => x.replace(/[,\s]/g, ""));
  if (nums.length) return nums;
  const words = (t.match(/[\p{Script=Han}\p{Script=Katakana}ー]{2,}/gu) ?? []).filter((w) => !/^(?:確認|ご連絡|連絡|お部屋|物件|こちら|させて)$/.test(w));
  return words.length ? words.slice(0, 4) : t.length >= 2 ? [t.slice(0, 6)] : [];
}

export type UptakeItem = { section: string; key: string; label: string; any: string[]; re?: RegExp; used: boolean };
const INVITE_RE: Record<string, RegExp> = { viewing: /ご案内|ご内覧|内覧|ご都合|お日にち/, apply: /お申込|申込|抑え|押さえ/, estimate: /御見積|見積/ };

/** ② 指示書の欄ごとの「入るべき物」と下書きが入れたか */
export function briefUptake(brief: ConductorBrief | null | undefined, draft: string): UptakeItem[] {
  if (!brief) return [];
  const d = norm(String(draft ?? ""));
  const out: UptakeItem[] = [];
  const push = (section: string, key: string, label: string, any: string[], re?: RegExp) => {
    const toks = any.map(norm).filter((x) => x.length >= 2);
    if (!toks.length && !re) return;
    out.push({ section, key, label, any: toks, ...(re ? { re } : {}), used: toks.some((x) => d.includes(x)) || (!!re && re.test(String(draft ?? ""))) });
  };
  // 事実（押さえ）: 指示書の事実の値のうち、単位つきの数がある物だけ（言い切れる物・資料か会社の事実）。
  //   2026-11-15 監査（竹内さんの文 291番）: 数の無い値（答えの方針の文「受け止めて締める」等）まで求めると 53/141 を誤って付けた＝数の値だけにした
  if (brief.facts !== BRIEF_NONE) arr(brief.facts).map(obj).forEach((f, k) => { const v = s(f?.value); if (f && s(f.certainty) !== "needs_check" && /\d[\d,.]*\s*(?:円|万円|帖|㎡|m2|ヶ月|か月|分)/.test(v.normalize("NFKC"))) push("facts", `f${k + 1}`, `事実「${v.slice(0, 24)}」`, tokensOfValue(v)); });
  // 開いている約束（信頼・頭）: 果たす番の約束の中身
  if (brief.open !== BRIEF_NONE) arr(brief.open).map(obj).forEach((o, k) => { if (o && /promise/.test(s(o.kind))) push("open", `o${k + 1}`, `約束「${s(o.what).slice(0, 24)}」`, tokensOfValue(s(o.what))); });
  // 次の一手の具体（つなぎ・締め）: いつの言葉（明日一番に・営業時間外の頭＝q136 の形）。お客様の言った時期は「その時期の言葉で結ぶ」
  const nc = obj((brief as unknown as O).next_concrete);
  arr(nc?.steps).map(obj).slice(0, 1).forEach((st) => {
    const w = obj(st?.when); const word = s(w?.word);
    // 監査: お客様の言った時期（customer）は竹内さんの文に無い番が多い（14/25 の多く）＝管理会社の営業時間の言葉（q136 の形）だけ求める
    if (word && s(w?.from) === "mgmt_hours" && s(w?.at) === "next_day") push("next_concrete", "when", `いつの言葉「${word}」`, [word, ...(word === "明日一番に" ? ["明日"] : [])]);
  });
  // 次の一手（締め）: 行き先の誘い（内覧・申込・見積）
  if (brief.next !== BRIEF_NONE && INVITE_RE[brief.next.dest] && brief.next.strength !== "none" && brief.next.strength !== "door") push("next", "dest", `誘い（${brief.next.dest}）`, [], INVITE_RE[brief.next.dest]);
  return out;
}

/** 記録の短い印 例 "facts:1/2|next_concrete:0/1|next:1/1" */
export function uptakeDigest(items: ReadonlyArray<UptakeItem>): string | null {
  if (!items.length) return null;
  const by = new Map<string, [number, number]>();
  for (const i of items) { const v = by.get(i.section) ?? [0, 0]; v[1]++; if (i.used) v[0]++; by.set(i.section, v); }
  return [...by].map(([k, [a, b]]) => `${k}:${a}/${b}`).join("|");
}
/** 注記に出してよい欄（竹内さんの本当の文で誤って付ける物が0と確かめた欄だけ）。
 *  2026-11-15 監査（scripts/audit-brief-uptake.ts・試験の答案 291番）: facts は 3/8 を誤って付けた（答えの方針の文・約束の文が値に入る）＝出さない。
 *  next_concrete（営業時間外の明日）は当たる番が0＝確かめられていない＝まだ出さない。記録（shadow の digest）は全部の欄 */
export const NOTE_SECTIONS: ReadonlySet<string> = new Set<string>([]);
/** スタッフへの注記（note の時・落とした物だけ・出口では直さない） */
export function uptakeNote(items: ReadonlyArray<UptakeItem>, sections: ReadonlySet<string> = NOTE_SECTIONS): string | null {
  const miss = items.filter((i) => !i.used && sections.has(i.section));
  return miss.length ? `統括が渡したのに下書きに無い: ${miss.map((i) => i.label).join("・")}`.slice(0, 160) : null;
}
