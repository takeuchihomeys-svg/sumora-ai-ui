// 2026-10-06 竹内「設計知見の更新や成長はツールを完成させるにあたってかなり重要」（⑯）: 設計知見の整理の決まりを固定する
// 実行: npx tsx app/lib/__tests__/design-knowledge-curation.test.ts（自己完結・env 不要。全 OK で exit 0）
import {
  findDuplicates, findDecisionConflicts, decisionRow, similarPairs, parseSimilar, maskForLlm, looksMojibake, mojibakeFields, buildDigest, areasOf, pickKeeper,
  DECISIONS, type KbRow,
} from "../design-knowledge-curation";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}
let n = 0;
const row = (o: Partial<KbRow>): KbRow => ({ id: `id-${++n}`, title: "題", insight: "本文", is_current: true, created_at: "2026-09-01T00:00:00Z", tags: [], ...o });

console.log("── ① 重複");
{
  const a = row({ title: "同じ題の知見", insight: "同じ本文がここに入っている。長さもほぼ同じで、言い回しも同じ。", created_at: "2026-09-27T01:00:00Z" });
  const b = row({ title: "同じ題の知見", insight: "同じ本文がここに入っている。長さもほぼ同じで、言い回しも同じ。", rationale: "根拠が付いている方", created_at: "2026-09-27T01:00:01Z" });
  const c = row({ title: "同じ題の知見", insight: "まったく別の話。物件検索の採点の決まり。", created_at: "2026-09-28T00:00:00Z" });
  const d = findDuplicates([a, b, c]);
  t("題が同じ・本文が同じ → 中身の多い方を残して他を退役", d.length === 1 && d[0].id === a.id && d[0].supersededBy === b.id, d);
  t("題が同じでも本文が違う行は重複にしない", !d.some((p) => p.id === c.id));
  t("退役済みの行は数えない", findDuplicates([{ ...a, is_current: false }, b]).length === 0);
  t("中身が同じ長さなら新しい方を残す", pickKeeper(row({ insight: "x", created_at: "2026-09-01" }), row({ insight: "y", created_at: "2026-09-02" })).insight === "y");
}

console.log("── ② 竹内さんの決定");
{
  const oldMeet = row({ title: "待ち合わせ場所の約束（追ってご連絡）が残っている時は AIX【待ち合わせ】", created_at: "2026-10-02T07:36:00Z" });
  const newMeet = row({ title: "待ち合わせ場所は内覧日が決まった時点で1件目の内覧の物件 — 「追ってご連絡」は書かない", created_at: "2026-10-02T08:18:00Z" });
  const mention = row({ title: "日時が決まった後の聞き直しは自動で送らない", insight: "待ち合わせ場所は内覧日が決まった時点で1件目の内覧の物件（1290264c）が正。", created_at: "2026-10-06T00:00:00Z" });
  const oldEmoji = row({ title: "絵文字は 😊 😌 🌟 ✨ だけ（見積書の✅だけ残す）", created_at: "2026-10-01T21:36:00Z" });
  const newEmoji = row({ title: "絵文字の今の決まり: ✅ はどの文でも残す", insight: "旧「見積書の✅だけ残す」は古い", created_at: "2026-10-06T00:00:00Z" });
  const rows = [oldMeet, newMeet, mention, oldEmoji, newEmoji];
  const meetD = DECISIONS.find((d) => d.key === "meeting_first_property")!;
  t("決定の行は題で見る（本文で触れているだけの新しい行を決定の行にしない）", decisionRow(rows, meetD)?.id === newMeet.id);
  const r = findDecisionConflicts(rows);
  t("待ち合わせの古い行は退役（上書きした行＝決定の行）", r.retire.some((p) => p.id === oldMeet.id && p.supersededBy === newMeet.id));
  t("絵文字の古い行（見積書の✅だけ）は退役", r.retire.some((p) => p.id === oldEmoji.id && p.supersededBy === newEmoji.id));
  t("決定の行自身・決定より後の行は退役しない", !r.retire.some((p) => [newMeet.id, newEmoji.id, mention.id].includes(p.id)));
  const later = row({ title: "待ち合わせ場所の約束（追ってご連絡）が残っている時は AIX【待ち合わせ】", created_at: "2026-10-03T00:00:00Z" });
  t("決定より後に書かれた行は古い扱いにしない", !findDecisionConflicts([newMeet, later]).retire.some((p) => p.id === later.id));
  const fitOld = row({ title: "AD は効かせる", insight: "🌟の前置きは『AD 2ヶ月以上は必ず最上位』をやめ…", created_at: "2026-09-25T05:05:00Z" });
  const fitNew = row({ title: "スタッフの🌟は『同じ回の中で間取りが合い・広く・新しい』を選ぶ", created_at: "2026-10-06T04:31:00Z" });
  t("「…をやめ」と書いてある行は古い言い方に当てない", findDecisionConflicts([fitOld, fitNew]).review.length === 0);
  const autoOnly = findDecisionConflicts([row({ title: "AIX【確認します】をブレインの候補から外す", created_at: "2026-10-02T09:00:00Z" }), row({ title: "URL → AIX【確認します】を出す", created_at: "2026-09-01T00:00:00Z" })]);
  t("auto でない決定は退役せず要確認へ", autoOnly.retire.length === 0 && autoOnly.review.length === 1);
  t("決定の行が無い決定は missing に出す", findDecisionConflicts([]).missing.length === DECISIONS.length);
}

