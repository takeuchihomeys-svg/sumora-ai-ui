// app/lib/draft-confidence-priors.ts — 場面ごとの「下書きがそのまま送られた」前例の表（自動で書く・手で直さない）
// 書く: npx tsx --env-file=.env.local scripts/audit-draft-confidence.ts --write-priors（2026-10-21・1198番）
// 中身は場面の鍵（line-watch-turn sceneKeyOf）と件数だけ（会話・お客様の情報は入らない）
export const DRAFT_CONFIDENCE_PRIOR_BASE = 0.331;
export const DRAFT_CONFIDENCE_SCENE_PRIORS: Readonly<Record<string, { n: number; asIs: number }>> = {
  "AIX:acknowledge_check": { n: 16, asIs: 8 },
  "AIX:application_push": { n: 3, asIs: 0 },
  "AIX:condition_hearing": { n: 3, asIs: 1 },
  "AIX:cost_breakdown": { n: 1, asIs: 0 },
  "AIX:cost_explain": { n: 3, asIs: 0 },
  "AIX:estimate_sheet": { n: 12, asIs: 0 },
  "AIX:greeting_viewing": { n: 1, asIs: 1 },
  "AIX:guarantor_info": { n: 2, asIs: 0 },
  "AIX:meeting_place": { n: 5, asIs: 1 },
  "AIX:property_check_result": { n: 37, asIs: 12 },
  "AIX:property_recommendation": { n: 10, asIs: 3 },
  "AIX:property_search": { n: 6, asIs: 2 },
  "AIX:property_send": { n: 78, asIs: 29 },
  "AIX:viewing_invite": { n: 14, asIs: 6 },
  "AIX:zenryoku_support": { n: 4, asIs: 0 },
  "返信:その他": { n: 5, asIs: 0 },
  "返信:意図:chat": { n: 178, asIs: 66 },
  "返信:意図:consultation": { n: 9, asIs: 3 },
  "返信:意図:decision": { n: 61, asIs: 17 },
  "返信:意図:desire": { n: 114, asIs: 48 },
  "返信:意図:negative": { n: 11, asIs: 2 },
  "返信:意図:positive": { n: 117, asIs: 30 },
  "返信:意図:question": { n: 193, asIs: 56 },
  "返信:断り・キャンセル": { n: 3, asIs: 0 },
  "返信:条件提示": { n: 100, asIs: 55 },
  "返信:検討中・一時保留": { n: 26, asIs: 8 },
  "返信:短い了承・お礼": { n: 63, asIs: 17 },
  "返信:質問": { n: 123, asIs: 31 },
};
