// 返信の下書きと実送信（とくに竹内さんの手打ち）の近さの物差し（読むだけ・LLM なし）
//
// 2026-10-13 竹内さん「徹底的に行う。実際の竹内が使っている文も参考に」— 今と後を同じ物差しで測る（本番に入った後も同じスクリプトで比べる）。
//   ① AI の下書きをスタッフが直さずに送った割合（正規化＝空白・絵文字を除いて同じ）
//   ② 送る前に直された量（文字数の差・行数の差・全体の近さ 1−Dice）
//   ③ 竹内さんの手打ちの番での近さ: 行数の差／言い直し（前のこちらの約束と同じ中身の約束）の有無が一致／次の一手の1文（約束・誘い）の有無が一致／全体の近さ
//   場面: 受けだけ（お礼・了承）／中身あり。前と後の比べは --file=<json>（[{id, draft}]・試しの下書きで差し替え）
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-vs-takeuchi.ts [--days=30] [--file=<json>] [--since=2026-10-14]
import fs from "node:fs";
import { loadTurns, type Turn } from "./audit-draft-repeat";
import { splitSentencesJa, promiseTopics, topicRepeats, isAckOnlyTurn, normalizeSentence } from "../app/lib/draft-repeat";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const DAYS = Number(arg("days") ?? 30);

const lineCount = (s: string) => String(s ?? "").split("\n").filter((x) => x.trim()).length;
const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]/gu, "");
function dice(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  const A = new Map<string, number>(), B = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) A.set(x.slice(i, i + 2), (A.get(x.slice(i, i + 2)) ?? 0) + 1);
  for (let i = 0; i < y.length - 1; i++) B.set(y.slice(i, i + 2), (B.get(y.slice(i, i + 2)) ?? 0) + 1);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
  return na + nb ? 2 * inter / (na + nb) : 0;
}
/** 次の一手の1文（約束・誘い・待ちの形）があるか */
export const hasNextStep = (s: string) => splitSentencesJa(s).some((x) => promiseTopics(x).length > 0 && normalizeSentence(x).length >= 10);
/** 前のこちらの約束の言い直しがあるか */
const hasRestate = (s: string, t: Turn) => topicRepeats(s, t.priorStaff.filter((p) => p.back <= 2)).length > 0;

type Acc = { n: number; same: number; dChars: number; dLines: number; dist: number; tkN: number; tkLines: number; tkLinesAbs: number; tkRestate: number; tkNext: number; tkNextMissing: number; tkSim: number };
const newAcc = (): Acc => ({ n: 0, same: 0, dChars: 0, dLines: 0, dist: 0, tkN: 0, tkLines: 0, tkLinesAbs: 0, tkRestate: 0, tkNext: 0, tkNextMissing: 0, tkSim: 0 });

export function measure(turns: Turn[], draftOf: (t: Turn) => string) {
  const acc = new Map<string, Acc>();
  for (const t of turns) {
    const d = draftOf(t);
    if (!d || !t.sent) continue;
    const scene = !t.customer.length ? "こちらから" : isAckOnlyTurn(t.customer) ? "受けだけ" : "中身あり";
    for (const k of ["全体", scene]) {
      const a = acc.get(k) ?? newAcc();
      a.n++;
      if (norm(d) === norm(t.sent)) a.same++;
      a.dChars += Math.abs(norm(d).length - norm(t.sent).length);
      a.dLines += Math.abs(lineCount(d) - lineCount(t.sent));
      a.dist += 1 - dice(d, t.sent);
      if (t.writer === "takeuchi") {
        a.tkN++;
        a.tkLines += lineCount(d) - lineCount(t.sent);
        a.tkLinesAbs += Math.abs(lineCount(d) - lineCount(t.sent));
        if (hasRestate(d, t) === hasRestate(t.sent, t)) a.tkRestate++;
        const dn = hasNextStep(d), sn = hasNextStep(t.sent);
        if (dn === sn) a.tkNext++;
        if (sn && !dn) a.tkNextMissing++;
        a.tkSim += dice(d, t.sent);
      }
      acc.set(k, a);
    }
  }
  return acc;
}

