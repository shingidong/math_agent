// evidence.js — 통과 관문 증거 추출 및 기법 추정 (결정론적 코드)

function extractEvidence(text) {
  const t = String(text || "");
  const goal    = /넓이|부피|값|구하|얼마|최댓|최솟|극대|극소|확률|합이|적분값/.test(t);
  const method  = /치환|부분적분|부분분수|기본공식|기본\s*공식|역미분/.test(t);
  const expr    = /∫|=[^>]/.test(t);
  const partial = (t.match(/[=∫]/g) || []).length >= 2 ||
                  /까지\s*했|나왔|나왔어|했는데|했어|구했어|나와/.test(t);
  const answer  = !(/∫/.test(t)) &&
                  /=\s*[-\d]|[0-9]+\s*$|[0-9]+\s*\+\s*C|[0-9]+\s*\/\s*[0-9]|\+\s*C\s*$/.test(t) &&
                  expr;
  return { goal, method, expr, partial, answer };
}

function guessTechnique(problemText) {
  const t = String(problemText || "");

  // 명시적 기법명 우선
  if (/부분적분/.test(t)) return "byparts";
  if (/부분분수/.test(t)) return "partialfrac";
  if (/치환/.test(t))     return "substitution";

  // 구조 판별: 다항식 × 지수/삼각/로그 → 부분적분
  if (/(x(\^[0-9]+)?)\s*[\*·×]?\s*(e\^x|e\s*\^|sin|cos|ln|log)/.test(t)) return "byparts";
  if (/(sin|cos|ln|log|e\^)\s*[\*·×]?\s*(x(\^[0-9]+)?)/.test(t))          return "byparts";

  // 분모가 인수분해되는 유리식 → 부분분수
  if (/\(x\s*[\+\-]\s*[0-9a-z]\)\s*\(x\s*[\+\-]\s*[0-9a-z]\)/.test(t))   return "partialfrac";
  if (/[0-9]\s*\/\s*\([^)]*x[^)]*\)\s*\([^)]*x[^)]*\)/.test(t))           return "partialfrac";

  // 합성함수 꼴 (내부함수의 도함수가 밖에 있음) → 치환
  if (/\([^)]*x[^)]*\)\s*\^[2-9]/.test(t))  return "substitution";
  if (/sin\([^x)]|cos\([^x)]/.test(t))       return "substitution";
  if (/sqrt\s*\([^x)]/.test(t))              return "substitution";

  // 단순 다항식 → 기본
  if (/^\s*[\d\s\+\-\*\/\^x]+\s*$/.test(t.replace(/∫|dx|,|\(|\)|\.\s/g, ""))) return "basic";

  return "other";
}
