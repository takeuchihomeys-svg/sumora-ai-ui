// ブレインの自己点検（scripts/lib/brain-self-review.ts）の決め方の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/brain-self-review.test.ts（全 PASS で exit 0）
import {
  splitLines, keywordsOf, excerptOf, buildPacket, quoteInLine, checkEvidence, parseExplanation, bundleProposals, similarKey, causeCore, renderMarkdown, morningLine,
  usdOf, estimateUsdOf, WHERE, FIX, EXPLAIN_SYSTEM, type CaseResult,
} from "../brain-self-review";
import { pickEntry, readLocalSpendToday, appendLocalSpend, type CassetteIndexRow } from "../brain-self-review-io";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// ─── 行・言葉 ───
ok("splitLines: 空行を捨て長い行を切る", JSON.stringify(splitLines("a\n\n" + "あ".repeat(500), 240).map((l) => [...l].length)) === JSON.stringify([1, 240, 240, 20]));
const kw = keywordsOf(["新着でご条件（独立洗面台・トイレ別）に合った物件が出たらお送りする", "ack_form receive_only"]);
ok("keywordsOf: 漢字・カタカナ・英字の語", kw.includes("新着") && kw.includes("独立洗面台") && kw.includes("トイレ") && kw.includes("ack_form") && kw.includes("receive_only"), kw.join(","));
ok("keywordsOf: 止め語（物件）を外す", !kw.includes("物件"));

// ─── 抜粋: 予算内なら全部・超えたら言葉の行と見出しと材料の塊 ───
const small = excerptOf({ name: "x", text: "a\nb\nc", budget: 100 }, ["a"]);
ok("excerpt: 予算内は全部", small.lines.length === 3 && small.kept === 3);
const filler = Array.from({ length: 400 }, (_, i) => `関係のない決まりの行その${i}・いろいろ書いてある`);
const mat = [...filler.slice(0, 200), "【まだ果たしていない探す約束（材料）】独立洗面台・トイレ別で引き続き探す", ...filler.slice(200, 300), "- ack_form: 【前の約束への了承】の材料がある番だけ receive_only か wait_line", ...filler.slice(300), "- 🔚 締め: 追加の締め文なし・全力でサポートを足さない"].join("\n");
const ex = excerptOf({ name: "材料", text: mat, budget: 1500 }, keywordsOf(["独立洗面台 トイレ別 新着", "ack_form"]));
ok("excerpt: 材料の塊の行を拾う", ex.lines.some((l) => l.includes("まだ果たしていない探す約束")));
ok("excerpt: 決まりの名前（ack_form）の行を拾う", ex.lines.some((l) => l.includes("前の約束への了承")));
ok("excerpt: 省いた所は「…（N行省略）」", ex.lines.some((l) => /^…（\d+行省略）$/.test(l)));
ok("excerpt: 元の順番", ex.lines.findIndex((l) => l.includes("探す約束")) < ex.lines.findIndex((l) => l.includes("前の約束への了承")));
const exI = excerptOf({ name: "下書き", text: mat, budget: 1500, instructions: true }, ["無関係語"]);
ok("excerpt: 指示の行（締め・足さない）は言葉が無くても拾う", exI.lines.some((l) => l.includes("🔚 締め")));

// ─── 材料の束・根拠の確かめ ───
const pk = buildPacket([{ name: "判断", lines: ["ack_form=receive_only", "reply_direction: 了承を受けるだけ"] }, { name: "材料A", lines: ["【まだ果たしていない探す約束（材料）】独立洗面台・トイレ別で引き続き探す"] }, { name: "空", lines: [] }]);
ok("buildPacket: 通しの L 番号", pk.text.includes("L3: 【まだ") && pk.lines.length === 3 && !pk.text.includes("■ 空"));
ok("quoteInLine: そのまま", quoteInLine("まだ果たしていない探す約束", pk.lines[2].text));
ok("quoteInLine: 空白・記号の違いは許す", quoteInLine("まだ 果たしていない「探す約束」", pk.lines[2].text));
ok("quoteInLine: 違う文は false", !quoteInLine("内覧の日程を決める", pk.lines[2].text));
ok("checkEvidence: 1行ずれは直す", checkEvidence({ line: 2, quote: "探す約束（材料）" }, pk).line === 3 && checkEvidence({ line: 2, quote: "探す約束（材料）" }, pk).ok === true);
ok("checkEvidence: 無い引用は ok=false", checkEvidence({ line: 3, quote: "審査の結果を推測" }, pk).ok === false);
ok("checkEvidence: 区分の名前", checkEvidence({ line: 1, quote: "receive_only" }, pk).section === "判断");

