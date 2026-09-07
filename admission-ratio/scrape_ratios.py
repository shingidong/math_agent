#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
2027학년도 수시모집 실시간 경쟁률 수집기.

대상: 서울대, 연세대(서울), 고려대(안암), 서강대, 성균관대, 한양대(서울)

데이터 출처:
- 진학어플라이(jinhakapply) 및 유웨이어플라이(uwayapply)가 각 대학에 제공하는
  "경쟁률 서비스" 페이지(addon.jinhakapply.com / ratio.uwayapply.com)는 서버에서
  완전히 렌더링된 정적 HTML을 반환하므로 단순 HTTP GET + HTML 파싱으로 수집 가능.
- 서울대는 위 두 업체를 통하지 않고 자체 PDF(관리부서 게시)로 지원 현황을 제공하며,
  10분 단위가 아니라 하루 중 정해진 시각에만 갱신된다. PDF에 텍스트 레이어가 없어
  (한글 폰트 임베딩 문제로 pdftotext가 값을 제대로 못 읽음) 실패 시 원문 PDF 링크만
  기록해두고, 사람이 직접 확인하거나 비전 모델로 다시 읽어야 한다.

실행: python3 scrape_ratios.py
출력: data/snapshot_<timestamp>.json (이번 회차 원본) + data/history.jsonl (누적 요약)
"""
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

from bs4 import BeautifulSoup

KST = timezone(timedelta(hours=9))
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

UA = "Mozilla/5.0 (compatible; AdmissionRatioTracker/1.0)"

# 사전 확인된 2027학년도 수시 "경쟁률 서비스" 링크.
# 진학어플라이 스마트경쟁률(https://apply.jinhakapply.com/SmartRatio) 페이지의
# 숨은 input#hdnResultNow JSON(RatioLink 컬럼)에서 추출한 값으로, 원서접수 기간
# 내내 고정된다. 매 회차 재수집할 필요 없이 아래처럼 고정해두고 쓰면 된다.
SOURCES = [
    {
        "key": "seoul",
        "name": "서울대학교",
        "type": "snu_pdf",
        "url": "https://www.snu.ac.kr/webdata/admission/files/2027S_SNUrate.pdf",
        "note": "10분 단위 실시간 아님. 대학이 지정한 시각에만 PDF로 게시.",
        "target_depts": ["산업공학과", "컴퓨터공학부", "첨단융합학부"],
        "apply_from": "2026-09-07T10:00:00+09:00",
        "apply_to": "2026-09-09T18:00:00+09:00",
    },
    {
        "key": "yonsei",
        "name": "연세대학교(서울)",
        "type": "jinhak_addon",
        "url": "https://addon.jinhakapply.com/RatioV1/RatioH/Ratio11080811.html",
        "encoding": "utf-8",
        "highlight_type": ["학생부종합전형 (활동우수형)"],
        "apply_from": "2026-09-07T10:00:00+09:00",
        "apply_to": "2026-09-09T17:00:00+09:00",
    },
    {
        "key": "korea",
        "name": "고려대학교(안암)",
        "type": "uway_ratio",
        "url": "https://ratio.uwayapply.com/Sl5KOGB9YTlKZiUmOiZKN2ZUZg==",
        "encoding": "euc-kr",
        "highlight_type": ["서울캠퍼스 학생부종합(학업우수전형)", "서울캠퍼스 학생부종합(계열적합전형)"],
        "apply_from": "2026-09-07T10:00:00+09:00",
        "apply_to": "2026-09-09T17:00:00+09:00",
    },
    {
        "key": "sogang",
        "name": "서강대학교",
        "type": "jinhak_addon",
        "url": "https://addon.jinhakapply.com/RatioV1/RatioH/Ratio12050481.html",
        "encoding": "utf-8",
        "highlight_type": [],
        "apply_from": "2026-09-08T10:00:00+09:00",
        "apply_to": "2026-09-11T18:00:00+09:00",
    },
    {
        "key": "skku",
        "name": "성균관대학교",
        "type": "jinhak_addon",
        "url": "https://addon.jinhakapply.com/RatioV1/RatioH/Ratio10920591.html",
        "encoding": "utf-8",
        "highlight_type": [],
        "apply_from": "2026-09-08T10:00:00+09:00",
        "apply_to": "2026-09-11T18:00:00+09:00",
    },
    {
        "key": "hanyang",
        "name": "한양대학교(서울)",
        "type": "jinhak_addon",
        "url": "https://addon.jinhakapply.com/RatioV1/RatioH/Ratio11640591.html",
        "encoding": "utf-8",
        "highlight_type": [],
        "apply_from": "2026-09-08T10:00:00+09:00",
        "apply_to": "2026-09-11T18:00:00+09:00",
    },
]


def fetch(url: str, encoding: str | None = None, timeout: int = 20, retries: int = 3) -> str:
    last_exc = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return raw.decode(encoding or "utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            time.sleep(1.5 * (attempt + 1))
    raise last_exc


def parse_ratio_number(text: str):
    """'12.34 : 1' -> 12.34, '0.00 : 1' -> 0.0, 미제공/빈값 -> None"""
    m = re.search(r"([\d,]+(?:\.\d+)?)\s*:\s*1", text)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None


def parse_int(text: str):
    text = text.strip().replace(",", "")
    m = re.search(r"\d+", text)
    return int(m.group()) if m else None


def parse_html_ratio_page(html: str) -> dict:
    """jinhak addon / uway ratio 공통 HTML 구조 파서.

    각 '전형명' 헤딩 다음에 오는 표(대학/모집단위/[학과소개]/모집인원/지원인원/경쟁률)를
    순서대로 훑는다. 두 업체 모두 서버 렌더링 정적 HTML이라 동일 로직으로 처리 가능.
    """
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")

    open_before = "오픈전" in soup.get_text()

    rows_out = []
    for tb in tables:
        trs = tb.find_all("tr")
        if not trs:
            continue
        header_cells = [c.get_text(strip=True) for c in trs[0].find_all(["th", "td"])]
        if "모집단위" not in header_cells:
            continue  # 요약 표(전체/전형별 합계)는 건너뛰고 상세 표만 사용

        heading_el = tb.find_previous(["h1", "h2", "h3", "h4", "h5", "strong", "p", "div", "span"])
        admission_type = heading_el.get_text(strip=True) if heading_el else "미상"
        admission_type = re.sub(r"\s*경쟁률\s*현황\s*$", "", admission_type).strip()

        idx = {name: i for i, name in enumerate(header_cells)}
        college_i = idx.get("대학")
        dept_i = idx.get("모집단위")
        cap_i = idx.get("모집인원")
        applied_i = idx.get("지원인원")
        ratio_i = idx.get("경쟁률")
        ncols = len(header_cells)

        current_college = ""
        for tr in trs[1:]:
            cells = [c.get_text(strip=True) for c in tr.find_all(["th", "td"])]
            if not cells or len(cells) < 3:
                continue
            joined = "".join(cells)
            if joined.startswith("소계") or joined.startswith("총계"):
                continue

            # '대학' 칸은 rowspan으로 여러 학과에 걸쳐 병합되어 있어, 같은 대학이
            # 이어지는 행은 그 <td> 자체가 생략되어 전체 칸 수가 하나 줄어든다.
            # 왼쪽에 빈 칸을 채워 넣어 헤더 인덱스와 다시 맞춘다.
            missing = max(0, ncols - len(cells))
            if missing:
                cells = [""] * missing + cells

            def get(i):
                return cells[i] if i is not None and i < len(cells) else ""

            college = get(college_i)
            if college:
                current_college = college
            dept = get(dept_i)
            if not dept:
                continue
            cap_raw = get(cap_i)
            applied_raw = get(applied_i)
            ratio_raw = get(ratio_i)

            rows_out.append(
                {
                    "admission_type": admission_type,
                    "college": current_college,
                    "department": dept,
                    "capacity_raw": cap_raw,
                    "capacity": parse_int(cap_raw),
                    "applied": parse_int(applied_raw),
                    "ratio": parse_ratio_number(ratio_raw),
                }
            )

    return {"open_before": open_before, "rows": rows_out}


def scrape_source(src: dict) -> dict:
    result = {
        "key": src["key"],
        "name": src["name"],
        "url": src["url"],
        "apply_from": src.get("apply_from"),
        "apply_to": src.get("apply_to"),
        "highlight_type": src.get("highlight_type"),
        "fetched_at": datetime.now(KST).isoformat(),
        "ok": False,
    }
    try:
        if src["type"] in ("jinhak_addon", "uway_ratio"):
            html = fetch(src["url"], encoding=src.get("encoding"))
            parsed = parse_html_ratio_page(html)
            result.update(parsed)
            result["ok"] = True
        elif src["type"] == "snu_pdf":
            result["note"] = src["note"]
            result["target_depts"] = src["target_depts"]
            result["ok"] = False
            result["manual_check_required"] = True
            result["rows"] = []
        else:
            result["error"] = f"unknown source type: {src['type']}"
    except Exception as exc:  # noqa: BLE001
        result["error"] = str(exc)
    return result


def main():
    ts = datetime.now(KST)
    ts_str = ts.strftime("%Y%m%dT%H%M%S")

    snapshot = {"collected_at": ts.isoformat(), "sources": []}
    for src in SOURCES:
        print(f"[{ts_str}] fetching {src['name']} ...", file=sys.stderr)
        r = scrape_source(src)
        snapshot["sources"].append(r)
        n = len(r.get("rows", []))
        print(f"  -> ok={r['ok']} rows={n} {r.get('error', '')}", file=sys.stderr)

    out_path = DATA_DIR / f"snapshot_{ts_str}.json"
    out_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

    # 누적 이력(한 줄 = 한 회차, 대시보드 트렌드 계산용 요약만 저장)
    history_path = DATA_DIR / "history.jsonl"
    summary = {
        "collected_at": snapshot["collected_at"],
        "sources": [
            {
                "key": s["key"],
                "ok": s["ok"],
                "open_before": s.get("open_before"),
                "rows": s.get("rows", []),
            }
            for s in snapshot["sources"]
        ],
    }
    with history_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")

    print(f"saved: {out_path}")
    return snapshot


if __name__ == "__main__":
    main()
