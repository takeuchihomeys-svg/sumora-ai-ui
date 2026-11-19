// 2026-11-19 統括Pro「最善の判断・迷ったら竹内さんへ推奨つきで確認」の純関数のテスト
// 実行: npx tsx app/lib/__tests__/supervisor-owner-ask.test.ts（全 PASS で exit 0）
import {
  ensureRecommended, parseOwnerAsks, deriveGateAsks, findContradictions, mergeAsks, ledgerDedupeKey, ledgerOpenPrefix, jstDayOf, renderOwnerAsks, proTextOf, HOLD_OPTION,
} from "../supervisor-owner-ask";
import { parseSupervisorPro } from "../learn-supervisor-pro";

let fail = 0;
const ok = (c: boolean, m: string) => { if (c) console.log(`PASS ${m}`); else { fail++; console.log(`FAIL ${m}`); } };

// 1. 推奨は必ず選択肢の中
{
  const a = ensureRecommended(["直す", "そのまま"], "直す");
  ok(a.recommended === "直す" && a.options.length === 2, "推奨が選択肢にあればそのまま");
  const b = ensureRecommended(["直す", "そのまま"], "全く別の案");
  ok(b.recommended === HOLD_OPTION && b.options.includes(HOLD_OPTION), "推奨が選択肢に無ければ保留を足して推奨にする（勝手に動く方を勧めない）");
  const c = ensureRecommended([], null);
  ok(c.recommended === HOLD_OPTION && c.options.length === 1, "選択肢も推奨も無ければ保留だけ");
  const d = ensureRecommended(["A案（先に実測）", "B案"], "A案");
  ok(d.recommended === "A案（先に実測）", "推奨が選択肢の一部の語でも選択肢に寄せる");
  const e = ensureRecommended(["直す"], "直す");
  ok(e.options.length === 2 && e.recommended === "直す", "選択肢1つなら保留を足して2つにする");
}

// 2. Pro の出力の取り込み
{
  const asks = parseOwnerAsks([
    { question: "photo_learn を何枚やるか", options: ["dry-run", "30枚", "しない"], recommended: "dry-run", why: "費用が出る", trigger: "cost" },
    { question: "", options: ["a"] },
    { q: "別の言い方の問い", options: [], recommended: "どれ", trigger: "変な値" },
  ]);
  ok(asks.length === 2, "質問が空の物は捨てる（2件残る）");
  ok(asks[0].trigger === "cost" && asks[0].source === "pro" && asks[0].recommended === "dry-run", "trigger・推奨を保つ");
  ok(asks[1].trigger === "other" && asks[1].recommended === HOLD_OPTION, "trigger が不明なら other・推奨が無ければ保留");
  ok(parseOwnerAsks(null).length === 0 && parseOwnerAsks("x").length === 0, "配列でなければ空");
  const many = parseOwnerAsks(Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, options: ["a", "b"], recommended: "a" })));
  ok(many.length === 4, "最大4件（聞きすぎない）");
}

// 3. 関所: 聞くべき場面を決定論で拾う
{
  const g = deriveGateAsks({ proText: "次手: ALTER TABLE search_audits に列を足す" });
  ok(g.length === 1 && g[0].trigger === "db_change" && g[0].recommended.includes("中身"), "DB の構造変更 → 中身を見せるが推奨");
  const p = deriveGateAsks({ proText: "busy_other_customer で一括を止める判断を変える" });
  ok(p.some((x) => x.trigger === "policy"), "一括の方針変更 → policy");
  const dep = deriveGateAsks({ proText: "main へ push して本番反映" });
  ok(dep.some((x) => x.trigger === "deploy"), "本番反映 → deploy");
  const cost = deriveGateAsks({ proText: "photo_learn を実行して弱い欄を読む（flash・費用）" });
  ok(cost.some((x) => x.trigger === "cost" && x.recommended.includes("dry-run")), "費用が出る学習 → dry-run が推奨");
  const none = deriveGateAsks({ proText: "拡張を再読込して自動を1回走らせ、印を確認する" });
  ok(none.length === 0, "無料・元に戻せる次手では聞かない");
  const low = deriveGateAsks({ proText: "原因は2つ考えられる", confidence: "low", confidenceWhy: "候補が拮抗" });
  ok(low.length === 1 && low[0].trigger === "low_confidence" && low[0].recommended.includes("実測"), "確信 low → 実測を先にが推奨");
  const hi = deriveGateAsks({ proText: "原因は1つ", confidence: "high" });
  ok(hi.length === 0, "確信 high なら聞かない");
}

