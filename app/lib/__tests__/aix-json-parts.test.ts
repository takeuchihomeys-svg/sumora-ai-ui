// app/lib/__tests__/aix-json-parts.test.ts
// 2026-10-02 ⑫: AIX の部品の JSON が読めない時に生の出力を文にしない（YUMA の再生 flow4 t06 の実物）
// 実行: npx tsx app/lib/__tests__/aix-json-parts.test.ts
import { joinAixJsonParts } from "../aix-json-parts";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }
const ORDER = ["greeting", "situation", "invite", "dates", "closing"];

{
  // 実物（DeepSeek・「{」が無く途中から始まった）
  const raw = "10/3(土) 11:00〜13:00\n10/4(日) 14:00〜16:00にてご案内可能です😊！！\",\"closing\":\"YUMAさんご都合よろしいお日にち御座いますでしょうか😌！！\"}";
  const r = joinAixJsonParts(raw, ORDER);
  t("JSON の記号が文に残らない", !/"|\}/.test(r.text), r.text);
  t("日程と締めの両方を拾う", r.text.includes("10/4(日) 14:00〜16:00にてご案内可能です😊！！") && r.text.endsWith("御座いますでしょうか😌！！"), r.text);
  t("拾った印", r.salvaged && !r.failed);
}
{
  const ok = joinAixJsonParts('{"greeting":"かしこまりました！！","situation":"","invite":"お部屋ご案内させて頂きます！！","dates":"直近ですと\\n10/3(土) 11:00〜13:00にてご案内可能です😊！！","closing":"YUMAさんご都合よろしいお日にち御座いますでしょうか😌！！"}', ORDER);
  t("読める JSON はそのまま部品を並べる", ok.text.startsWith("かしこまりました！！\n\nお部屋ご案内") && !ok.salvaged && ok.parts?.dates?.includes("10/3") === true, ok.text);
}
{
  const plain = "かしこまりました！！\nお部屋ご案内させて頂きます😊！！";
  const r = joinAixJsonParts(plain, ORDER);
  t("JSON の形が無い普通の文はそのまま", r.text === plain && !r.salvaged);
  const quoted = "「13時」でお願いします、とのことでかしこまりました！！";
  t("かぎ括弧・普通の引用は JSON とみなさない", joinAixJsonParts(quoted, ORDER).text === quoted);
}
{
  const broken = '{"greeting":"かしこまりました！！","dates":"10/3(土) 11:00〜13:00", "closing": ';
  const r = joinAixJsonParts(broken, ORDER);
  t("途中で切れた JSON も読める部品だけ拾う", r.text.includes("かしこまりました！！") && r.text.includes("10/3(土)") && !/"/.test(r.text), JSON.stringify(r));
}
console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
