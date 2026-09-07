// episode.js — ZPD 에피소드 추적 및 진입점 적응

var CHAIN = {
  nostart:      { len: 2, L: ["L1","L2"] },
  comprehension:{ len: 3, L: ["L7","L3","L0"] },
  transform:    { len: 4, L: ["L3","L4","L3p","L8"] },
  process:      { len: 3, L: ["L6a","L6b","L6c"] },
  encoding:     { len: 2, L: ["L6","L7"] },
  prerequisite: { len: 2, L: ["L2","L9"] },
};

function _pid() {
  try { return localStorage.getItem("coach.pid") || "default"; } catch(e) { return "default"; }
}

function _key(k) {
  return k + "." + _pid();
}

function loadSelfReport() {
  try { return JSON.parse(localStorage.getItem(_key("coach.selfreport")) || "[]"); } catch(e) { return []; }
}

function savePid(pid) {
  try { localStorage.setItem("coach.pid", String(pid)); } catch(e) {}
}

function saveSelfReport(techs) {
  try { localStorage.setItem(_key("coach.selfreport"), JSON.stringify(techs)); } catch(e) {}
}

function chainOf(stage, prereq) {
  if (prereq === "missing") return "prerequisite";
  return (stage && CHAIN[stage]) ? stage : "nostart";
}

function _loadEntry() {
  try { return JSON.parse(localStorage.getItem(_key("coach.entry")) || "{}"); } catch(e) { return {}; }
}

function _saveEntry(e) {
  try { localStorage.setItem(_key("coach.entry"), JSON.stringify(e)); } catch(e) {}
}

function _loadStage() {
  try { return JSON.parse(localStorage.getItem(_key("coach.stage")) || "{}"); } catch(e) { return {}; }
}

function _saveStage(s) {
  try { localStorage.setItem(_key("coach.stage"), JSON.stringify(s)); } catch(e) {}
}

function _loadLog() {
  try { return JSON.parse(localStorage.getItem(_key("coach.zpd")) || "[]"); } catch(e) { return []; }
}

function _saveLog(log) {
  try { localStorage.setItem(_key("coach.zpd"), JSON.stringify(log.slice(-500))); } catch(e) {}
}

var _currentTech = "basic";

function entryFor(chain) {
  var entries = _loadEntry();
  var stage   = _loadStage();
  var maxEntry = ((CHAIN[chain] || { len: 3 }).len) - 1;

  if (entries[chain] != null) {
    var val = Math.max(1, Math.min(entries[chain], maxEntry));
    // 회귀(stage===1)로 재진입하면 +1 가산
    if (stage[_currentTech] === 1 && val < maxEntry) val = Math.min(val + 1, maxEntry);
    return val;
  }
  return 1;
}

function loadEntries() {
  return _loadEntry();
}

function openEpisode(tech, chain, entry) {
  _currentTech = tech || "basic";
  return {
    pid: _pid(), tech: tech, chain: chain, entry: entry,
    used: entry, consumed: 0,
    resolved: false,
    answerRequested: 0, blindRequests: 0,
    verify: "na",
    t: Date.now(),
  };
}

function closeEpisode(rec) {
  var r = {};
  var k;
  for (k in rec) { if (Object.prototype.hasOwnProperty.call(rec, k)) r[k] = rec[k]; }
  r.consumed = Math.max(0, (r.used || r.entry || 1) - (r.entry || 1) + 1);
  r.t = r.t || Date.now();

  // 기법 상태 갱신
  var stage = _loadStage();
  if (r.resolved) {
    stage[r.tech] = Math.min((stage[r.tech] || 0) + 1, 3);
  } else if (stage[r.tech] === 3) {
    stage[r.tech] = 1;  // 회귀
  }
  _saveStage(stage);

  // 진입점 갱신
  var entries = _loadEntry();
  var chain = r.chain || "nostart";
  var maxEntry = ((CHAIN[chain] || { len: 3 }).len) - 1;

  if (r.resolved && r.consumed <= 1) {
    entries[chain] = Math.min((entries[chain] || 1) + 1, maxEntry);
  } else if (!r.resolved) {
    entries[chain] = Math.max((entries[chain] || 1) - 1, 1);
  }
  _saveEntry(entries);

  // 로그 적재
  var log = _loadLog();
  log.push(r);
  _saveLog(log);

  return r;
}

function loadEpisodes() {
  return _loadLog();
}

function exportEpisodesCSV() {
  var log = _loadLog();
  if (!log.length) {
    try { alert("내보낼 에피소드 데이터가 없어요."); } catch(e) {}
    return;
  }
  var cols = ["pid","tech","chain","entry","used","consumed","resolved",
              "answerRequested","blindRequests","verify","t"];
  var header = cols.join(",");
  var rows = log.map(function(r) {
    return cols.map(function(c) {
      var v = r[c];
      if (v == null) return "";
      var s = String(v);
      return s.indexOf(",") >= 0 ? '"' + s + '"' : s;
    }).join(",");
  });
  var csv = [header].concat(rows).join("\n");
  try {
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "zpd_episodes_" + _pid() + "_" + Date.now() + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  } catch(e) {
    alert("다운로드 중 오류가 발생했어요: " + e.message);
  }
}
