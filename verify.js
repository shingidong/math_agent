// verify.js — 수치미분으로 부정적분 답 검증 (mathjs 전역 의존)

function verifyIntegral(answerExpr, integrandExpr) {
  if (!answerExpr || !integrandExpr) return { result: "na", points: 0, exact: false };
  if (typeof math === "undefined") return { result: "na", points: 0, exact: false };

  const POINTS = [0.3137, 0.7213, 1.1391, 1.9273, 2.3817, -0.5129, -1.3461];
  const H = 1e-5;

  var F, f;
  try {
    F = math.compile(String(answerExpr));
    f = math.compile(String(integrandExpr));
  } catch (e) {
    return { result: "na", points: 0, exact: false };
  }

  function safeEval(compiled, scope) {
    try {
      var v = compiled.evaluate(scope);
      return typeof v === "number" && isFinite(v) ? v : NaN;
    } catch (e) {
      return NaN;
    }
  }

  var valid = 0, passing = 0;

  for (var i = 0; i < POINTS.length; i++) {
    var x = POINTS[i];
    var Fp = safeEval(F, { x: x + H });
    var Fm = safeEval(F, { x: x - H });
    var fx = safeEval(f, { x: x });

    if (isNaN(Fp) || isNaN(Fm) || isNaN(fx)) continue;

    var num = (Fp - Fm) / (2 * H);
    var relErr = Math.abs(num - fx) / (1 + Math.abs(fx));
    valid++;
    if (relErr < 1e-3) passing++;
  }

  if (valid < 3) return { result: "na", points: valid, exact: false };

  // 다항식/유리식이면 유한 확정, 초월함수이면 확률적
  var isExact = !/sin|cos|tan|exp|log|sqrt|pi/.test(answerExpr + integrandExpr);

  if (passing === valid) {
    return { result: "pass", points: valid, exact: isExact };
  } else {
    return { result: "fail", points: valid, exact: isExact };
  }
}