export function printAcc(acc: Map<string, Acc>, title: string) {
  console.log(`\n=== ${title} ===`);
  console.log(`   場面        番   ①直さず送った  ②文字の差  行の差  遠さ ｜ ③竹内さんの番  行(下書き−竹内) |行差|  言い直し一致  次の一手一致  次の一手の抜け  近さ`);
  const pct = (x: number, n: number) => n ? `${(x / n * 100).toFixed(0)}%` : "-";
  const avg = (x: number, n: number, f = 1) => n ? (x / n).toFixed(f) : "-";
  for (const k of ["全体", "受けだけ", "中身あり", "こちらから"]) {
    const a = acc.get(k); if (!a) continue;
    console.log(`   ${k.padEnd(8)} ${String(a.n).padStart(4)}   ${pct(a.same, a.n).padStart(6)}       ${avg(a.dChars, a.n, 0).padStart(5)}   ${avg(a.dLines, a.n).padStart(4)}  ${avg(a.dist, a.n, 2)} ｜ ${String(a.tkN).padStart(4)}          ${avg(a.tkLines, a.tkN).padStart(5)}       ${avg(a.tkLinesAbs, a.tkN).padStart(4)}   ${pct(a.tkRestate, a.tkN).padStart(6)}       ${pct(a.tkNext, a.tkN).padStart(6)}       ${String(a.tkNextMissing).padStart(4)}       ${avg(a.tkSim, a.tkN, 2)}`);
  }
}

async function main() {
  let turns = await loadTurns(DAYS);
  if (arg("since")) turns = turns.filter((t) => t.at >= Date.parse(arg("since")!));
  const file = arg("file");
  if (file) {
    const rows = JSON.parse(fs.readFileSync(file, "utf8")) as { id: string; draft?: string; before?: string; after?: string }[];
    const ids = new Set(rows.map((r) => r.id));
    const sub = turns.filter((t) => ids.has(t.id) || ids.has(t.id.slice(0, 8)));
    const get = (t: Turn, k: "draft" | "before" | "after") => rows.find((r) => r.id === t.id || r.id === t.id.slice(0, 8))?.[k] ?? "";
    printAcc(measure(sub, (t) => t.draft), `本番の下書き（同じ番 ${sub.length}）`);
    if (rows.some((r) => r.before)) printAcc(measure(sub, (t) => get(t, "before")), "試し: 前");
    if (rows.some((r) => r.after)) printAcc(measure(sub, (t) => get(t, "after")), "試し: 後");
    if (rows.some((r) => r.draft)) printAcc(measure(sub, (t) => get(t, "draft")), "試し: 差し替え");
    return;
  }
  printAcc(measure(turns, (t) => t.draft), `直近${DAYS}日の本番の下書き（line_reply ${turns.length}番${arg("since") ? `・${arg("since")}〜` : ""}）`);
  // 見本（目で読む）: 受けだけの番で 下書き2行以内・竹内さん3行以上
  if (process.argv.includes("--samples-ack")) {
    const m = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様)/g, "〈名〉").replace(/\n+/g, " ／ ");
    const ss = turns.filter((t) => t.writer === "takeuchi" && t.customer.length && isAckOnlyTurn(t.customer));
    let short = 0, nextMiss = 0;
    for (const t of ss) {
      const dl = lineCount(t.draft), sl = lineCount(t.sent);
      if (dl <= 2 && sl >= 3) {
        short++;
        const miss = hasNextStep(t.sent) && !hasNextStep(t.draft);
        if (miss) nextMiss++;
        console.log(`── ${t.id.slice(0, 8)} 下書き${dl}行・竹内さん${sl}行${miss ? "・次の一手の抜け" : ""}\n   客: ${m(t.customer.join("／")).slice(0, 60)}\n   前: ${m(t.priorStaff[0]?.text ?? "").slice(-90)}\n   下: ${m(t.draft).slice(0, 120)}\n   竹: ${m(t.sent).slice(0, 140)}`);
      }
    }
    const lens = ss.map((t) => lineCount(t.sent)).sort((a, b) => a - b);
    console.log(`\n   受けだけの番（竹内さん ${ss.length}）: 竹内さんの行数 p50 ${lens[Math.floor(lens.length / 2)]}・3行以上 ${lens.filter((x) => x >= 3).length}／下書き2行以内で竹内さん3行以上 ${short}（うち次の一手の抜け ${nextMiss}）`);
  }
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
