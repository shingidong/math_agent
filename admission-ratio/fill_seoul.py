#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""서울대 PDF는 폰트에 유니코드 매핑이 없어 pdftotext/OCR로 학과명을 뽑을 수 없다.
그래서 Claude가 PDF 페이지 이미지를 직접 읽어(비전) 목표 3개 학과 행을 여기 하드코딩한다.
PDF의 '기준 시각'이 바뀔 때마다(=한 회차 갱신될 때마다) 이 rows를 다시 채워 넣고 실행한다.
"""
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

KST = timezone(timedelta(hours=9))
BASE = Path(__file__).resolve().parent
OUT_DIR = BASE / "db_docs"
PREV_DIR = BASE / "db_docs_prev" / "trend"
OUT_DIR.mkdir(exist_ok=True)

# ---- 여기만 회차마다 갱신 ----
PDF_AS_OF = "2026-09-07T14:30:00+09:00"  # PDF 우측 상단 "OOOO 기준" 시각
ROWS = [
    {"admission_type": "학생부종합(지역균형전형)", "college": "공과대학", "department": "산업공학과", "capacity": 4, "applied": 0, "ratio": 0.0},
    {"admission_type": "학생부종합/실기위주전형(일반전형)", "college": "공과대학", "department": "산업공학과", "capacity": 18, "applied": 19, "ratio": 1.06},
    {"admission_type": "학생부종합(지역균형전형)", "college": "공과대학", "department": "컴퓨터공학부", "capacity": 9, "applied": 1, "ratio": 0.11},
    {"admission_type": "학생부종합/실기위주전형(일반전형)", "college": "공과대학", "department": "컴퓨터공학부", "capacity": 36, "applied": 12, "ratio": 0.33},
    {"admission_type": "학생부종합(지역균형전형)", "college": "학부대학", "department": "첨단융합학부", "capacity": 30, "applied": 6, "ratio": 0.20},
    {"admission_type": "학생부종합/실기위주전형(일반전형)", "college": "학부대학", "department": "첨단융합학부", "capacity": 98, "applied": 28, "ratio": 0.29},
    {"admission_type": "기회균형특별전형(사회통합)", "college": "공과대학", "department": "산업공학과", "capacity": 2, "applied": 0, "ratio": 0.0},
    {"admission_type": "기회균형특별전형(사회통합)", "college": "공과대학", "department": "컴퓨터공학부", "capacity": 4, "applied": 4, "ratio": 1.0},
    {"admission_type": "기회균형특별전형(사회통합)", "college": "학부대학", "department": "첨단융합학부", "capacity": 20, "applied": 9, "ratio": 0.45},
]
# ---------------------------

collected_at = datetime.now(KST).isoformat()

latest_doc = {
    "key": "seoul",
    "name": "서울대학교",
    "url": "https://www.snu.ac.kr/webdata/admission/files/2027S_SNUrate.pdf",
    "ok": True,
    "open_before": False,
    "collected_at": collected_at,
    "apply_from": "2026-09-07T10:00:00+09:00",
    "apply_to": "2026-09-09T18:00:00+09:00",
    "highlight_type": [],
    "rows": ROWS,
    "note": f"자체 PDF({PDF_AS_OF} 기준) 게시분. 관심 3개 학과(산업공학과·컴퓨터공학부·첨단융합학부)만 수록 — 대학 전체 모집단위가 아님. 10분/30분 실시간이 아니라 대학이 지정한 시각에만 갱신됨.",
    "manual_check_required": False,
    "pdf_as_of": PDF_AS_OF,
}
(OUT_DIR / "latest_seoul.json").write_text(json.dumps(latest_doc, ensure_ascii=False), encoding="utf-8")

# trend: 학과 단위로 직접 합계(전형 합산 대신 학과별로 봐야 의미 있음 -> department 를 key처럼 사용)
by_dept = {}
for r in ROWS:
    d = r["department"]
    agg = by_dept.setdefault(d, {"capacity": 0, "applied": 0})
    agg["capacity"] += r["capacity"] or 0
    agg["applied"] += r["applied"] or 0
by_type = {}
for d, a in by_dept.items():
    cap, applied = a["capacity"], a["applied"]
    by_type[d] = {"capacity": cap, "applied": applied, "ratio": round(applied / cap, 3) if cap else None}

prev_path = PREV_DIR / "seoul.json"
existing = None
if prev_path.exists():
    try:
        existing = json.loads(prev_path.read_text(encoding="utf-8"))
    except Exception:
        existing = None

history = list(existing.get("history", [])) if existing else []
if history and history[-1].get("t") == PDF_AS_OF:
    history = history[:-1]
history.append({"t": PDF_AS_OF, "by_type": by_type})
history = history[-300:]

trend_doc = {"key": "seoul", "name": "서울대학교", "highlight_type": [], "history": history}
(OUT_DIR / "trend_seoul.json").write_text(json.dumps(trend_doc, ensure_ascii=False), encoding="utf-8")

print("wrote latest_seoul.json and trend_seoul.json; history points:", len(history))