console.log("── ③ 似ている組・DeepSeek の答え");
{
  const a = row({ title: "draft_attempted_at を即解放する", insight: "bg-async 完了時に draft_attempted_at を null にして即解放する。5分ロックを避ける。" });
  const b = row({ title: "draft_attempted_at 即解放パターン", insight: "5分ロックを避けるため bg-async の完了時に draft_attempted_at を null で即解放する。" });
  const c = row({ title: "見積書の割引は判定に入れない", insight: "こちらが自由に決める値は物件の判定に入れない。" });
  const ps = similarPairs([a, b, c]);
  t("似ている組だけ候補に出る", ps.length === 1 && [ps[0].a.id, ps[0].b.id].sort().join() === [a.id, b.id].sort().join(), ps.map((p) => [p.body, p.title]));
  t("週の見直しは新しい行を含む組だけ", similarPairs([a, b], { sinceIso: "2026-10-01T00:00:00Z" }).length === 0);
  t("答えの読み取り（JSON）", parseSimilar('{"relation":"same","reason":"同じ"}')?.relation === "same" && parseSimilar("ちがう") === null && parseSimilar('{"relation":"maybe"}') === null);
  t("電話・メールの形は伏せて渡す", !/090|@/.test(maskForLlm("連絡は 090-1234-5678 か a@b.co へ")));
  // 2026-10-08 竹内さん: LINE の表示名・呼び名は渡して良い／申込フォーマットの本名は渡さない
  {
    const m = maskForLlm("ゆなまるさんの件。氏名：山田 花子\nフリガナ：ヤマダ ハナコ\n生年月日：1998年4月5日\n緊急連絡先氏名(続柄)：山田太郎\n年収：300万");
    t("記入欄の本名・フリガナ・生年月日は伏せる", !/山田|ヤマダ|1998/.test(m) && m.includes("氏名：［伏せ］"));
    t("LINE の表示名・呼び名は伏せない・年収は基準として残す", m.includes("ゆなまるさん") && m.includes("年収：300万"));
    t("文字化け: 9/01 の実物の題は文字化け・普通の日本語や ? を1つ含む文は違う", looksMojibake("Chrome??????????3???(?????itandi?????)???????") && looksMojibake("area_mode?DB???autofill??????????") && looksMojibake("文字�け") && !looksMojibake("審査通りますか？") && !looksMojibake("What? 内覧の希望") && !looksMojibake(""));
    t("文字化けの欄を挙げる（札も見る）", JSON.stringify(mojibakeFields({ title: "正しい題", insight: "????????", tags: ["Chrome拡張", "??????"] })) === JSON.stringify(["insight", "tags"]));
    t("記入欄でない語（呼び名・表示名の説明）は触らない", maskForLlm("呼び名: あかり／表示名：あ") === "呼び名: あかり／表示名：あ");
  }
}

console.log("── ④ 分野ごとのまとめ");
{
  const r1 = row({ title: "内覧の候補は直近の空いている日を3つ", tags: ["内覧"], insight: "竹内さん「直近3つ」", created_at: "2026-10-02T00:00:00Z" });
  const r2 = row({ title: "古い内覧の決まり", tags: ["内覧"], is_current: false });
  const r3 = row({ title: "見積書の割引", tags: ["見積書"] });
  const d = buildDigest([r1, r2, r3], "内覧", "2026-10-06T00:00:00Z");
  t("現行の行だけ・id 付き", d.markdown.includes("内覧の候補は直近の空いている日を3つ") && d.markdown.includes(r1.id.slice(0, 8)) && !d.markdown.includes("古い内覧の決まり"));
  t("他の分野の行は入れない", !d.markdown.includes("見積書の割引") && d.ids.length === 1);
  t("竹内さんの決定の一覧を先頭に出す", /## 竹内さんの決定/.test(d.markdown) && d.markdown.includes("待ち合わせ場所＝内覧日が決まった時点で1件目"));
  t("分野は札と題の語で決まる", areasOf(row({ title: "初期費用の分割はカード払い", tags: [] })).includes("費用") && areasOf(row({ title: "x", tags: ["Chrome拡張"] })).includes("拡張"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
