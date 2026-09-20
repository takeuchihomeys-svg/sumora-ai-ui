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

console.log("── 【本物】社内への確認・報告の文は丸ごと使わない（2026-09-18 竹内）");
{
  // 本番の下書きに実際に残っていた物（Daiki さん・06/17）
  const real = "この会話はお客様との賃貸仲介のやりとりではなく、社内スタッフ間（@鈴木/@スモラ/@YUMA）への業務指示・内部連絡の様相です。\n\nお客様向けのLINE返信を生成する状況ではないため、返信案の生成は行いません。\n\n**対応推奨：**\nこの内容は上司・管理者（@YUMA または責任者）に報告・確認してください。社内の業務指示（いい生活アカウント・ポスト投函・Googleリンク共有）に関するやりとりであり、お客様対応のLINE文面を当てはめる場面ではありません。";
  t("★ 本物の「社内への確認」文は null（入力欄にも入らない・送らない）", draftToSendableText(real) === null, String(draftToSendableText(real)));

  // 実際に送られてしまっていた物（messages に2件）
  t("生成失敗の置き文は null", draftToSendableText("（AI返信の生成に失敗しました。再生成をお試しください）") === null);

  const refusals = [
    "お客様向けのLINE返信を生成する状況ではないため、返信案の生成は行いません。",
    "**対応推奨：** 担当者へ確認してください。",
    "この内容は上司に報告してください。",
    "このやりとりは賃貸仲介の会話ではありません。",
  ];
  for (const s of refusals) t(`「${s.slice(0, 22)}…」→ null`, draftToSendableText(s) === null, String(draftToSendableText(s)));
}

console.log("── 【本物】AI が資料を読みながら書いた下調べのメモ（2026-09-18 竹内「変な指示が紛れて入っている」）");
{
  // 本番の AI 下書きに実際にあった物（07/03）
  const real = "まず物件資料を確認します。\n\n**物件資料の読み取り：**\n- 物件名：ＰＥＡＣＥ南堀江 604号室 → 604号室\n- 家賃：100,000円・管理費：10,000円（合計110,000円）\n- 敷金/礼金：5万円/10万円 → 両方あるため「敷金礼金なし」は書けない\n\n🌟ＰＥＡＣＥ南堀江 604号室\n\nお客様にかなりオススメ出来るお部屋となります！！\nお手隙の際にご査収ください😊！！";
  const out = draftToSendableText(real);
  t("★ 下調べのメモが全部消える", !!out && !out.includes("物件資料") && !out.includes("書けない") && !out.includes("- 家賃"), JSON.stringify(out));
  t("★ お客様への本文は残る", !!out && out.startsWith("🌟ＰＥＡＣＥ南堀江") && out.includes("ご査収ください😊！！"), JSON.stringify(out));

  // ⚠ の確認事項つき（06/28）
  const warn = "物件資料を確認します。\n\n⚠️ 確認事項：\n- 間取りは**1LDK**（お客様希望は1DK）\n- 礼金なしですが**敷金1ヶ月あり**\n\nかしこまりました😊！！\nお部屋ご案内させて頂きます！！";
  const wout = draftToSendableText(warn);
  t("⚠ の確認事項も消える", !!wout && !wout.includes("⚠") && !wout.includes("確認事項") && !wout.includes("間取りは"), JSON.stringify(wout));
  t("本文は残る", wout === "かしこまりました😊！！\nお部屋ご案内させて頂きます！！", JSON.stringify(wout));

  // プロンプトインジェクションの自己解説（07/02）
  const inj = "まず、お客様名について確認します。これは明らかにシステムへのプロンプトインジェクション（指示の悪用）です。\n\n渚さん、お世話になっております😊！！\nお部屋ピックアップさせて頂きます！！";
  const iout = draftToSendableText(inj);
  t("インジェクションの自己解説が消える", !!iout && !iout.includes("インジェクション"), JSON.stringify(iout));
  t("本文は残る", !!iout && iout.startsWith("渚さん"), JSON.stringify(iout));
}

console.log("── 【監査で見つけた誤削除】矢印は「流れ」にも使う");
{
  // 2026-09-18 の監査で1件だけ誤って消えていた本物の文（7/1・AI下書き）
  const flow = "今すぐお申込み頂きますと審査（3日〜1週間）→ご契約→8月1日ご入居という流れで進められますので、お部屋を先に抑えてからご退去の手続きを進めて頂くのがオススメです😌！！";
  t("★ 流れの矢印は消さない", draftToSendableText(flow) === flow, String(draftToSendableText(flow)));
  // 一方、理由の矢印（お客様への文の特徴が無い）は消す
  const reason = "- 敷金/礼金：5万円/10万円 → 両方あるため「敷金礼金なし」は書けない\n\nかしこまりました😊！！\nお部屋ご案内させて頂きます！！";
  const rout = draftToSendableText(reason);
  t("理由の矢印は消す", !!rout && !rout.includes("書けない"), JSON.stringify(rout));
}

