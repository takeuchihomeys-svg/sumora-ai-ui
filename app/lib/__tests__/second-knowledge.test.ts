import { secondKnowledgeOn, secondKnowledgeLines } from "../second-appeal-judge";
const a = secondKnowledgeLines({ propertyName: "プレジオ江坂SOUTH 0201号室", lifestyle: ["彼氏と同棲予定"] });
const ok = !secondKnowledgeOn({}) && secondKnowledgeOn({ AIX_SECOND_KNOWLEDGE: "on" }) && a.length === 3 && /人気マンション/.test(a[1]) && /暮らしに最適/.test(a[2])
  && secondKnowledgeLines({ propertyName: "メゾンA", lifestyle: [] }).length === 0;
console.log(ok ? "second-knowledge: pass" : "second-knowledge: FAIL " + JSON.stringify(a));
if (!ok) process.exit(1);