// ─── LLM の答えを読む ───
const good = parseExplanation({
  findings: [{ where: "材料にあったのに読めなかった", why: "材料に探す約束があるのに受けだけにした", brain_ok: false, cause_key: "見出しの名前違い", confidence: "高", evidence: [{ line: 3, quote: "まだ果たしていない探す約束" }, { line: 1, quote: "receive_only" }] }],
  fix: { kind: "材料をつなぐ", target: "探す約束の材料の見出し", plan: "見出しを決まりと同じ名前にする", needs_takeuchi: false, question: null },
}, pk);
ok("parse: 決まった語は通る", good.findings.length === 1 && good.findings[0].where === "材料にあったのに読めなかった" && good.findings[0].grounded && good.fix?.kind === "材料をつなぐ" && !good.invalid.length, JSON.stringify(good.invalid));
const bad = parseExplanation({ findings: [{ where: "なんとなく", why: "x", evidence: [] }, { where: "決まり・出口が上書きした", why: "y", evidence: [{ line: 99, quote: "無い" }] }], fix: { kind: "全部直す" } }, pk);
ok("parse: 決まっていない語は捨てる", bad.findings.length === 1 && bad.invalid.some((s) => s.includes("なんとなく")) && bad.fix === null);
ok("parse: 根拠の無い説明は grounded=false・確かさは低", bad.findings[0].grounded === false && bad.findings[0].confidence === "低");
ok("parse: JSON の文字列も読む", parseExplanation('```json\n{"findings":[],"fix":null}\n```', pk).invalid.length === 0);
ok("parse: 壊れた答え", parseExplanation("こわれた", pk).invalid[0] === "JSON でない");
const ask = parseExplanation({ findings: [{ where: "人しか知らない事（AIX の番）", why: "z", evidence: [{ line: 2, quote: "了承を受けるだけ" }] }], fix: { kind: "竹内さんに聞く", plan: "内覧の時間の標準を決める", target: "内覧の時間" } }, pk);
ok("parse: 竹内さんに聞く は needsTakeuchi・question は案で埋める", ask.fix?.needsTakeuchi === true && ask.fix.question === "内覧の時間の標準を決める");
ok("語の一覧: 外れの場所 7・直し 6", WHERE.length === 7 && FIX.length === 6 && FIX.includes("竹内さんに聞く"));
ok("前置き: 全部の語が入っている（語を変えたら前置きも）", [...WHERE, ...FIX].every((w) => EXPLAIN_SYSTEM.includes(w)));

// ─── 束ね ───
ok("causeCore: 型の語尾を外す", causeCore("新着メッセージの見落とし") === "新着メッセージ" && causeCore("締めの指示の矛盾") === "締めの指示");
ok("similarKey: 語尾だけ同じ別の原因は近くない", similarKey("名義貸しの話題の見落とし", "新着メッセージの見落とし") < 0.4);
ok("similarKey: 同じ原因は近い", similarKey("締めの指示の矛盾", "締め指示の矛盾") >= 0.4);
const mk = (id: string, kind: typeof FIX[number], where: typeof WHERE[number], key: string, kb = "kb1", needs = false): CaseResult => ({
  caseId: `exam:${id}`, source: "exam", ids: [id], title: id, kb: [{ id: kb, title: "知見" }],
  exp: { findings: [{ where, why: "w", evidence: [], brainOk: false, causeKey: key, confidence: "高", grounded: true }], fix: { kind, plan: `案${id}`, target: `所${key}`, needsTakeuchi: needs, question: needs ? "聞く" : null }, invalid: [] },
});
const bs = bundleProposals([
  mk("q1", "材料をつなぐ", "材料にあったのに読めなかった", "見出しの名前違い"),
  mk("q2", "材料をつなぐ", "材料にあったのに読めなかった", "見出しの名前の違い"),
  mk("q3", "材料をつなぐ", "材料にあったのに読めなかった", "名義貸しの話題の見落とし", "kb9"),
  mk("q4", "決まりを変える", "判断は合っていて下書きで崩れた", "締めの指示の矛盾"),
  mk("q5", "竹内さんに聞く", "人しか知らない事（AIX の番）", "内覧の時間", "kb3", true),
]);
ok("束ね: 同じ原因は1つに・数の多い順", bs[0].n === 2 && bs[0].ids.join(",") === "q1,q2", JSON.stringify(bs.map((b) => [b.causeKeys, b.n])));
ok("束ね: 別の原因は別", bs.length === 4);
ok("束ね: 竹内さんに聞く は別の束", bs.some((b) => b.needsTakeuchi && b.questions[0] === "聞く"));
const md = renderMarkdown({ day: "2026-10-18", results: [mk("q1", "材料をつなぐ", "材料にあったのに読めなかった", "見出しの名前違い")], bundles: bs, usd: 0.05, skipped: ["q9: 申込以降"] });
ok("一覧: 竹内さんに聞く・直しの案・出さなかった物", md.includes("## 竹内さんに聞く事") && md.includes("## 直しの案") && md.includes("q9: 申込以降") && md.includes("自動で入れていない"));
ok("朝の1行", morningLine("2026-10-18", [], bs).startsWith("🧠 自己点検 2026-10-18") && morningLine("2026-10-18", [], bs).includes("見出しの名前違い"));

