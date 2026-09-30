// app/lib/__tests__/condition-scope-bundle.test.ts — 実行: npx tsx app/lib/__tests__/condition-scope-bundle.test.ts
// 2026-09-30 YUMA の通しテスト（今回だけ／条件そのもの・4場面）で見つかった物:
//   ② 未返信の発言が束で判断される: 先の「今回だけ1階も見たいです」が未返信のまま「これからは駅10分以内でお願いします」「やっぱり1Kに変えてください」が来ると、
//      束の中の「今回だけ」に当たって後の発言まで今回だけになり、P4 が書いた登録の変更まで戻される
//   ③ 今回だけの家賃が登録の追加条件に残る: 「一旦家賃12万で」→ 家賃は 9万に戻ったのに additional_conditions に「[9/30 17:23|auto] 家賃上限: 120000」
import { resolveScopeForBundle, resolveConditionChangeScope, stripRevertedAutoNotes, planScopeRevert, BUNDLE_SEP } from "../condition-change-scope";
import { MSG_SEP } from "../reply-context";
import { buildTemporaryOverride } from "../condition-scope-override";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra !== undefined ? ` -- ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const S1 = "今回だけ1階も見たいです";
const S2 = "一旦家賃12万で見てもらえますか";
const S3 = "これからは駅10分以内でお願いします";
const S4 = "やっぱり1Kに変えてください";
const bundle = (...xs: string[]) => xs.join(MSG_SEP);

console.log("── 区切りは返信の束と同じ字");
t("MSG_SEP は U+2063 を含む（BUNDLE_SEP と同じ）", MSG_SEP.includes(BUNDLE_SEP) && BUNDLE_SEP === "⁣");

console.log("── 旧の形（束の全文を1回で判断）＝後の発言まで今回だけになっていた");
t("旧: ①＋③ → temporary（誤り）", resolveConditionChangeScope({ text: bundle(S1, S3) }).scope === "temporary");
t("旧: ①＋④ → temporary（誤り）", resolveConditionChangeScope({ text: bundle(S1, S4) }).scope === "temporary");

console.log("── 発言ごと（YUMA の4場面）");
{
  const a = resolveScopeForBundle({ text: S1, brainScope: "temporary" });
  t("① 1通だけ → 今回だけ・上書きの元は①", a.decision.scope === "temporary" && a.decision.by === "text_temporary" && a.temporaryText === S1 && a.permanentText === null && a.parts === 1, a);
  const b = resolveScopeForBundle({ text: bundle(S1, S2) });
  t("② ①＋「一旦家賃12万で」→ 最後は弱い今回だけ（根拠は「一旦」・①の「今回だけ」ではない）", b.decision.scope === "temporary" && b.decision.by === "text_temporary_weak" && b.decision.evidence === "一旦" && b.lastText === S2, b);
  t("② 上書きの元は①と②の両方", !!b.temporaryText && b.temporaryText.includes(S1) && b.temporaryText.includes(S2) && b.permanentText === null, b);
  const ov = buildTemporaryOverride(b.temporaryText!, { rent_max: 90000, floor_plan: "1K、1LDK", walk_minutes: 10 } as never).override;
  t("② 上書きは 1階も含める＋家賃12万", !!ov && ov.floor_min === 1 && ov.rent_max === 120000, ov);
  const c = resolveScopeForBundle({ text: bundle(S1, S3), brainScope: "permanent" });
  t("★ ③ ①＋「これからは駅10分以内で」→ 最後は切り替え（これからは）", c.decision.scope === "permanent" && c.decision.by === "text_permanent_future" && c.lastText === S3, c);
  t("★ ③ 上書きの元は①だけ（駅10分を今回だけにしない）・登録を書く側には③だけ", c.temporaryText === S1 && c.permanentText === S3, c);
  const ovC = buildTemporaryOverride(c.temporaryText!, { rent_max: 90000, floor_plan: "1K、1LDK", walk_minutes: 10 } as never).override;
  t("③ 残る上書きは 1階も含める だけ（徒歩は入らない）", !!ovC && ovC.floor_min === 1 && ovC.walk_minutes == null && ovC.rent_max == null, ovC);
  const d = resolveScopeForBundle({ text: bundle(S1, S2, S3, S4) });
  t("★ ④ 4通の束の最後「やっぱり1Kに変えてください」→ 切り替え（P4 の 1K を戻さない）", d.decision.scope === "permanent" && d.decision.by === "text_permanent" && d.lastText === S4 && d.parts === 4, d);
  t("④ 今回だけ＝①②・切り替え＝③④", !!d.temporaryText && d.temporaryText.includes(S1) && d.temporaryText.includes(S2) && !d.temporaryText.includes(S3) && !d.temporaryText.includes(S4)
    && !!d.permanentText && d.permanentText.includes(S3) && d.permanentText.includes(S4) && !d.permanentText.includes(S1), d);
}

console.log("── 前の発言は文の語だけ・ブレインの欄は最後の発言にだけ使う");
{
  const a = resolveScopeForBundle({ text: bundle("福島区でお願いします", "1階も見てみたいです"), brainScope: "temporary" });
  t("最後の発言に語が無い → ブレインの temporary", a.decision.scope === "temporary" && a.decision.by === "brain", a);
  t("語の無い前の発言は切り替え側（今回だけにしない）", a.temporaryText === "1階も見てみたいです" && a.permanentText === "福島区でお願いします", a);
  const b = resolveScopeForBundle({ text: bundle("とりあえず今後は1Kでお願いします", "ありがとうございます"), brainScope: "none" });
  t("前の発言「とりあえず今後は」＝期間の語が勝つ（今回だけにしない）", b.temporaryText === null && b.permanentText === "とりあえず今後は1Kでお願いします" && b.decision.scope === "none", b);
  const c = resolveScopeForBundle({ text: bundle(S1, "この物件の初期費用を教えてください"), brainScope: "none" });
  t("最後が条件の話でない（none）でも、前の「今回だけ」の上書きは残る・登録を書く側には何も渡さない", c.decision.scope === "none" && c.temporaryText === S1 && c.permanentText === null, c);
  const e = resolveScopeForBundle({ text: "", brainScope: null });
  t("空の文", e.decision.scope === "permanent" && e.decision.by === "default" && e.parts === 0, e);
  const f = resolveScopeForBundle({ text: bundle(S3, ""), brainScope: null });
  t("空の通は数えない（1通と同じ）", f.parts === 1 && f.decision.by === "text_permanent_future", f);
  const g = resolveScopeForBundle({ text: bundle("条件は変えずに", "今回は見送ります"), brainScope: "none" });
  t("断りの「今回は見送ります」は今回だけにしない", g.decision.scope === "none" && g.temporaryText === null, g);
}

console.log("── ③ 戻した列の「新着要望」の行を外す（stripRevertedAutoNotes）");
{
  // YUMA の実物: 17:23 に P4 が 12万と書き、ブレインが 9万に戻した後に残った行
  const a = stripRevertedAutoNotes("[9/30 17:23|auto] 家賃上限: 120000", { rent_max: "120000" });
  t("★ 1行だけ → 追加条件は空に", a.text === null && a.removed.length === 1, a);
  const b = stripRevertedAutoNotes("[9/28 10:02|auto] こだわり: バストイレ別\n[9/30 17:23|auto] 家賃上限: 120000、こだわり: 2階以上", { rent_max: 120000 });
  t("同じ行の他の項目・前の行は残す", b.text === "[9/28 10:02|auto] こだわり: バストイレ別\n[9/30 17:23|auto] こだわり: 2階以上", b);
  const c = stripRevertedAutoNotes("[9/30 17:23|auto] 間取り: 1K、家賃上限: 120000", { rent_max: 120000 });
  t("行の後ろの項目", c.text === "[9/30 17:23|auto] 間取り: 1K", c);
  const d = stripRevertedAutoNotes("[9/30 17:23|auto] 家賃上限: 1200000", { rent_max: 120000 });
  t("値の途中には当てない（1200000）", d.text === "[9/30 17:23|auto] 家賃上限: 1200000" && d.removed.length === 0, d);
  const e = stripRevertedAutoNotes("家賃上限: 120000（スタッフのメモ）", { rent_max: 120000 });
  t("人が書いた行（|auto でない）は触らない", e.text === "家賃上限: 120000（スタッフのメモ）" && e.removed.length === 0, e);
  const f = stripRevertedAutoNotes("[9/20 09:00|auto] 家賃上限: 120000\n[9/30 17:23|auto] 家賃上限: 120000", { rent_max: 120000 });
  t("同じ値の行が2つ → 後ろ（今回の発言）の1つだけ", f.text === "[9/20 09:00|auto] 家賃上限: 120000", f);
  const g = stripRevertedAutoNotes("[9/30 17:23|auto] こだわり: オートロック", { rent_max: 120000 });
  t("当たる項目が無ければそのまま", g.text === "[9/30 17:23|auto] こだわり: オートロック" && g.removed.length === 0, g);
  t("空・null はそのまま", stripRevertedAutoNotes(null, { rent_max: 1 }).text === null && stripRevertedAutoNotes("", { rent_max: 1 }).text === "");
  const h = stripRevertedAutoNotes("[9/30 17:23|auto] 徒歩分数: 5、エリア: 福島区", { walk_minutes: "5", desired_area: "福島区" });
  t("2つの列を戻した時は両方外して行ごと消す", h.text === null && h.removed.length === 2, h);
  const i = stripRevertedAutoNotes("[9/30 17:23|auto] その他: ペット相談", { other_requests: "ペット相談" });
  t("戻す対象でない列（自由文）は外さない", i.text === "[9/30 17:23|auto] その他: ペット相談", i);
}

console.log("── planScopeRevert は書かれていた値も返す（行を外す材料）");
{
  const since = "2026-09-30T08:23:00.000Z";
  const p = planScopeRevert([{ changed_field: "rent_max", old_value: "90000", new_value: "120000", created_at: "2026-09-30T08:23:05.000Z" }], { rent_max: 120000 }, since);
  t("戻す値 9万・書かれていた値 12万", p.updates.rent_max === 90000 && p.written.rent_max === "120000", p);
  const q = planScopeRevert([{ changed_field: "rent_max", old_value: "90000", new_value: "120000", created_at: "2026-09-30T08:23:05.000Z" }], { rent_max: 100000 }, since);
  t("間に人が直した列は戻さない＝書かれていた値も返さない", !("rent_max" in q.updates) && !("rent_max" in q.written), q);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
