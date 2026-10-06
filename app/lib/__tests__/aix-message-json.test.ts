// app/lib/__tests__/aix-message-json.test.ts
// 2026-10-06 ⑰: AIX の {"message"} の JSON が読めない時に生の出力を文にしない（物件ピックアップの下書きの末尾に "} が残った実物の形）
// 実行: npx tsx app/lib/__tests__/aix-message-json.test.ts
import { readAixMessageJson, stripJsonEdgeResidue } from "../aix-message-json";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }

{
  // 実物の形（10/05 物件ピックアップ）: 文字列の中に生の改行＝JSON.parse が失敗する。旧は生の出力が文になり、1行目が落ちて末尾に "} が残った
  const raw = '{"message": "〇〇さん\n\n堺区周辺全域から〇〇さんにオススメできる2LDK以上・築浅またはリノベのお部屋をピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！"}';
  const r = readAixMessageJson(raw);
  t("JSON の名残（\"} や {\"message\"）が文に残らない", !/["{}]/.test(r.text), r.text);
  t("名前の行が残る", r.text.startsWith("〇〇さん\n"), r.text);
  t("締めまで残る", r.text.endsWith("お手隙の際にご査収ください😌！！"), r.text);
  t("拾った印", r.salvaged && !r.failed);
}
{
  // 実物の形（9/20）: 末尾だけが残った形（先頭の {"message": " が無い）
  const raw = '大阪市都島区・旭区からファミリー向けのお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！"}';
  const r = readAixMessageJson(raw);
  t("先頭の欠けた形でも \"} が残らない（読めなければ空）", !/"\s*\}\s*$/.test(r.text), r.text);
}
{
  const ok = readAixMessageJson('{"message":"かしこまりました！！\\nお部屋ご案内させて頂きます😊！！"}');
  t("読める JSON は message をそのまま（改行を戻す）", ok.text === "かしこまりました！！\nお部屋ご案内させて頂きます😊！！" && !ok.salvaged, JSON.stringify(ok));
  const dbl = readAixMessageJson('{"message":"かしこまりました！！\\\\nお部屋ご案内させて頂きます！！"}');
  t("二重に逃がした改行も改行に戻す（旧と同じ）", dbl.text === "かしこまりました！！\nお部屋ご案内させて頂きます！！", JSON.stringify(dbl));
}
{
  const plain = "〇〇さん\nお手隙の際にこちらの電話をかけるボタンよりお電話お願い致します😊！！";
  t("JSON の形が無い普通の文はそのまま", readAixMessageJson(plain).text === plain);
  const braces = "〇〇さん\n{家賃}の欄は空欄で大丈夫です！！";
  t("かっこがあっても JSON でなければそのまま", readAixMessageJson(braces).text === braces);
}
{
  const noMsg = readAixMessageJson('{"text":"かしこまりました！！"}');
  t("読めた JSON に message が無い時は生の JSON を文にしない（空）", noMsg.text === "", JSON.stringify(noMsg));
}
console.log("■ 出口の端の名残（stripJsonEdgeResidue・2026-10-07 Ryoichi）");
{
  // 実物（aix_generate_log 8b139bd2 の generated_text そのまま）
  const ryoichi = "堺区周辺全域からRyoichiさんにオススメできる2LDK以上・築浅またはリノベのお部屋をピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！\"}";
  const r = stripJsonEdgeResidue(ryoichi);
  t("末尾の \"} を落とす（実物）", r.stripped && r.text.endsWith("お手隙の際にご査収ください😌！！") && !/["}]/.test(r.text), JSON.stringify(r));
  const head = stripJsonEdgeResidue('{"message":"〇〇さん\\n\\nお部屋ピックアップさせて頂きました！！"}');
  t("先頭の {\"message\":\" と末尾を落とし改行を戻す", head.stripped && head.text === "〇〇さん\n\nお部屋ピックアップさせて頂きました！！", JSON.stringify(head));
  const headNoClose = stripJsonEdgeResidue('{"message":"〇〇さん\n\nお部屋ピックアップさせて頂きました！！"');
  t("閉じの } が無い時も先頭と末尾の \" を落とす", headNoClose.text === "〇〇さん\n\nお部屋ピックアップさせて頂きました！！", JSON.stringify(headNoClose));
  const tailSp = stripJsonEdgeResidue("お手隙の際にご査収ください😌！！\"\n}");
  t("\"\\n} の形も落とす", tailSp.text === "お手隙の際にご査収ください😌！！", JSON.stringify(tailSp));
  const mid = '10/3(土) 11:00〜13:00にてご案内可能です😊！！","closing":"YUMAさんご都合よろしいお日にち御座いますでしょうか😌！！"}';
  t("中に鍵が残る形は触らない（送信 API が止める）", stripJsonEdgeResidue(mid).text === mid && !stripJsonEdgeResidue(mid).stripped);
  for (const plain of ["〇〇さん\nお手隙の際にご査収ください😌！！", "顔文字です{笑}", "「ありがとうございます」とお伝え下さい", "(*´꒳`*)}", "ご案内可能です！！\n}"]) {
    t(`普通の文はそのまま: ${JSON.stringify(plain).slice(0, 30)}`, stripJsonEdgeResidue(plain).text === plain && !stripJsonEdgeResidue(plain).stripped);
  }
  t("\"} だけの文は空にしない（そのまま）", stripJsonEdgeResidue('"}').text === '"}');
}
console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
