// ブレインに注入する【すでに送付済みの物件】の組み立てのテスト（2026-09-24）
// 実行: npx tsx app/lib/__tests__/sent-props-text.test.ts（全 PASS で exit 0）
import { buildSentProps, buildSentPropsText } from "../sent-props-text";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

const props = buildSentProps({
  customerRows: [
    { property_name: "YUMAテスト荘", room_no: "101", sent_at: "2026-09-24T03:00:00Z", source: "aix:property_send", channel: "pickup" },
    { property_name: "ハイム北野", room_no: "405", sent_at: "2026-09-20T03:00:00Z", source: "vision", channel: "recommendation" },
    { property_name: "サンモール木川", room_no: "203", sent_at: "2026-09-19T03:00:00Z", source: "aix:property_recommendation", channel: null },
  ],
  imageRows: [
    { property_name: "YUMAテスト荘", room_no: "101", created_at: "2026-09-24T03:00:00Z", source: "aix:property_send" },
    { property_name: "プロスペリテ", room_no: "306", created_at: "2026-09-18T03:00:00Z", source: "staff_image" },
  ],
  sharedRows: [
    { property_name: "YUMAテスト荘", room_no: "101", sent_at: "2026-09-23T03:00:00Z", rent: 50000 },
    { property_name: "YUMAテスト荘", room_no: "", sent_at: "2026-09-23T03:00:00Z", rent: 50000 },
    { property_name: "グレートヒルズ", room_no: "", sent_at: "2026-09-22T03:00:00Z", rent: 60000 },
  ],
});
const text = buildSentPropsText(props);
console.log(text);
t("同じ物件は送った行が勝つ（共有の行で上書きしない）", props.filter((p) => p.property_name === "YUMAテスト荘").length === 1 && !props.find((p) => p.property_name === "YUMAテスト荘")?.shared_only);
t("見出しの件数はお客様に送った件数（4件）", text.includes("【すでに送付済みの物件（4件）】"), text);
t("📤ピックアップの印", text.includes("YUMAテスト荘 101（") && text.includes("・📤ピックアップで送付"));
t("🌟オススメの印は channel 列からも（vision の行）", /ハイム北野 405（[^）]*🌟オススメで送付/.test(text));
t("🌟オススメの印は source からも（channel が NULL の古い行）", /サンモール木川 203（[^）]*🌟オススメで送付/.test(text));
t("共有のみは見出しを分けて出す", text.includes("▼グループに共有のみ（お客様には未送付・再提案は避ける）") && text.includes("グレートヒルズ") && text.includes("グループに共有のみ・お客様には未送付"));
t("再提案しない注記は残る", text.includes("絶対に再提案しないこと"));
t("オススメの注記に2件", text.includes("ハイム北野 405・サンモール木川 203"));
{
  const onlyShared = buildSentPropsText(buildSentProps({ customerRows: [], imageRows: [], sharedRows: [{ property_name: "グレートヒルズ", room_no: "", sent_at: "2026-09-22T03:00:00Z" }] }));
  t("共有だけの時は（0件）＋共有の見出し", onlyShared.includes("（0件）】\n▼グループに共有のみ"), onlyShared);
}
t("何も無ければ空文字", buildSentPropsText([]) === "");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
