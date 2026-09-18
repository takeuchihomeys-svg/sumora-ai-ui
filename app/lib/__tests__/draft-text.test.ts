// app/lib/__tests__/draft-text.test.ts
// 2026-09-18 竹内「これ文の生成とかは返信の下書き通りになるよね、今までのセットされている」
//   → 画面の入力欄に出る文と、自動返信で送る文が**同じ関数**（draft-text.ts）を通ることを固定する。
// 実行: npx tsx app/lib/__tests__/draft-text.test.ts
import { stripInternalTags, draftToSendableText } from "../draft-text";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── 下書きはそのまま送る（勝手に書き換えない）");
{
  const plain = "かしこまりました😊！！\nお送り頂きました物件の募集状況確認させて頂きます！！\n何卒よろしくお願い致します！！";
  t("ふつうの下書きは1文字も変わらない", draftToSendableText(plain) === plain, JSON.stringify(draftToSendableText(plain)));
  t("絵文字・改行・！！はそのまま", (draftToSendableText(plain) ?? "").includes("😊！！\nお送り"));
}

console.log("── 社内向けの物だけ外す（お客様に飛ばさない）");
{
  const withTags = "はい😊！！\nご確認頂きありがとうございます！！\n<<<STOP_REASON:low_confidence>>>\n<<<SUGGESTED_AIX:{\"action\":\"property_send\"}>>>";
  const out = draftToSendableText(withTags);
  t("内部タグは外れる", !!out && !out.includes("<<<") && !out.includes(">>>"), JSON.stringify(out));
  t("本文は残る", out === "はい😊！！\nご確認頂きありがとうございます！！", JSON.stringify(out));

  const quoted = "「かしこまりました！！ご案内させて頂きます！！」";
  t("全体を囲む「」は外す", draftToSendableText(quoted) === "かしこまりました！！ご案内させて頂きます！！");
  const innerQuote = "「メゾン加美北」の募集状況確認させて頂きます！！";
  t("文中の「」は触らない", draftToSendableText(innerQuote) === innerQuote, String(draftToSendableText(innerQuote)));
}

console.log("── 送る物が無い時は null（自動返信はここで止まる）");
{
  for (const s of ["[AIX誘導中]", "__SHOWN__", "[画像のみ]"]) {
    t(`合図「${s}」は送らない`, draftToSendableText(s) === null);
  }
  t("空・null・undefined は送らない",
    draftToSendableText("") === null && draftToSendableText(null) === null && draftToSendableText(undefined) === null);
  t("タグだけの下書きは送らない", draftToSendableText("<<<STOP_REASON:x>>>") === null);
}

console.log("── AI の作業メモは落とす（2026-09-15 竹内「こんなの絶対にいれない」）");
{
  const memo = "お客様がスタンプのみで返信されている状況ですね。追加の催促にならないよう、短く待つ姿勢のみを示します。\n\nはい😊！！\n引き続き何卒よろしくお願い致します！！";
  const out = draftToSendableText(memo);
  t("作業メモの行が消える", !!out && !out.includes("状況ですね"), JSON.stringify(out));
  t("お客様への文は残る", !!out && out.includes("引き続き何卒よろしくお願い致します！！"));
}

console.log("── 画面と送信で同じ結果（四者同名）");
{
  const sample = "はい😊！！\nご確認頂きありがとうございます！！\n<<<FINAL_CHECK:{\"ok\":true}>>>";
  t("stripInternalTags と draftToSendableText が一致",
    draftToSendableText(sample) === stripInternalTags(sample.trim()));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
