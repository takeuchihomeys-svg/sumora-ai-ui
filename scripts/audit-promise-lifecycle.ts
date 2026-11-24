// scripts/audit-promise-lifecycle.ts — 約束の一生を段ごとに数える（台帳 #664・2026-11-25 作業員L・読むだけ・LLM なし・DB なし）
//   段: 見つける → 期日 → 記録 → 統括 → 果たす → 閉じる → 見張り → 試験。元の数えは前に流した台本の出力（JSON）を読むだけ:
//     見つける・記録: scripts/audit-promise-kinds.ts --wide --out（約束の文の種類・「その他」の分け・記録の有無）
//     期日・果たす: scripts/audit-promise-kept.ts --out（B1・期限の決め方・期限内に果たした）
//     閉じる: scripts/list-done-at-backfill.ts --out（果たした時刻の入った行）
//     試験: scripts/brain-exam/spec.json（答え方 promise の依頼）
//   「見つける」の網の穴は、「その他」の「残り」（申込以降・気持ち・約束でない・内覧当日を除いた物）を言い回しの動詞ごとに分け、入るはずの種類の案を付ける。
//   会話の文は出さない（伏せた形の頭だけ・会話は頭8字）。
// 実行: npx tsx scripts/audit-promise-lifecycle.ts --kinds=<kinds.json> --b1=<b1.json> --done=<done-at.json> [--spec=scripts/brain-exam/spec.json]
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const rd = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

/** 「残り」の動詞 → 入るはずの種類の案（コードの種類の名前・推した案なので「案」と書く） */
export const HOLE_GUESS: Record<string, string> = {
  お送り: "探す（新着・募集に出次第お送り＝ピックアップの約束）", ご連絡: "連絡（種類はあるが1件も入っていない）", 確認: "確認（最終確認・募集状況確認）",
  交渉: "交渉（減額・日程の交渉＝種類が無い）", 共有: "連絡（管理会社に共有）", ご用意: "見積（御見積書をご用意）・持参", 手配: "内覧・申込の手配",
  お申込: "申込以降に寄る（申込の手配）", "（動詞なし）": "動詞の取り出しが外れた（割引・条件に加える・探し続ける）",
};

const kinds = rd(arg("kinds")), b1 = rd(arg("b1")), done = rd(arg("done")), spec = rd(arg("spec", "scripts/brain-exam/spec.json"));
if (!kinds || !b1) { console.error("--kinds と --b1 の JSON が要る"); process.exit(1); }
type KRow = { type: string; bucket?: string | null; key?: string | null; shape?: string | null; fact?: boolean; calendar?: boolean };
const rows = (kinds.rows ?? []) as KRow[];
const other = rows.filter((r) => r.type === "その他");
const notPromise = other.filter((r) => ["申込以降", "気持ち", "約束でない"].includes(String(r.bucket))).length;
const rest = other.filter((r) => r.bucket === "残り");
const scope = rows.length - notPromise;
const typed = rows.filter((r) => r.type !== "その他");
const b1r = (b1.rows ?? []) as Array<{ deadlineBy?: string; state?: string; writer?: string }>;
const judged = b1r.filter((r) => ["in_time", "late", "overdue"].includes(String(r.state)));
const inTime = b1r.filter((r) => r.state === "in_time").length;
const words = b1r.filter((r) => r.deadlineBy === "words").length;
const sp = (Array.isArray(spec) ? spec : spec?.problems ?? []) as Array<{ id: string; asks?: unknown[] }>;
const promiseAsks = sp.flatMap((x) => (x.asks ?? []).filter((a) => /promise/.test(JSON.stringify(a))).map(() => x.id));

console.log(`# 約束の一生（${kinds.days ?? "?"}日・約束の文 ${rows.length}・B1 の約束 ${b1r.length}）\n`);
console.log("| 段 | 今の数 | 割合 | 何を見たか |");
console.log("|---|---|---|---|");
console.log(`| ① 見つける | 種類が付いた ${typed.length}・網の外れ（その他の残り）${rest.length} | 外れ ${pct(rest.length, scope)}（約束の範囲 ${scope}） | audit-promise-kinds（申込以降・気持ち・約束でないは範囲外・内覧当日は別に数える） |`);
console.log(`| ② 期日 | 約束の文に期限あり ${words}・72時間の決めで見た ${b1r.length - words} | 文に期限 ${pct(words, b1r.length)} | B1 の deadlineBy |`);
const fact = typed.filter((r) => r.fact).length, cal = typed.filter((r) => r.calendar).length;
console.log(`| ③ 記録 | 行動台帳 ${fact}・カレンダー ${cal}（種類の付いた ${typed.length} のうち） | 台帳 ${pct(fact, typed.length)}・カレンダー ${pct(cal, typed.length)} | audit-promise-kinds の記録の有無 |`);
console.log(`| ④ 統括 | 期限を過ぎた約束を統括に渡す（CONDUCTOR_OVERDUE_PROMISES 既定 on） | 渡った数の物差しが無い | 読む所はある・番ごとに渡ったかを数える欄が無い |`);
console.log(`| ⑤ 果たす | 期限内 ${inTime}（判定 ${judged.length}） | ${pct(inTime, judged.length)} | B1 |`);
if (done) console.log(`| ⑥ 閉じる | 果たした時刻あり ${done.withTime}・時刻なし ${done.noTime}（${done.rows}行） | ${pct(done.withTime, done.rows)} | list-done-at-backfill |`);
console.log(`| ⑦ 見張り | 期限を過ぎて果たしていない約束を見張りの窓で取りこぼした 0（core:window_miss:promise.14d） | — | 毎朝の1枚（quality_daily） |`);
console.log(`| ⑧ 試験 | 答え方 promise の依頼 ${promiseAsks.length}（${new Set(promiseAsks).size}問） | 試験の問題 ${sp.length}問のうち ${pct(new Set(promiseAsks).size, sp.length)} | spec.json |`);

console.log(`\n## ① 見つけるの網の穴（その他の残り ${rest.length}・動詞ごと・入るはずの種類は案）`);
const by = new Map<string, KRow[]>();
for (const r of rest) by.set(String(r.key ?? "（動詞なし）"), [...(by.get(String(r.key ?? "（動詞なし）")) ?? []), r]);
for (const [k, xs] of [...by].sort((a, b) => b[1].length - a[1].length)) {
  const heads = new Map<string, number>();
  for (const x of xs) { const h = String(x.shape ?? "").replace(/[＊0-9０-９〇]+/g, "").replace(/[😊😌!！。、\s]/g, "").slice(0, 16); heads.set(h, (heads.get(h) ?? 0) + 1); }
  const top = [...heads].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h, n]) => `「${h}…」${n}`).join("・");
  console.log(`- ${k} ${xs.length}: ${HOLE_GUESS[k] ?? "—"}（多い形 ${top}）`);
}
