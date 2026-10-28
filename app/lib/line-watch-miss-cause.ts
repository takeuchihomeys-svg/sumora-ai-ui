// app/lib/line-watch-miss-cause.ts — 返信の番で文が外れた番（見張り line_watch_turns）の原因の分け（決定論・LLM なし）
//
// 2026-10-28 作業員1: 文の外れ 63番を1番ずつ読んで分けた原因（F/C/D/N/A/B/E）のうち、見張りの行の項目だけで決まる物を自動で付ける。
//   毎週の表（scripts/line-watch-miss-causes.ts）に使う。決まらない番は「要読む」で候補（A/B か E）だけ出す＝人か LLM が読む。
//   分けの意味（CLAUDE.md「絶対的な考え方」の外れの3つに対応）:
//     F  本来 AIX／スタッフの手の番（返信か AIX かの判断の誤り・または返信の物差しの外）
//        F1 お礼・了承の番にスタッフは物件の AIX（オススメ・ピックアップ・送る）
//        F2 スタッフだけが知る事（管理会社の答え・募集中・予定・写真）を手打ち
//        F3 申込の段（申込へ・申込書の記入）
//        F4 その他の AIX（見積書・電話・内覧・確認）
//     C  送った事・決まった事が届いていない（日時・物件の食い違い）＝材料が届いていない
//     D  部品のぶつかり（明日一番・営業時間の足し・約束の蒸し返し・催促）
//     N  外れではない候補（行為も事実も同じ・言い回しだけ）
//     要読む A/B: 言うべき事が抜けた（組み方の崩れ A か具体の知識 B）／要読む E: 書き方の手本のずれ
//   入れる順は上から（F が先＝判断の誤りを文の誤りより先に数える）。
import { staffFactsOf } from "./line-watch-judge";

export type MissCause = "F1" | "F2" | "F3" | "F4" | "C" | "D" | "N" | "要読む:A/B" | "要読む:E";
export const MISS_CAUSE_JA: Record<MissCause, string> = {
  F1: "F1 お礼・了承の番に物件の AIX",
  F2: "F2 スタッフだけが知る事を手打ち",
  F3: "F3 申込の段",
  F4: "F4 その他の AIX（見積書・電話・内覧・確認）",
  C: "C 送った事・決まった事が届いていない",
  D: "D 部品のぶつかり（明日一番・蒸し返し・催促）",
  N: "N 外れではない候補（言い回しだけ）",
  "要読む:A/B": "要読む A/B（言うべき事が抜けた）",
  "要読む:E": "要読む E（書き方）",
};

export type MissRow = {
  scene_key: string | null;
  verdict: string | null;
  draft_last: string | null;
  staff_texts: Array<{ text: string; burst: boolean }> | null;
  staff_aix: Array<{ aix_type: string | null; burst: boolean }> | null;
  verdict_detail: Record<string, unknown> | null;
};

const PROPERTY_AIX = new Set(["property_recommendation", "property_pickup", "property_send", "zenryoku_support"]);
const APPLY_AIX = new Set(["application_push"]);
// 挨拶の AIX（内覧後の挨拶）は文と一緒に押す添えの物＝F に数えない（手の分けで5番中4番が文の外れだった）
const SIDE_AIX = new Set(["greeting_viewing"]);
const ACK_SCENE = /短い了承|お礼|了承/;
const PROPERTY_TEXT = /オススメ出来るお部屋|ピックアップさせて(?:頂|いただ)きました|新着で[^。\n]{0,40}お部屋/;
const APPLY_TEXT = /お申込(?:み)?(?:に必要なご情報|手続き|書)|申込(?:み)?フォーマット|記入欄にご入力|上記フォーマット/;
// D: 下書きだけにある部品（スタッフの文に無い）
const D_DRAFT_ONLY = [/明日一番/, /営業時間(?:が|は)?終了/, /本日のご連絡お待ち/, /ご連絡お待ちしております/];

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** 文の外れの番か（返信の道で partial／different）。na・一致・AIX の道は外す */
export function isTextMiss(r: Pick<MissRow, "verdict" | "verdict_detail">): boolean {
  const d = r.verdict_detail ?? {};
  if (String(d.path ?? "") !== "返信") return false;
  return r.verdict === "partial" || r.verdict === "different";
}

export function classifyMiss(r: MissRow): { cause: MissCause; why: string } {
  const d = r.verdict_detail ?? {};
  const staff = (r.staff_texts ?? []).filter((t) => t.burst).map((t) => t.text).join("\n");
  const draft = r.draft_last ?? "";
  const press = (r.staff_aix ?? []).filter((p) => p.burst).map((p) => String(p.aix_type ?? ""));
  const scene = r.scene_key ?? "";

  if (ACK_SCENE.test(scene) && (press.some((a) => PROPERTY_AIX.has(a)) || PROPERTY_TEXT.test(staff))) return { cause: "F1", why: `お礼の番・スタッフ ${press.join(",") || "物件の文"}` };
  if (press.some((a) => APPLY_AIX.has(a)) || APPLY_TEXT.test(staff)) return { cause: "F3", why: press.includes("application_push") ? "申込へ を押した" : "申込の文" };
  const otherPress = press.filter((a) => a && !PROPERTY_AIX.has(a) && !SIDE_AIX.has(a));
  if (otherPress.length) return { cause: "F4", why: `スタッフ ${otherPress.join(",")}` };
  if (/^\s*\[画像\]\s*$/m.test(staff) && staff.replace(/\[画像\]/g, "").trim() === "") return { cause: "F4", why: "画像だけ" };
  const facts = staffFactsOf(staff, draft + "\n");
  if (facts.length) return { cause: "F2", why: facts.map((f) => f.kind).join(",") };

  const fx = (d.facts ?? {}) as Record<string, unknown>;
  const conflict = arr(fx.conflict).filter((k) => k !== "name");
  if (conflict.length) return { cause: "C", why: `食い違い ${conflict.join(",")}` };

  const dOnly = D_DRAFT_ONLY.find((re) => re.test(draft) && !re.test(staff));
  if (dOnly) return { cause: "D", why: `下書きだけ ${dOnly.source}` };
  const extra = arr(d.extra_acts);
  const missing = arr(d.missing_acts);
  if (extra.includes("check_promise") && !missing.length) return { cause: "D", why: "確認の約束を足した" };

  const staffOnly = arr(fx.staffOnly).filter((k) => k !== "name");
  if (!missing.length && !extra.length && !staffOnly.length && !arr(fx.draftOnly).length && Number(d.sim ?? 0) >= 0.5) return { cause: "N", why: `行為・事実が同じ（sim ${d.sim ?? "?"}）` };
  if (missing.length || staffOnly.length) return { cause: "要読む:A/B", why: `抜け ${[...missing, ...staffOnly].join(",")}` };
  return { cause: "要読む:E", why: `足し ${[...extra, ...arr(fx.draftOnly)].join(",") || "書き方"}` };
}
