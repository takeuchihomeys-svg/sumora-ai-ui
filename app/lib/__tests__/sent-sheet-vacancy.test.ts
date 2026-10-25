// 送った資料の現況を送った物件の行に載せる（2026-10-24 q053 型・BRAIN_SENT_SHEET_VACANCY）のテスト
// 実行: npx tsx app/lib/__tests__/sent-sheet-vacancy.test.ts（全 PASS で exit 0）
// 行は本物の image_details.lines の形（直近60日の実物から・物件名は伏せた）
import { buildSentProps, buildSentPropsText, sheetVacancyNote, attachSheetVacancy, sentSheetVacancyOn } from "../sent-props-text";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

// ① 読み取りの行から拾う（見出しの順・字のまま）
t("退去予定と日付", sheetVacancyNote(["物件名: A", "現況: 退去予定", "入居可能日: 相談", "退去予定: 9/30", "入居条件: 外国人契約可能"]) === "現況 退去予定・退去予定 9/30・入居可能日 相談", sheetVacancyNote(["現況: 退去予定", "入居可能日: 相談", "退去予定: 9/30"]));
t("空室・即入", sheetVacancyNote(["現況: 空室", "入居可能日: 即入"]) === "現況 空室・入居可能日 即入");
t("入居条件は拾わない", sheetVacancyNote(["入居条件: 2人入居可能"]) === null);
t("見出しが重なれば最初の1つ", sheetVacancyNote(["現況: 退去予定", "現況: 空室"]) === "現況 退去予定");
t("内覧可能日", sheetVacancyNote(["内覧可能日：2026年8月1日〜"]) === "内覧可能日 2026年8月1日〜");
t("配列でない・空", sheetVacancyNote(null) === null && sheetVacancyNote([]) === null && sheetVacancyNote("現況: 空室") === null);

// ② 同じ物件の資料と見積書の画像をまとめ、資料の方の読み取りを付ける（q053: 見積書の画像が新しい行で先に来る）
const props = buildSentProps({
  customerRows: [
    { property_name: "テスト館", room_no: "202", sent_at: "2026-09-19T06:24:57Z", image_url: "u-estimate" },
    { property_name: "テスト館", room_no: "202", sent_at: "2026-09-19T06:24:50Z", image_url: "u-sheet" },
    { property_name: "別館", room_no: "303", sent_at: "2026-09-19T06:24:40Z", image_url: "u-sheet2" },
  ],
  imageRows: [], sharedRows: [],
});
t("同じ物件は1行・画像の URL は2つ", props.length === 2 && (props[0].image_urls ?? []).join(",") === "u-estimate,u-sheet", props.map((p) => p.image_urls));
const n = attachSheetVacancy(props, new Map<string, unknown>([["u-estimate", ["初期費用: 225,680円"]], ["u-sheet", ["現況: 空室", "入居可能日: 相談"]], ["u-sheet2", ["現況: 退去予定"]]]));
t("2件に付いた", n === 2 && props[0].sheet_vacancy === "現況 空室・入居可能日 相談" && props[1].sheet_vacancy === "現況 退去予定");
const text = buildSentPropsText(props);
t("行に送った時点の日付つきで出る", text.includes("送った資料（9/19時点）の現況 空室・入居可能日 相談") && text.includes("送った資料（9/19時点）の現況 退去予定"), text);
t("読み方の注記が出る", text.includes("※「送った資料の現況」は送った時点の資料の字"));

// ③ 付けない時（既定 off＝読み取りを引かない）は今と同じ文
const plain = buildSentProps({ customerRows: [{ property_name: "テスト館", room_no: "202", sent_at: "2026-09-19T06:24:57Z" }], imageRows: [], sharedRows: [] });
const plainText = buildSentPropsText(plain);
t("付けなければ注記も行も出ない", !plainText.includes("送った資料") && !plainText.includes("※「送った資料の現況」"));
t("共有のみには付けない", attachSheetVacancy([{ property_name: "X", room_no: "", sent_at: "", rent: null, recruitment_status: null, applicant_rank: null, customer_reaction: null, shared_only: true, image_urls: ["u"] }], new Map([["u", ["現況: 空室"]]])) === 0);

// ④ スイッチ
t("既定 off", sentSheetVacancyOn({}) === false && sentSheetVacancyOn({ BRAIN_SENT_SHEET_VACANCY: "on" }) === true && sentSheetVacancyOn({ BRAIN_SENT_SHEET_VACANCY: "off" }) === false);

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