// ─── 費用 ───
const pr = { in: 0.66, read: 0.022, out: 1.98 };
ok("usdOf: 100万トークン", Math.abs(usdOf({ miss: 1e6, hit: 0, out: 0 }, pr, false) - 0.66) < 1e-9 && Math.abs(usdOf({ miss: 1e6, hit: 0, out: 0 }, pr, true) - 1.32) < 1e-9);
ok("estimateUsdOf: 4万字で数円（$0.05 未満）", estimateUsdOf(40_000, pr, false) < 0.05 && estimateUsdOf(40_000, pr, false) > 0.01);

// ─── 録音の選び方（同じ回の札を先に・今の発言の判断 brain_fresh を先に） ───
const R = (f: string, action: string | null, rep: string, ats: string[], draft = false): CassetteIndexRow => ({ f, size: 1, action, problem: "q1", rep, ats, draft, len: 1 });
const idx = [
  R("full", "brain_full", "1", ["2026-10-16T14:50:35Z", "2026-10-16T14:51:31Z"]),
  R("fresh1", "brain_fresh", "1", ["2026-10-16T14:50:53Z"]),
  R("fresh2", "brain_fresh", "2", ["2026-10-16T14:51:50Z"]),
  R("old", "brain_fresh", "1", ["2026-10-15T01:00:00Z"]),
  R("d1", null, "1", ["2026-10-16T14:51:01Z"], true),
];
ok("pickEntry: 回1 は brain_fresh の回1（回2 の新しい方を取らない）", pickEntry(idx, { problem: "q1", rep: 1, at: "2026-10-16T14:50:13Z", kind: "brain" })?.f === "fresh1");
ok("pickEntry: 回2", pickEntry(idx, { problem: "q1", rep: 2, at: "2026-10-16T14:51:11Z", kind: "brain" })?.f === "fresh2");
ok("pickEntry: 下書き", pickEntry(idx, { problem: "q1", rep: 1, at: "2026-10-16T14:50:13Z", kind: "draft" })?.f === "d1");
ok("pickEntry: 時刻より後（2分を超える）の録音は使わない", pickEntry(idx, { problem: "q1", rep: 1, at: "2026-10-15T02:00:00Z", kind: "brain" })?.f === "old");
ok("pickEntry: brain_fresh が無ければ brain_full", pickEntry(idx.filter((r) => r.action !== "brain_fresh"), { problem: "q1", rep: 1, at: "2026-10-16T14:50:13Z", kind: "brain" })?.f === "full");

// ─── その日の費用（DB の外） ───
const dir = mkdtempSync(join(tmpdir(), "bsr-"));
try {
  const f = join(dir, "spend.jsonl");
  const now = new Date("2026-10-18T05:00:00Z");
  appendLocalSpend({ at: "2026-10-18T01:00:00Z", tool: "brain-self-review", usd: 0.02, calls: 1 }, f);
  appendLocalSpend({ at: "2026-10-17T14:00:00Z", tool: "brain-self-review", usd: 0.5, calls: 1 }, f);  // JST 10/17 23:00 ＝前の日
  appendLocalSpend({ at: "2026-10-17T15:30:00Z", tool: "other", usd: 0.1, calls: 1 }, f);  // JST 10/18 0:30
  const s = readLocalSpendToday(now, f);
  ok("readLocalSpendToday: JST の今日だけ・道具ごと", Math.abs(s.usd - 0.12) < 1e-9 && Math.abs((s.byTool["brain-self-review"] ?? 0) - 0.02) < 1e-9, JSON.stringify(s));
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`${fail ? "FAIL" : "PASS"} ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
