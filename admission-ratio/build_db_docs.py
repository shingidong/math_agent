#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""최신 snapshot JSON -> Artifact DB에 넣을 문서(JSON 파일) 생성.

collection "latest/{key}"  : 이번 회차 학과별 상세 표 (테이블 렌더링용)
collection "trend/{key}"   : 전형별 합계 시계열 누적 (추세 차트용, 최근 N개만 유지)
"""
import glob
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data"
OUT_DIR = BASE / "db_docs"
OUT_DIR.mkdir(exist_ok=True)
# 매 회차 write_db 전에 Artifact read_db(action=list, collection=trend,
# out_dir=PREV_DIR)로 직전 trend 문서를 이 폴더에 받아두면, 그걸 이어서 누적한다.
# 없으면(최초 1회) 이번 회차 데이터만으로 새로 시작한다.
PREV_DIR = BASE / "db_docs_prev" / "trend"

MAX_HISTORY = 300  # 문서 256KiB 제한 안에서 넉넉히 유지 (약 50시간치, 10분 간격)

HIGHLIGHT = {
    "seoul": [],
    "yonsei": ["학생부종합전형 (활동우수형)"],
    "korea": ["서울캠퍼스 학생부종합(학업우수전형)", "서울캠퍼스 학생부종합(계열적합전형)"],
    "sogang": [],
    "skku": [],
    "hanyang": [],
}


def load_latest_snapshot():
    files = sorted(glob.glob(str(DATA_DIR / "snapshot_*.json")))
    if not files:
        raise SystemExit("no snapshot files found - run scrape_ratios.py first")
    return json.loads(Path(files[-1]).read_text(encoding="utf-8"))


def summarize_by_type(rows):
    """전형별 총 모집인원/지원인원/경쟁률 집계."""
    agg = {}
    for r in rows:
        t = r["admission_type"]
        a = agg.setdefault(t, {"capacity": 0, "applied": 0})
        if r.get("capacity"):
            a["capacity"] += r["capacity"]
        if r.get("applied") is not None:
            a["applied"] += r["applied"]
    out = {}
    for t, a in agg.items():
        cap = a["capacity"]
        applied = a["applied"]
        out[t] = {
            "capacity": cap,
            "applied": applied,
            "ratio": round(applied / cap, 3) if cap else None,
        }
    return out


def load_prev_trend(key: str) -> dict | None:
    p = PREV_DIR / f"{key}.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return None
    return None


def merge_trend(existing: dict | None, key: str, name: str, collected_at: str, by_type: dict) -> dict:
    history = list(existing.get("history", [])) if existing else []
    if history and history[-1].get("t") == collected_at:
        history = history[:-1]  # 같은 회차 재실행 시 중복 시점 방지
    history.append({"t": collected_at, "by_type": by_type})
    history = history[-MAX_HISTORY:]
    return {"key": key, "name": name, "highlight_type": HIGHLIGHT.get(key), "history": history}


def main():
    snap = load_latest_snapshot()
    collected_at = snap["collected_at"]

    for src in snap["sources"]:
        key = src["key"]
        name = src["name"]
        rows = src.get("rows", [])

        latest_doc = {
            "key": key,
            "name": name,
            "url": src.get("url"),
            "ok": src.get("ok", False),
            "open_before": src.get("open_before"),
            "collected_at": collected_at,
            "apply_from": src.get("apply_from"),
            "apply_to": src.get("apply_to"),
            "highlight_type": HIGHLIGHT.get(key),
            "rows": rows,
            "note": src.get("note"),
            "manual_check_required": src.get("manual_check_required", False),
        }
        (OUT_DIR / f"latest_{key}.json").write_text(
            json.dumps(latest_doc, ensure_ascii=False), encoding="utf-8"
        )

        by_type = summarize_by_type(rows)
        prev = load_prev_trend(key)
        trend_doc = merge_trend(prev, key, name, collected_at, by_type)
        (OUT_DIR / f"trend_{key}.json").write_text(
            json.dumps(trend_doc, ensure_ascii=False), encoding="utf-8"
        )

        size_kb = len(json.dumps(latest_doc, ensure_ascii=False).encode("utf-8")) / 1024
        print(f"{key}: rows={len(rows)} latest_size={size_kb:.1f}KB")


if __name__ == "__main__":
    main()