// 4. 統括の言葉の矛盾（到達が高いのに反映の実証 read=0）
{
  const c = findContradictions({ verdict: "almost", coverage: 85, proText: "F55 read=0 で停止", evidenceValues: [] });
  ok(c.length === 1, "almost/85% と F55 read=0 は矛盾として拾う");
  ok(findContradictions({ verdict: "not_yet", coverage: 40, proText: "F55 read=0", evidenceValues: [] }).length === 0, "到達が低いなら矛盾ではない");
  ok(findContradictions({ verdict: "almost", coverage: 85, proText: "F55 read=3", evidenceValues: [] }).length === 0, "read≥1 なら矛盾ではない");
  const g = deriveGateAsks({ proText: "F38 read=0", verdict: "ready", coverage: 90 });
  ok(g.some((x) => x.trigger === "contradiction" && x.recommended.includes("未実証")), "矛盾 → 未実証として扱うが推奨");
}

// 5. まとめ方（二重に聞かない・Pro の問いを優先）
{
  const pro = parseOwnerAsks([{ question: "DB に列を足してよいか", options: ["足す", "足さない"], recommended: "足す", why: "x", trigger: "db_change" }]);
  const gate = deriveGateAsks({ proText: "CREATE TABLE foo" });
  const m = mergeAsks(pro, gate);
  ok(m.length === 1 && m[0].source === "pro", "同じ trigger は Pro の問いを残し関所は足さない");
  const m2 = mergeAsks([], deriveGateAsks({ proText: "ALTER TABLE a / main へ push / photo_learn を実行 / busy_other_customer", verdict: "almost", coverage: 90 }));
  ok(m2.length <= 4 && m2.every((x) => x.options.includes(x.recommended)), "最大4件・全部に推奨がある");
}

// 6. 台帳の種
{
  const k = ledgerDedupeKey("realpro", { key: "cost-abc" }, "20261119");
  ok(k === "sup-pro:realpro:cost-abc:20261119", "同じ日・同じ問いは同じ種");
  ok(k.startsWith(ledgerOpenPrefix("realpro", "cost")), "未回答の見張りの前置きが種に当たる");
  ok(!k.startsWith(ledgerOpenPrefix("itandi", "cost")) && !k.startsWith(ledgerOpenPrefix("realpro", "policy")), "別 scope・別 trigger には当たらない");
  ok(jstDayOf(Date.parse("2026-11-19T16:00:00Z")) === "20261120", "日本の日付で数える（UTC 16時は翌日）");
}

// 7. 表示
{
  const asks = deriveGateAsks({ proText: "photo_learn を実行" });
  const txt = renderOwnerAsks(asks, ["12345678-aaaa"]).join("\n");
  ok(/オススメ/.test(txt) && /owner-questions\.ts --answer 12345678/.test(txt), "推奨と答え方（コマンド）を出す");
  ok(renderOwnerAsks([]).join("").includes("迷い無し"), "迷い無しの時の表示");
}

// 8. Pro の JSON から確信・根拠・問いが取れる／proText に meet は入らない
{
  const e = parseSupervisorPro(JSON.stringify({
    confidence: "low", confidence_why: "候補が拮抗", decision_basis: ["F55 read=0", "kb 2761d873"],
    owner_asks: [{ question: "反映の実証まで保留でよいか", options: ["保留", "進める"], recommended: "保留", why: "read=0", trigger: "contradiction" }],
    today: ["把握: …"], next_line: "拡張再読込→自動1回",
  }));
  ok(!!e && e.confidence === "low" && e.decision_basis?.length === 2 && e.owner_asks?.length === 1, "確信・根拠・問いを parse する");
  ok(!!e && !proTextOf(e).includes("ALTER"), "proText は Pro の文だけ");
  const old = parseSupervisorPro(JSON.stringify({ today: ["把握: …"] }));
  ok(!!old && (old.owner_asks?.length ?? 0) === 0 && old.confidence === null, "旧形式の出力でも壊れない");
}

console.log(fail ? `\n${fail} FAIL` : "\n全 PASS");
process.exit(fail ? 1 : 0);