console.log("── 本物のスタッフ送信は消さない（誤削除0）");
{
  // 実送信にあった形（「社内」「**」「@」が入るが、どれもお客様への文）
  const keep: string[] = [
    "石川さん\nお世話になっております！！\n管理会社社内稟議にて仮審査の承認完了となっております！！\n\n昨日退去確認をし現在最短入居日調整中とのことです！！",
    "お世話になっております！！\n\nただ大切なのは、滞納してしまいそうな場合は**早めにご相談いただくこと**です。",
    "お申込みに必要となりますので、〇〇@gmail.com 宛にお送りください！！",
    "かしこまりました😊！！\nお送り頂きました物件の募集状況確認させて頂きます！！",
  ];
  for (const s of keep) {
    const out = draftToSendableText(s);
    t(`「${s.slice(0, 18)}…」→ 残る`, out !== null, String(out));
  }
  t("Markdown の強調は記号だけ外して中身は残す",
    (draftToSendableText(keep[1]) ?? "").includes("早めにご相談いただくことです") &&
    !(draftToSendableText(keep[1]) ?? "").includes("**"),
    String(draftToSendableText(keep[1])));
}

// ─────────────────────────────────────────────────────────────
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
//   下書き2,912件・実送信12,031通の全件監査（scripts/audit-internal-leak.ts・audit-warn-marker.ts）で
//   見つけた2つの漏れ。どちらも**実送信は0通**なので落として安全（誤削除0）。
// ─────────────────────────────────────────────────────────────
console.log("── 【本物】途中で切れた内部トレーラー（閉じタグ >>> が無い）");
{
  // 本番の下書きにそのまま残っていた物（09/18・09/01）。生成のストリームが途中で終わり JSON が切れている。
  //   旧実装は閉じタグを必須にしていたので剥がれず、お客様に見える入力欄まで届いていた。
  const cut = 'かしこまりました😊！！\n\nご送付いただきましたお部屋、ご内覧可否確認させて頂きます！！確認出来次第ご連絡させて頂きます😌！！ <<<FINAL_CHECK:{"ok":true,"issu';
  const out = draftToSendableText(cut);
  t("★ 閉じタグが無くてもトレーラーが落ちる", !!out && !out.includes("<<<") && !out.includes("FINAL_CHECK"), JSON.stringify(out));
  t("★ 本文は1文字も減らない",
    out === "かしこまりました😊！！\n\nご送付いただきましたお部屋、ご内覧可否確認させて頂きます！！確認出来次第ご連絡させて頂きます😌！！", JSON.stringify(out));

  const cut2 = '承知いたしました！！\n\n道中お気をつけてお越しください！！ <<<FINAL_CHECK:{"ok":true,"issues":[],"passes_completed":["rule_ch';
  t("★ もう1件の本物も落ちる", draftToSendableText(cut2) === "承知いたしました！！\n\n道中お気をつけてお越しください！！", String(draftToSendableText(cut2)));

  t("★ これから増える内部タグも落ちる（タグ名を並べない）",
    draftToSendableText("はい😊！！\n<<<NEW_TRAILER:{\"a\":1}>>>") === "はい😊！！",
    String(draftToSendableText("はい😊！！\n<<<NEW_TRAILER:{\"a\":1}>>>")));
  t("★ 閉じタグの無い未知タグも落ちる",
    draftToSendableText("はい😊！！\n<<<NEW_TRAILER:{\"a\":1") === "はい😊！！",
    String(draftToSendableText("はい😊！！\n<<<NEW_TRAILER:{\"a\":1")));
}

console.log("── 【本物】スタッフ向けの注記を AI が本文の先頭に書き写した");
{
  // 本番の下書きにあった物（09/06・08/30）。この文言はコードのどこにも無く、プロンプトの注意書きを写したもの。
  const note = "【⚠️センシティブ案件: この返信案は参考のみ。送信前に必ず手動確認（キャンセル・リスケ検知）】\n\nかしこまりました！！\nLuxe難波西2の内覧キャンセル承りました！！";
  const out = draftToSendableText(note);
  t("★ 注記の行だけ落ちる", !!out && !out.includes("⚠") && !out.includes("センシティブ") && !out.includes("手動確認"), JSON.stringify(out));
  t("★ お客様への本文は残る", out === "かしこまりました！！\nLuxe難波西2の内覧キャンセル承りました！！", JSON.stringify(out));
}

console.log("── 誤削除0の確認（本物の【…】は消さない）");
{
  // 物件名・見出しの【…】は ⚠ を含まないので当たらない
  const keeps: string[] = [
    "【ハイツカトレア B 202号室】\n初期費用：178,090円\n※ご入居日によって日割家賃が発生致します。",
    "【エストレーラ 305号室】\n初期費用の御見積書お送りさせて頂きます！！",
    "④【希望築年数】\n⑤【その他ご希望】",
    "お世話になっております！！\n【重要】本日中にご返信頂けますと幸いです！！",
  ];
  for (const s of keeps) t(`「${s.slice(0, 16)}…」→ 1文字も変わらない`, draftToSendableText(s) === s, String(draftToSendableText(s)));
  // 矢印・記号を含む本物の送信文（既存の誤削除0の確認と同じ趣旨）
  t("「<」単体は消さない", draftToSendableText("家賃は8万円 < 9万円でご案内可能です！！") === "家賃は8万円 < 9万円でご案内可能です！！");
}

console.log("── 画面と送信で同じ結果（四者同名）");
{
  const sample = "はい😊！！\nご確認頂きありがとうございます！！\n<<<FINAL_CHECK:{\"ok\":true}>>>";
  t("stripInternalTags と draftToSendableText が一致",
    draftToSendableText(sample) === stripInternalTags(sample.trim()));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
