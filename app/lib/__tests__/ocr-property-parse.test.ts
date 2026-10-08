// 実行: npx tsx app/lib/__tests__/ocr-property-parse.test.ts
import { parseOcrPropertyJson, ocrPropertyProvider } from "../ocr-property-parse";
let ok = 0, ng = 0;
function eq(name: string, a: unknown, b: unknown) {
  if (JSON.stringify(a) === JSON.stringify(b)) { ok++; } else { ng++; console.log(`NG ${name}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
}
eq("素の JSON", parseOcrPropertyJson('{"prop_name": "プレサンス梅田北ザ・ライブ", "room_no": "305号室"}'), { prop_name: "プレサンス梅田北ザ・ライブ", room_no: "305号室" });
eq("コードブロック", parseOcrPropertyJson('```json\n{"prop_name":"エステムコート大阪WEST","room_no":""}\n```'), { prop_name: "エステムコート大阪WEST", room_no: "" });
eq("前後に文", parseOcrPropertyJson('読み取り結果です {"prop_name":" セレニテ江坂 ","room_no":" 1103号室 "} 以上'), { prop_name: "セレニテ江坂", room_no: "1103号室" });
eq("物件名が空は null", parseOcrPropertyJson('{"prop_name":"","room_no":"101号室"}'), null);
eq("壊れた JSON は null", parseOcrPropertyJson('{"prop_name": "A"'), null);
eq("空は null", parseOcrPropertyJson(""), null);
eq("既定は Claude", ocrPropertyProvider({ DEEPSEEK_API_KEY: "k" }), "claude");
eq("deepseek で試す", ocrPropertyProvider({ DEEPSEEK_API_KEY: "k", OCR_PROPERTY_PROVIDER: "deepseek" }), "deepseek");
eq("鍵なしは claude", ocrPropertyProvider({}), "claude");
console.log(`${ok} OK / ${ng} NG`);
process.exit(ng ? 1 : 0);
