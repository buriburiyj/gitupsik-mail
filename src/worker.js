// ===================================================================
//  설정: NEIS_KEY / RESEND_KEY / ADMIN_PW는 코드가 아니라
//  Cloudflare Worker의 "Variables and secrets"(wrangler secret put)에 등록해서 씀.
// ===================================================================
const NEIS_BASE = "https://open.neis.go.kr/hub";

// ===== NEIS 응답 캐시 (KV: NEIS_CACHE) =====
// 키에 버전을 박아둬서, 파싱 형식이 바뀌면 CACHE_VER만 올려 전체 무효화한다.
const CACHE_VER = "v1";

// 지난 날짜 데이터는 더 안 바뀌니 길게, 오늘·미래는 학교가 수정할 수 있어 짧게.
function ttlForDate(ymd) {
  const t = todayStr();
  if (!ymd) return 60 * 60 * 2;
  if (ymd < t) return 60 * 60 * 24 * 30;
  if (ymd === t) return 60 * 60 * 2;
  return 60 * 60 * 4;
}

// 주말·미등록·NEIS 일시장애로 빈 값이 온 걸 오래 붙잡지 않는다.
function isEmptyResult(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return String(v).trim() === "";
}

async function neisCached(env, key, ttl, fn) {
  const kv = env && env.NEIS_CACHE;
  if (!kv) return fn();  // 바인딩이 없어도 기능은 그대로 동작
  const full = `neis:${CACHE_VER}:${key}`;
  try {
    const hit = await kv.get(full);
    if (hit !== null) return JSON.parse(hit).v;
  } catch (e) {}
  const val = await fn();
  try {
    await kv.put(full, JSON.stringify({ v: val }), {
      expirationTtl: isEmptyResult(val) ? 600 : ttl
    });
  } catch (e) {}
  return val;
}

// 아래 네 개는 기존 함수와 시그니처가 같다. 호출부는 그대로 두고 캐시만 끼운다.
async function getSchedules(officeCode, schoolCode, env, from, to, grade) {
  return neisCached(env, `sched:${officeCode}:${schoolCode}:${from}:${to}:${grade || "all"}`,
    60 * 60 * 24, () => getSchedulesRaw(officeCode, schoolCode, env, from, to, grade));
}

async function getMealRange(officeCode, schoolCode, env, from, to) {
  return neisCached(env, `mealrange:${officeCode}:${schoolCode}:${from}:${to}`,
    ttlForDate(to), () => getMealRangeRaw(officeCode, schoolCode, env, from, to));
}

async function getMeal(officeCode, schoolCode, env, date) {
  const d = date || todayStr();
  return neisCached(env, `meal:${officeCode}:${schoolCode}:${d}`,
    ttlForDate(d), () => getMealRaw(officeCode, schoolCode, env, d));
}

async function getTimetable(officeCode, schoolCode, grade, classNm, env, date) {
  const d = date || todayStr();
  return neisCached(env, `tt:${officeCode}:${schoolCode}:${grade || "-"}:${classNm || "-"}:${d}`,
    ttlForDate(d), () => getTimetableRaw(officeCode, schoolCode, grade, classNm, env, d));
}
const WORKER_URL = "https://gitupsik-mail.buriburiyejun.workers.dev";
const FRONTEND_URL = "https://today-meal.buriburiyejun.workers.dev";
const LOGIN_TOKEN_TTL = 600;    // 로그인 링크 토큰: 10분
const SESSION_TTL = 604800;     // 로그인 세션: 7일

const CHEERS = [
  "오늘도 니 페이스대로, 화이팅! 🔥",
  "작은 한 걸음도 어제보다 앞이야. 👍",
  "밥 잘 챙겨 먹고 오늘도 무사히! 🍚",
  "완벽하지 않아도 괜찮아. 그냥 하면 돼.",
  "오늘 하루도 니 편이야. 잘 다녀와! 🌱",
  "지치면 쉬어도 돼. 근데 포기는 말고.",
  "어제의 너보다 딱 1%만 더. 그거면 충분해.",
  "좋은 하루는 좋은 아침에서 시작! ☀️"
];

// ===== 날짜 (한국시간) =====
function kstNow() { return new Date(Date.now() + 9 * 60 * 60 * 1000); }
function todayStr() {
  const d = kstNow();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}
// D1 저장용: todayStr()과 달리 구분자(-)가 있는 YYYY-MM-DD
function kstDateStr() {
  const d = kstNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function dateKorean() {
  const d = kstNow();
  const days = ['일','월','화','수','목','금','토'];
  return `${d.getUTCMonth()+1}월 ${d.getUTCDate()}일 (${days[d.getUTCDay()]})`;
}
function todayDow() { return kstNow().getUTCDay(); }

function makeToken() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// 로그인/세션 토큰용: 예측 불가능한 암호학적 난수 (makeToken()과 달리 위조되면 안 되는 값에 사용)
function secureToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// 간단한 안내 문구를 보여주는 HTML 페이지 (예: /verify, /login/verify 결과 화면)
function htmlWrap(inner) {
  return `<div style="font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;text-align:center;margin-top:60px;padding:0 20px">${inner}</div>`;
}

// ===== 급식 =====
// ===== 달력용: 한 달치 학사일정 =====
const GRADE_YN = { "1":"ONE_GRADE_EVENT_YN", "2":"TW_GRADE_EVENT_YN", "3":"THREE_GRADE_EVENT_YN",
                   "4":"FR_GRADE_EVENT_YN", "5":"FIV_GRADE_EVENT_YN", "6":"SIX_GRADE_EVENT_YN" };

async function getSchedulesRaw(officeCode, schoolCode, env, from, to, grade) {
  const url = `${NEIS_BASE}/SchoolSchedule?KEY=${env.NEIS_KEY}&Type=json&pSize=500` +
    `&ATPT_OFCDC_SC_CODE=${officeCode}&SD_SCHUL_CODE=${schoolCode}` +
    `&AA_FROM_YMD=${from}&AA_TO_YMD=${to}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const rows = data.SchoolSchedule?.[1]?.row;
    if (!rows) return [];
    const key = GRADE_YN[String(grade)];
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      // 학년이 지정되면 그 학년 일정만 남긴다.
      if (key && r[key] === "N") continue;
      const name = (r.EVENT_NM || "").trim();
      if (!name) continue;
      const dedup = r.AA_YMD + "|" + name;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      out.push({ date: r.AA_YMD, name, kind: r.SBTR_DD_SC_NM || null });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  } catch (e) { return []; }
}

// ===== 달력용: 한 달치 급식 (날짜별 메뉴만, 응답 크기를 줄인다) =====
async function getMealRangeRaw(officeCode, schoolCode, env, from, to) {
  const url = `${NEIS_BASE}/mealServiceDietInfo?KEY=${env.NEIS_KEY}&Type=json&pSize=500` +
    `&ATPT_OFCDC_SC_CODE=${officeCode}&SD_SCHUL_CODE=${schoolCode}` +
    `&MLSV_FROM_YMD=${from}&MLSV_TO_YMD=${to}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const rows = data.mealServiceDietInfo?.[1]?.row;
    if (!rows) return {};
    const map = {};
    for (const m of rows) {
      const menu = (m.DDISH_NM || "").replace(/<br\/?>/g, "<br>").replace(/\([0-9.]+\)/g, "").trim();
      if (!menu) continue;
      map[m.MLSV_YMD] = map[m.MLSV_YMD] ? map[m.MLSV_YMD] + "<br><br>" + menu : menu;
    }
    return map;
  } catch (e) { return {}; }
}

// YYYYMM -> 그 달의 1일/말일
function monthRange(ym) {
  if (!/^\d{6}$/.test(ym)) return null;
  const y = +ym.slice(0, 4), m = +ym.slice(4, 6);
  if (y < 2000 || y > 2100 || m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}01`, to: `${ym}${String(last).padStart(2, "0")}` };
}

// 사용자 입력 날짜는 반드시 검증해서 NEIS URL에 넣는다. 형식이 틀리면 null(=오늘).
function safeDate(v) {
  if (!v || !/^\d{8}$/.test(v)) return null;
  const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return v;
}

async function getMealRaw(officeCode, schoolCode, env, date) {
  const url = `${NEIS_BASE}/mealServiceDietInfo?KEY=${env.NEIS_KEY}&Type=json&ATPT_OFCDC_SC_CODE=${officeCode}&SD_SCHUL_CODE=${schoolCode}&MLSV_YMD=${date || todayStr()}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const rows = data.mealServiceDietInfo?.[1]?.row;
    if (!rows) return null;
    return rows.map(m => {
      const menu = m.DDISH_NM.replace(/<br\/?>/g, '<br>').replace(/\([0-9.]+\)/g, '').trim();
      return `<b>${m.MMEAL_SC_NM}</b><br>${menu}`;
    }).join('<br><br>');
  } catch (e) { return null; }
}

// ===== 시간표 (학년·반 지정) =====
async function getTimetableRaw(officeCode, schoolCode, grade, classNm, env, date) {
  const endpoints = ['elsTimetable', 'misTimetable', 'hisTimetable'];
  for (const ep of endpoints) {
    let url = `${NEIS_BASE}/${ep}?KEY=${env.NEIS_KEY}&Type=json&ATPT_OFCDC_SC_CODE=${officeCode}&SD_SCHUL_CODE=${schoolCode}&ALL_TI_YMD=${date || todayStr()}`;
    if (grade) url += `&GRADE=${grade}`;
    if (classNm) url += `&CLASS_NM=${classNm}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      const rows = data[ep]?.[1]?.row;
      if (rows) {
        // NEIS가 교시만 주고 과목명을 null로 보내는 날(주말·휴일)이 있다.
        const valid = rows.filter(t => t.ITRT_CNTNT && String(t.ITRT_CNTNT).trim() && String(t.ITRT_CNTNT) !== "null");
        if (!valid.length) return null;
        valid.sort((a, b) => (+a.PERIO) - (+b.PERIO));
        return valid.map(t => `${t.PERIO}교시 · ${t.ITRT_CNTNT}`).join('<br>');
      }
    } catch (e) {}
  }
  return null;
}

// ===== 날씨 =====
async function getWeather(lat, lon) {
  if (!lat || !lon) return null;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&past_days=1&forecast_days=1`;
  try {
    const res = await fetch(url);
    const d = await res.json();
    const cur = d.current, day = d.daily, code = cur.weather_code;
    const todayMax = Math.round(day.temperature_2m_max[1]);
    const todayMin = Math.round(day.temperature_2m_min[1]);
    const yesterdayMax = Math.round(day.temperature_2m_max[0]);
    const rainProb = day.precipitation_probability_max[1];
    const diff = todayMax - yesterdayMax;
    let compare;
    if (diff >= 3) compare = `어제보다 ${diff}도 따뜻해요 🌡️`;
    else if (diff <= -3) compare = `어제보다 ${Math.abs(diff)}도 추워요 🧊`;
    else compare = "어제랑 비슷한 날씨예요";
    const hourly = [];
    if (d.hourly && d.hourly.time) {
      const now = kstNow();
      const nowKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')}T${String(now.getUTCHours()).padStart(2,'0')}:00`;
      let startIdx = d.hourly.time.findIndex(t => t >= nowKey);
      if (startIdx < 0) startIdx = 0;
      for (let i = startIdx; i < startIdx + 9 && i < d.hourly.time.length; i++) {
        const h = parseInt(d.hourly.time[i].slice(11, 13));
        hourly.push({ hour: h, temp: Math.round(d.hourly.temperature_2m[i]), emoji: weatherEmoji(d.hourly.weather_code[i]) });
      }
    }
    return {
      now: Math.round(cur.temperature_2m),
      max: todayMax, min: todayMin,
      desc: weatherDesc(code), emoji: weatherEmoji(code), rainProb,
      umbrella: rainProb >= 50 ? "☔ 우산 챙겨!" : "우산은 안 챙겨도 될 듯",
      compare, outfit: getOutfit(todayMax), hourly
    };
  } catch (e) { return null; }
}
function weatherDesc(c){if(c===0)return"맑음";if(c<=2)return"구름 조금";if(c===3)return"흐림";if(c<=48)return"안개";if(c<=67)return"비";if(c<=77)return"눈";if(c<=82)return"소나기";return"궂은 날씨";}
function weatherEmoji(c){if(c===0)return"☀️";if(c<=2)return"🌤️";if(c===3)return"☁️";if(c<=48)return"🌫️";if(c<=67)return"🌧️";if(c<=77)return"❄️";if(c<=82)return"🌦️";return"🌩️";}

function getOutfit(temp) {
  if (temp >= 28) return "👕 반팔·반바지·민소매 (더워요!)";
  if (temp >= 23) return "👕 반팔·얇은 셔츠";
  if (temp >= 20) return "👔 얇은 긴팔·가디건";
  if (temp >= 17) return "🧥 얇은 니트·맨투맨";
  if (temp >= 12) return "🧥 자켓·가디건·긴바지";
  if (temp >= 9)  return "🧥 트렌치코트·야상·니트";
  if (temp >= 5)  return "🧥 코트·히트텍·니트";
  return "🧥 패딩·두꺼운 코트·목도리 (추워요!)";
}

// ===== 미세먼지 =====
async function getAir(lat, lon) {
  if (!lat || !lon) return null;
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm10,pm2_5&timezone=Asia%2FSeoul`;
  try {
    const res = await fetch(url);
    const d = await res.json();
    const pm10 = Math.round(d.current.pm10);
    const pm25 = Math.round(d.current.pm2_5);
    return { pm10, pm25, pm10Info: airLevel(pm10, [30, 80, 150]), pm25Info: airLevel(pm25, [15, 35, 75]) };
  } catch (e) { return null; }
}
function airLevel(v, [good, normal, bad]) {
  if (v <= good)   return { label: "좋음",     color: "#3b82f6", emoji: "😊" };
  if (v <= normal) return { label: "보통",     color: "#22c55e", emoji: "🙂" };
  if (v <= bad)    return { label: "나쁨",     color: "#f59e0b", emoji: "😷" };
  return                  { label: "매우나쁨", color: "#ef4444", emoji: "🤢" };
}

// ===== 오늘 학원 일정 =====
function buildAcademyHtml(academies) {
  if (!academies || !academies.length) return null;
  const dow = todayDow();
  const today = academies.filter(a => a.days && a.days.includes(dow));
  if (!today.length) return "오늘은 학원 일정이 없어요! 🎉";
  today.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  return today.map(a =>
    `<div style="display:flex;justify-content:space-between;padding:4px 0"><b>${a.name}</b><span style="color:#4f46e5;font-weight:700">${a.time || ""}</span></div>`
  ).join('');
}

// ===== 디데이 =====
function buildDdayHtml(ddays) {
  if (!ddays || !ddays.length) return null;
  const now = kstNow();
  const today0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const list = ddays.map(d => {
    const [y, m, day] = d.date.split('-').map(Number);
    const target = Date.UTC(y, m - 1, day);
    const diff = Math.round((target - today0) / 86400000);
    return { name: d.name, diff };
  }).filter(d => d.diff >= 0);  // 지난 건 제외
  if (!list.length) return null;
  list.sort((a, b) => a.diff - b.diff);
  return list.map(d => {
    const label = d.diff === 0 ? "D-DAY 🎉" : `D-${d.diff}`;
    return `<div style="display:flex;justify-content:space-between;padding:4px 0"><b>${d.name}</b><span style="color:#4f46e5;font-weight:700">${label}</span></div>`;
  }).join('');
}

// ===== HTML 메일 =====
function buildHtml(sub, weather, air, meal, timetable, cheer, rank) {
  const card = (title, inner) =>
    `<div style="background:#fff;border-radius:16px;padding:18px;margin-bottom:12px">` +
    `<div style="font-weight:800;color:#4f46e5;font-size:15px;margin-bottom:8px">${title}</div>` +
    `<div style="color:#334155;font-size:15px;line-height:1.8">${inner}</div></div>`;

  let weatherInner;
  if (weather) {
    let hourlyRow = "";
    if (weather.hourly && weather.hourly.length) {
      const cells = weather.hourly.map(h =>
        `<td style="text-align:center;padding:5px 7px">` +
        `<div style="color:#94a3b8;font-size:12px">${h.hour}시</div>` +
        `<div style="font-size:17px">${h.emoji}</div>` +
        `<div style="font-weight:700;color:#1e293b;font-size:14px">${h.temp}°</div></td>`).join("");
      hourlyRow = `<div style="overflow-x:auto;margin-top:12px"><table style="border-collapse:collapse"><tr>${cells}</tr></table></div>`;
    }
    weatherInner =
      `<div style="text-align:center">` +
      `<div style="font-size:48px;font-weight:800;color:#1e293b;line-height:1">${weather.now}°</div>` +
      `<div style="font-size:15px;color:#64748b;margin-top:4px">${weather.emoji} ${weather.desc}</div>` +
      `<div style="font-size:13px;color:#94a3b8">최고 ${weather.max}° / 최저 ${weather.min}°</div></div>` +
      `<div style="text-align:center;font-size:14px;color:#475569;margin:8px 0">${weather.compare}</div>` +
      `<div style="text-align:center;font-size:14px;color:#475569">☔ 강수확률 ${weather.rainProb}% · ${weather.umbrella}</div>` +
      `<div style="background:#f8fafc;border-radius:10px;padding:9px 12px;margin-top:10px;font-size:14px">👗 ${weather.outfit}</div>` +
      hourlyRow;
  } else {
    weatherInner = "날씨 정보를 못 가져왔어요.";
  }

  const badge = (name, v, info) =>
    `<div style="display:inline-block;background:${info.color};color:#fff;border-radius:12px;padding:11px 15px;margin:3px;text-align:center;min-width:105px">` +
    `<div style="font-size:12px">${name}</div>` +
    `<div style="font-size:17px;font-weight:800;margin:2px 0">${info.emoji} ${info.label}</div>` +
    `<div style="font-size:12px">${v} ㎍/㎥</div></div>`;
  const airInner = air
    ? `<div style="text-align:center">${badge("PM10", air.pm10, air.pm10Info)}${badge("PM2.5", air.pm25, air.pm25Info)}</div>`
    : "미세먼지 정보를 못 가져왔어요.";

  const academyInner = buildAcademyHtml(sub.academies);
  const unsubUrl = `${WORKER_URL}/unsubscribe?email=${encodeURIComponent(sub.email)}`;
  const gradeLabel = sub.grade ? ` · ${sub.grade}학년 ${sub.classNm}반` : "";
  const ddayInner = buildDdayHtml(sub.ddays);


    let rankInner = "";


    if (rank) {


      if (rank.myRank) {


        rankInner = `<div style="text-align:center"><span style="font-size:26px;font-weight:800;color:#1e293b">${rank.myRank}등</span> <span style="color:#f97316;font-weight:700">\u{1F525}${rank.myStreak}일</span></div>`;


        if (rank.top && !rank.isTopMe) rankInner += `<div style="text-align:center;color:#64748b;font-size:13px;margin-top:6px">1등 ${rank.top.display} \u{1F525}${rank.top.streak}일</div>`;


      } else {


        rankInner = "오늘 학습을 체크하면 랭킹에 올라가요!";


      }


    }



    return `<div style="background:#f1f5f9;padding:22px 14px;font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;max-width:480px;margin:0 auto">` +
    `<div style="text-align:center;margin-bottom:16px">` +
    `<div style="font-size:24px;font-weight:800;color:#1e293b">🌅 오늘의 아침 브리핑</div>` +
    `<div style="color:#64748b;font-size:14px;margin-top:4px">${dateKorean()} · ${sub.schoolName}${gradeLabel}</div></div>` +
    card("🌤️ 오늘 날씨", weatherInner) +
    card("🌫️ 오늘 미세먼지", airInner) +
    card("🍚 오늘 급식", meal || "오늘은 급식 정보가 없어요.<br>(주말·방학일 수 있어요)") +
    card("📅 오늘 시간표", timetable || "시간표 정보가 없어요.") +
    (academyInner ? card("🎒 오늘 학원", academyInner) : "") +
    (ddayInner ? card("🎯 디데이", ddayInner) : "") +
    (rankInner ? card("🏆 우리 학교 랭킹", rankInner) : "") +

    `<div style="text-align:center;background:#4f46e5;color:#fff;border-radius:16px;padding:16px;font-size:15px;font-weight:600">💬 ${cheer}</div>` +
    `<div style="text-align:center;margin-top:14px"><a href="${FRONTEND_URL}" style="display:inline-block;padding:13px 28px;background:#fff;color:#4f46e5;text-decoration:none;border-radius:12px;font-weight:800;font-size:15px;border:2px solid #4f46e5">🍚 오늘급식 앱 열기</a></div>` +
    `<div style="text-align:center;color:#94a3b8;font-size:11px;margin-top:14px">오늘급식 · <a href="${unsubUrl}" style="color:#94a3b8">구독 취소</a></div></div>`;
}
// ===== 한 명에게 보내기 =====
async function sendOne(sub, env, cache) {
  const [weather, air, meal, timetable] = await Promise.all([
    getWeather(sub.lat, sub.lon),
    getAir(sub.lat, sub.lon),
    getMeal(sub.officeCode, sub.schoolCode, env),
    getTimetable(sub.officeCode, sub.schoolCode, sub.grade, sub.classNm, env)
  ]);
  const cheer = CHEERS[Math.floor(Math.random() * CHEERS.length)];
  const rank = await rankInfoFor(env, sub, cache);
  const html = buildHtml(sub, weather, air, meal, timetable, cheer, rank);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "오늘급식 <onboarding@resend.dev>",
      to: sub.email,
      subject: `🌅 오늘의 아침 브리핑 (${dateKorean()})`,
      html
    })
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${body}` };
  return { ok: true, detail: body };
}

// 에러 본문에 요청 헤더가 그대로 섞여 나오는 경우가 있어, 저장 전에 토큰을 지우고 길이를 자른다.
function safeDetail(v) {
  if (v == null) return null;
  return String(v)
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer ***")
    .replace(/re_[A-Za-z0-9._\-]{8,}/g, "re_***")
    .slice(0, 300);
}

// 발송 결과를 한 번에 기록한다. 인원수만큼 개별 쓰기를 하면 D1 쓰기가 낭비된다.
async function writeMailLog(env, rows) {
  if (!rows.length || !env.DB) return;
  const now = Date.now();
  const date = kstDateStr();
  try {
    const stmt = env.DB.prepare(
      "INSERT INTO mail_log (date, email, status, detail, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    await env.DB.batch(rows.map(r =>
      stmt.bind(date, r.email, r.ok ? "ok" : "fail", r.ok ? null : safeDetail(r.detail), now)
    ));
  } catch (e) { /* 로그 실패가 메일 발송을 막지 않게 한다 */ }
}

async function sendMailToAll(env) {
  const rankCache = new Map();
  const list = await env.SUBS.list();
  const results = [];
  for (const key of list.keys) {
    const data = await env.SUBS.get(key.name);
    if (!data) continue;
    let sub = null;
    try {
      sub = JSON.parse(data);
      if (!sub.verified) continue;
      const r = await sendOne(sub, env, rankCache);
      results.push({ email: sub.email, ok: !!(r && r.ok), detail: r && r.detail });
    } catch (e) {
      // 예외를 삼키면 "메일이 안 왔다"를 추적할 수 없다.
      results.push({ email: (sub && sub.email) || key.name, ok: false, detail: String(e && e.message || e) });
    }
  }
  await writeMailLog(env, results);
  return results;
}

async function sendNoticeToAll(env, title, body) {
  const list = await env.SUBS.list();
  const html = `<div style="background:#f1f5f9;padding:24px 16px;font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;max-width:480px;margin:0 auto">
    <div style="background:#fff;border-radius:16px;padding:22px">
      <div style="font-size:20px;font-weight:800;color:#4f46e5;margin-bottom:12px">📢 ${title}</div>
      <div style="color:#334155;font-size:15px;line-height:1.8;white-space:pre-line">${body}</div>
    </div>
    <div style="text-align:center;color:#94a3b8;font-size:11px;margin-top:14px">오늘급식 공지</div>
  </div>`;
  let count = 0;
  for (const key of list.keys) {
    const data = await env.SUBS.get(key.name);
    if (!data) continue;
    const sub = JSON.parse(data);
    if (!sub.verified) continue;
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "오늘급식 <onboarding@resend.dev>", to: sub.email, subject: `📢 ${title}`, html })
      });
      count++;
    } catch (e) {}
  }
  return count;
}

function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
}

// 요청의 Authorization: Bearer <세션토큰> 헤더로 로그인한 사람의 email을 알아낸다.
// 클라이언트가 보낸 email 파라미터는 신뢰하지 않고, 세션 토큰으로만 신원을 판단한다.
async function getSessionEmail(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) return null;
  const data = await env.SUBS.get(`session:${match[1]}`);
  if (!data) return null;
  try { return JSON.parse(data).email; } catch (e) { return null; }
}

// 날짜 Set에서 연속 완료일(스트릭)을 계산.
// 오늘 체크인이 없으면 어제부터 세기 시작하고, 하루라도 끊기면 그 자리에서 멈춘다.
function streakFromDates(dates) {
  if (dates.size === 0) return 0;

  const cursor = kstNow();
  if (!dates.has(kstDateStr())) cursor.setUTCDate(cursor.getUTCDate() - 1);

  let streak = 0;
  while (true) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth()+1).padStart(2,'0')}-${String(cursor.getUTCDate()).padStart(2,'0')}`;
    if (!dates.has(key)) break;
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

// 기록 전체에서 가장 길었던 연속 구간. 현재 스트릭과 달리 과거까지 훑는다.
function bestStreakFromDates(dates) {
  let best = 0, run = 0, prev = null;
  for (const d of [...dates].sort()) {
    const cur = Date.parse(d + 'T00:00:00Z');
    run = (prev !== null && cur - prev === 86400000) ? run + 1 : 1;
    if (run > best) best = run;
    prev = cur;
  }
  return best;
}

async function calcStreakFromD1(email, env) {
  const { results } = await env.DB.prepare(
    "SELECT date FROM checkins WHERE email = ? ORDER BY date DESC LIMIT 400"
  ).bind(email).all();
  return streakFromDates(new Set(results.map(r => r.date)));
}

// 랭킹용 조회 범위. 스트릭이 이 값을 넘으면 여기서 잘린다.
const RANK_WINDOW_DAYS = 90;
// 메일 카드용: 내 순위/최고 기록. 실패해도 메일 발송을 막지 않는다.
async function rankInfoFor(env, sub, cache) {
  try {
    if (!sub.officeCode || !sub.schoolCode) return null;
    const ranked = await getSchoolRank(env, sub.officeCode, sub.schoolCode, cache);
    const idx = ranked.findIndex(r => r.email === sub.email);
    return {
      myRank: idx === -1 ? null : idx + 1,
      myStreak: idx === -1 ? 0 : ranked[idx].streak,
      top: ranked[0] || null,
      isTopMe: idx === 0,
      total: ranked.length
    };
  } catch (e) { return null; }
}

// 메일용: 학교 랭킹을 한 번에 계산. 학교별로 캐시해서 D1 왕복을 줄인다.
async function getSchoolRank(env, officeCode, schoolCode, cache) {
  const key = officeCode + "|" + schoolCode;
  if (cache && cache.has(key)) return cache.get(key);
  const { results } = await env.DB.prepare(
    "SELECT email, grade, classNm, nickname FROM users WHERE officeCode = ? AND schoolCode = ? LIMIT 500"
  ).bind(officeCode, schoolCode).all();
  const { results: rows } = await env.DB.prepare(
    `SELECT c.email, c.date FROM checkins c
     JOIN users u ON u.email = c.email
     WHERE u.officeCode = ? AND u.schoolCode = ? AND c.date >= ?`
  ).bind(officeCode, schoolCode, rankWindowStart()).all();

  const byEmail = new Map();
  for (const r of rows) {
    let set = byEmail.get(r.email);
    if (!set) { set = new Set(); byEmail.set(r.email, set); }
    set.add(r.date);
  }
  const ranked = [];
  for (const u of results) {
    const streak = streakFromDates(byEmail.get(u.email) || new Set());
    if (streak > 0) {
      ranked.push({
        email: u.email,
        display: u.nickname || `${u.grade || "?"}학년 ${u.classNm || "?"}반`,
        streak
      });
    }
  }
  ranked.sort((a, b) => b.streak - a.streak);
  if (cache) cache.set(key, ranked);
  return ranked;
}

function rankWindowStart() {
  const d = kstNow();
  d.setUTCDate(d.getUTCDate() - RANK_WINDOW_DAYS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// 이메일 하나당 항상 같은 이모지가 나오도록 하는 간단한 고정 해시.
// 이메일을 역추적할 순 없고, 랭킹 화면에서 같은 표시명(학년+반)이 겹칠 때 줄을 구분하는 용도.
const RANK_AVATARS = ['🦊','🐻','🐰','🐱','🐶','🐼','🐨','🐯','🦁','🐸','🐵','🦉','🐢','🐙','🦄','🐷'];
function avatarForEmail(email) {
  let sum = 0;
  for (let i = 0; i < email.length; i++) sum += email.charCodeAt(i);
  return RANK_AVATARS[sum % RANK_AVATARS.length];
}

// 인증된 사용자의 학교/학년/반 정보를 D1 users 테이블에 동기화 (랭킹 조회용).
// KV(SUBS)가 원본이고, 이건 랭킹을 학교별로 그룹핑하기 위한 파생 데이터일 뿐이다.
async function upsertUserProfile(env, { email, officeCode, schoolCode, schoolName, grade, classNm, nickname }) {
  await env.DB.prepare(
    `INSERT INTO users (email, officeCode, schoolCode, schoolName, grade, classNm, nickname, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       officeCode=excluded.officeCode, schoolCode=excluded.schoolCode, schoolName=excluded.schoolName,
       grade=excluded.grade, classNm=excluded.classNm,
       nickname=COALESCE(excluded.nickname, users.nickname), updated_at=excluded.updated_at`
  ).bind(email, officeCode, schoolCode, schoolName, grade, classNm, nickname ?? null, Date.now()).run();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // ===== NEIS 프록시 =====
    if (url.pathname === "/api/school") {
      const name = url.searchParams.get("name");
      if (!name) return json({ ok:false, msg:"학교 이름이 필요해." }, cors);
      try {
        const r = await fetch(`${NEIS_BASE}/schoolInfo?KEY=${env.NEIS_KEY}&Type=json&pIndex=1&pSize=15&SCHUL_NM=${encodeURIComponent(name)}`);
        const d = await r.json();
        const rows = d.schoolInfo?.[1]?.row || [];
        const result = rows.map(s => ({
          officeCode: s.ATPT_OFCDC_SC_CODE,
          schoolCode: s.SD_SCHUL_CODE,
          schoolName: s.SCHUL_NM,
          address: `${s.LCTN_SC_NM || ""} · ${s.SCHUL_KND_SC_NM || ""}`
        }));
        return json({ ok:true, schools: result }, cors);
      } catch (e) { return json({ ok:false, msg:"검색 오류: "+e.message }, cors); }
    }

    if (url.pathname === "/api/meal") {
      const office = url.searchParams.get("office");
      const school = url.searchParams.get("school");
      if (!office || !school) return json({ ok:false, msg:"학교 정보가 필요해." }, cors);
      const meal = await getMeal(office, school, env, safeDate(url.searchParams.get("date")));
      return json({ ok:true, meal }, cors);
    }

    if (url.pathname === "/api/timetable") {
      const office = url.searchParams.get("office");
      const school = url.searchParams.get("school");
      const grade = url.searchParams.get("grade");
      const classNm = url.searchParams.get("class");
      if (!office || !school) return json({ ok:false, msg:"학교 정보가 필요해." }, cors);
      const timetable = await getTimetable(office, school, grade, classNm, env, safeDate(url.searchParams.get("date")));
      return json({ ok:true, timetable }, cors);
    }

    // 달력 한 달치: 학사일정 + 급식이 있는 날
    if (url.pathname === "/api/calendar") {
      const office = url.searchParams.get("office");
      const school = url.searchParams.get("school");
      const grade = url.searchParams.get("grade");
      const range = monthRange(url.searchParams.get("month") || "");
      if (!office || !school) return json({ ok:false, msg:"학교 정보가 필요해." }, cors);
      if (!range) return json({ ok:false, msg:"month는 YYYYMM 형식이어야 해." }, cors);
      const [schedules, meals] = await Promise.all([
        getSchedules(office, school, env, range.from, range.to, grade),
        getMealRange(office, school, env, range.from, range.to)
      ]);
      return json({ ok:true, month: url.searchParams.get("month"), schedules, mealDays: Object.keys(meals).sort() }, cors);
    }

    // ===== 어드민 로그인 화면 =====
    if (url.pathname === "/admin") {
      const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>어드민 로그인</title>
<style>
  body{font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{background:#fff;border-radius:20px;padding:32px;box-shadow:0 8px 30px rgba(0,0,0,.1);width:300px;text-align:center}
  h2{color:#4f46e5;margin:0 0 20px}
  input{width:100%;padding:14px;border:1px solid #cbd5e1;border-radius:12px;font-size:16px;margin-bottom:14px;box-sizing:border-box}
  button{width:100%;padding:14px;background:#4f46e5;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer}
  .err{color:#ef4444;font-size:13px;margin-top:10px;min-height:16px}
</style></head><body>
<div class="box">
  <h2>🔒 오늘급식 어드민</h2>
  <input id="pw" type="password" placeholder="비밀번호" onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">로그인</button>
  <div class="err" id="err"></div>
</div>
<script>
  async function login(){
    const pw = document.getElementById('pw').value;
    const err = document.getElementById('err');
    err.textContent = '확인 중...';
    const r = await fetch("/admin_panel", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ pw }) });
    if(r.ok){ const html = await r.text(); document.open(); document.write(html); document.close(); }
    else { err.textContent = '비밀번호가 틀렸어요.'; }
  }
</script>
</body></html>`;
      return new Response(html, { headers:{ "Content-Type":"text/html; charset=utf-8" } });
    }

    // ===== 어드민 패널 =====
    if (url.pathname === "/admin_panel" && request.method === "POST") {
      const { pw } = await request.json();
      if (pw !== env.ADMIN_PW) return new Response("권한 없음", { status: 401 });
      const list = await env.SUBS.list();
      const subs = [];
      for (const key of list.keys) {
        const data = await env.SUBS.get(key.name);
        if (data) { try { subs.push(JSON.parse(data)); } catch (e) {} }
      }
      const rows = subs.map(s => {
        const acCount = (s.academies && s.academies.length) || 0;
        const status = s.verified ? `<span style="color:#16a34a;font-weight:700">인증완료</span>` : `<span style="color:#f59e0b;font-weight:700">대기중</span>`;
        const gc = s.grade ? `${s.grade}-${s.classNm}` : '-';
        return `<tr>
          <td>${s.email}</td><td>${s.schoolName || '-'}</td><td style="text-align:center">${gc}</td><td style="text-align:center">${status}</td><td style="text-align:center">${acCount}</td>
          <td style="text-align:center">
            <button onclick="sendTo('${s.email}')" class="mini">메일</button>
            <button onclick="delTo('${s.email}')" class="mini del">삭제</button>
          </td></tr>`;
      }).join('');
      const verifiedCount = subs.filter(s => s.verified).length;
      const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>오늘급식 어드민</title>
<style>
  body{font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;background:#f1f5f9;padding:20px;max-width:800px;margin:0 auto;color:#1e293b}
  h1{font-size:22px;margin-bottom:6px} .count{color:#4f46e5;font-weight:800;margin-bottom:20px}
  .box{background:#fff;border-radius:16px;padding:20px;margin-bottom:16px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{padding:10px 8px;border-bottom:1px solid #f1f5f9;text-align:left} th{color:#94a3b8;font-size:12px}
  .mini{width:auto;padding:6px 10px;font-size:12px;border:none;border-radius:8px;background:#4f46e5;color:#fff;cursor:pointer;margin:2px}
  .mini.del{background:#ef4444}
  input,textarea{width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px;margin-bottom:10px;box-sizing:border-box}
  .send-btn{width:100%;padding:12px;background:#16a34a;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer}
  .label{font-weight:800;color:#4f46e5;margin-bottom:10px} .msg{text-align:center;margin-top:10px;font-weight:600}
</style></head><body>
<h1>🛠️ 오늘급식 어드민</h1>
<div class="count">총 구독자 ${subs.length}명 · 인증완료 ${verifiedCount}명</div>
<div class="box">
  <div class="label">📢 전체 공지 보내기 (인증된 구독자만)</div>
  <input id="nt" placeholder="공지 제목">
  <textarea id="nb" rows="4" placeholder="공지 내용"></textarea>
  <button class="send-btn" onclick="sendNotice()">전체 발송</button>
  <div class="msg" id="nmsg"></div>
</div>
<div class="box">
  <div class="label">👥 구독자 목록</div>
  <table><tr><th>이메일</th><th>학교</th><th style="text-align:center">학년반</th><th style="text-align:center">상태</th><th style="text-align:center">학원</th><th style="text-align:center">관리</th></tr>
  ${rows || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:20px">아직 구독자가 없어요.</td></tr>'}
  </table>
</div>
<script>
  const PW = ${JSON.stringify(pw)};
  const BASE = "${WORKER_URL}";
  async function sendTo(email){
    if(!confirm(email+" 에게 오늘 브리핑 메일을 보낼까?"))return;
    const r=await fetch(BASE+"/admin_send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pw:PW,email})});
    alert(await r.text());
  }
  async function delTo(email){
    if(!confirm(email+" 구독자를 삭제할까?"))return;
    const r=await fetch(BASE+"/admin_del",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pw:PW,email})});
    alert(await r.text()); location.reload();
  }
  async function sendNotice(){
    const t=document.getElementById('nt').value.trim();
    const b=document.getElementById('nb').value.trim();
    const m=document.getElementById('nmsg');
    if(!t||!b){m.style.color='#ef4444';m.textContent='제목과 내용을 넣어줘!';return;}
    if(!confirm("모든 구독자에게 공지를 보낼까?"))return;
    m.style.color='#64748b';m.textContent='발송 중...';
    const r=await fetch(BASE+"/admin_notice",{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pw:PW,title:t,body:b})});
    const d=await r.json();
    m.style.color='#16a34a';m.textContent='✅ '+d.msg;
  }
</script>
</body></html>`;
      return new Response(html, { headers:{ "Content-Type":"text/html; charset=utf-8" } });
    }

    if (url.pathname === "/admin_send" && request.method === "POST") {
      const { pw, email } = await request.json();
      if (pw !== env.ADMIN_PW) return new Response("권한 없음", { status: 401 });
      const data = await env.SUBS.get(email);
      if (!data) return new Response("그 구독자를 못 찾았어.");
      try {
        const r = await sendOne(JSON.parse(data), env);
        await writeMailLog(env, [{ email, ok: !!(r && r.ok), detail: r && r.detail }]);
        if (r && r.ok) return new Response(email+" 에게 메일 보냈어!");
        return new Response("실패: " + safeDetail(r && r.detail));
      } catch (e) {
        await writeMailLog(env, [{ email, ok:false, detail: String(e && e.message || e) }]);
        return new Response("실패: "+e.message);
      }
    }

    // 발송 결과 조회. "메일이 안 왔다"를 바로 확인하려고 만든 관리자 전용 엔드포인트.
    if (url.pathname === "/admin_maillog" && request.method === "POST") {
      const body = await request.json();
      if (body.pw !== env.ADMIN_PW) return json({ ok:false, msg:"권한 없음" }, cors);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : kstDateStr();
      try {
        const res = await env.DB.prepare(
          "SELECT email, status, detail, created_at FROM mail_log WHERE date = ? ORDER BY id DESC LIMIT 200"
        ).bind(date).all();
        const rows = res.results || [];
        return json({
          ok: true, date,
          total: rows.length,
          okCount: rows.filter(r => r.status === "ok").length,
          failCount: rows.filter(r => r.status !== "ok").length,
          rows
        }, cors);
      } catch (e) {
        return json({ ok:false, msg:"로그를 불러오지 못했어." }, cors);
      }
    }

    if (url.pathname === "/admin_del" && request.method === "POST") {
      const { pw, email } = await request.json();
      if (pw !== env.ADMIN_PW) return new Response("권한 없음", { status: 401 });
      await env.SUBS.delete(email);
      return new Response(email+" 삭제 완료!");
    }

    if (url.pathname === "/admin_notice" && request.method === "POST") {
      const { pw, title, body } = await request.json();
      if (pw !== env.ADMIN_PW) return json({ ok:false, msg:"권한 없음" }, cors);
      const count = await sendNoticeToAll(env, title, body);
      return json({ ok:true, msg:`${count}명에게 공지 발송 완료!` }, cors);
    }

    // 구독 신청 (학년·반 포함)
    if (url.pathname === "/subscribe" && request.method === "POST") {
      try {
        const body = await request.json();
        const { email, officeCode, schoolCode, schoolName, lat, lon, grade, classNm } = body;
        if (!email || !email.includes("@")) return json({ ok:false, msg:"이메일을 제대로 입력해줘!" }, cors);
        if (!schoolCode) return json({ ok:false, msg:"학교를 먼저 선택해줘." }, cors);

        const existing = await env.SUBS.get(email);
        if (existing) {
          const old = JSON.parse(existing);
          if (old.verified) {
            const updated = { ...old, officeCode, schoolCode, schoolName, lat, lon, grade, classNm, verified: true, academies: old.academies || [] };
            await env.SUBS.put(email, JSON.stringify(updated));
            await upsertUserProfile(env, updated);
            return json({ ok:true, msg:"이미 인증된 계정이라 정보만 업데이트했어! ✅" }, cors);
          }
        }

        const token = makeToken();
        const academies = existing ? (JSON.parse(existing).academies || []) : [];
        const record = { email, officeCode, schoolCode, schoolName, lat, lon, grade, classNm, verified: false, token, academies };
        await env.SUBS.put(email, JSON.stringify(record));

        const verifyUrl = `${WORKER_URL}/verify?email=${encodeURIComponent(email)}&token=${token}`;
        const vhtml = `
          <div style="background:#f1f5f9;padding:24px 16px;font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;max-width:480px;margin:0 auto">
            <div style="background:#fff;border-radius:16px;padding:28px;text-align:center">
              <div style="font-size:22px;font-weight:800;color:#4f46e5">🍚 오늘급식 구독 확인</div>
              <p style="color:#475569;font-size:15px;margin:16px 0">아래 버튼을 눌러야 구독이 완료돼요!<br>확인하면 매일 아침 7시에 브리핑을 보내드려요.</p>
              <a href="${verifyUrl}" style="display:inline-block;margin:8px 0;padding:14px 30px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:12px;font-weight:800;font-size:16px">✅ 구독 확인하기</a>
              <p style="color:#94a3b8;font-size:12px;margin-top:18px">이 메일을 요청한 적이 없다면 무시하면 돼요.</p>
            </div>
          </div>`;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "오늘급식 <onboarding@resend.dev>", to: email, subject: "🍚 오늘급식 구독 확인 메일", html: vhtml })
        });

        return json({ ok:true, msg:"확인 메일을 보냈어! 📩 메일함에서 '구독 확인하기'를 눌러줘야 구독 완료야." }, cors);
      } catch (e) { return json({ ok:false, msg:"오류: "+e.message }, cors); }
    }

    if (url.pathname === "/verify") {
      const email = url.searchParams.get("email");
      const token = url.searchParams.get("token");
      const data = email ? await env.SUBS.get(email) : null;
      if (!data) return new Response(htmlWrap("<h2>❌ 구독 정보를 찾을 수 없어요</h2>"), { headers:{ "Content-Type":"text/html; charset=utf-8" } });
      const rec = JSON.parse(data);
      if (rec.verified) return new Response(htmlWrap("<h2>✅ 이미 인증된 계정이에요!</h2>"), { headers:{ "Content-Type":"text/html; charset=utf-8" } });
      if (rec.token !== token) return new Response(htmlWrap("<h2>❌ 인증 코드가 올바르지 않아요</h2>"), { headers:{ "Content-Type":"text/html; charset=utf-8" } });
      rec.verified = true;
      delete rec.token;
      await env.SUBS.put(email, JSON.stringify(rec));
      await upsertUserProfile(env, rec);
      return new Response(htmlWrap(`<h2>🎉 구독 완료!</h2><p style="color:#475569;font-size:15px">내일 아침 7시부터 <b>${rec.schoolName || "학교"}</b> 브리핑을 받아볼 수 있어요.</p>`), { headers:{ "Content-Type":"text/html; charset=utf-8" } });
    }

    // ===== 매직링크 로그인 =====
    if (url.pathname === "/login/request" && request.method === "POST") {
      try {
        const { email } = await request.json();
        if (!email || !email.includes("@")) return json({ ok:false, msg:"이메일을 제대로 입력해줘!" }, cors);

        const existing = await env.SUBS.get(email);
        if (existing) {
          const sub = JSON.parse(existing);
          if (sub.verified) {
            const loginToken = secureToken();
            await env.SUBS.put(`logintoken:${loginToken}`, JSON.stringify({ email }), { expirationTtl: LOGIN_TOKEN_TTL });
            const loginUrl = `${WORKER_URL}/login/verify?token=${loginToken}`;
            const html = `
              <div style="background:#f1f5f9;padding:24px 16px;font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;max-width:480px;margin:0 auto">
                <div style="background:#fff;border-radius:16px;padding:28px;text-align:center">
                  <div style="font-size:22px;font-weight:800;color:#4f46e5">🔑 오늘급식 로그인</div>
                  <p style="color:#475569;font-size:15px;margin:16px 0">아래 버튼을 누르면 로그인돼요.<br>이 링크는 10분 동안, 한 번만 쓸 수 있어요.</p>
                  <a href="${loginUrl}" style="display:inline-block;margin:8px 0;padding:14px 30px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:12px;font-weight:800;font-size:16px">🔑 로그인하기</a>
                  <p style="color:#94a3b8;font-size:12px;margin-top:18px">이 로그인을 요청한 적이 없다면 무시하면 돼요.</p>
                </div>
              </div>`;
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ from: "오늘급식 <onboarding@resend.dev>", to: email, subject: "🔑 오늘급식 로그인 링크", html })
            });
          }
        }

        return json({ ok:true, msg:"가입된 이메일이면 로그인 링크를 보냈어! 📩 메일함을 확인해줘 (10분 안에 유효)" }, cors);
      } catch (e) { return json({ ok:false, msg:"오류: "+e.message }, cors); }
    }

    if (url.pathname === "/login/verify") {
      const token = url.searchParams.get("token");
      const data = token ? await env.SUBS.get(`logintoken:${token}`) : null;
      if (!data) {
        return new Response(htmlWrap("<h2>❌ 로그인 링크가 만료됐거나 이미 사용됐어요</h2><p style=\"color:#475569;font-size:15px\">다시 로그인을 요청해줘.</p>"), { headers:{ "Content-Type":"text/html; charset=utf-8" } });
      }
      await env.SUBS.delete(`logintoken:${token}`);
      const { email } = JSON.parse(data);
      const sessionToken = secureToken();
      await env.SUBS.put(`session:${sessionToken}`, JSON.stringify({ email }), { expirationTtl: SESSION_TTL });
      return Response.redirect(`${FRONTEND_URL}/#session=${sessionToken}`, 302);
    }

    if (url.pathname === "/login/logout" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      const match = auth.match(/^Bearer (.+)$/);
      if (match) await env.SUBS.delete(`session:${match[1]}`);
      return json({ ok:true, msg:"로그아웃 됐어!" }, cors);
    }

    if (url.pathname === "/setacademy" && request.method === "POST") {
      try {
        const body = await request.json();
        const { academies } = body;
        const email = await getSessionEmail(request, env);
        if (!email) return json({ ok:false, msg:"로그인이 필요해! 위에서 로그인 링크를 받아줘." }, cors);
        const existing = await env.SUBS.get(email);
        if (!existing) return json({ ok:false, msg:"먼저 학교를 구독해줘!" }, cors);
        const sub = JSON.parse(existing);
        if (!sub.verified) return json({ ok:false, msg:"이메일 인증을 먼저 해줘! 확인 메일의 링크를 눌러야 해." }, cors);
        sub.academies = academies || [];
        await env.SUBS.put(email, JSON.stringify(sub));
        return json({ ok:true, msg:"학원 일정 저장 완료! 🎒" }, cors);
      } catch (e) { return json({ ok:false, msg:"오류: "+e.message }, cors); }
    }

    // ===== 학습 기록 서버 통합 =====
    // localStorage가 날아가도 기록이 남게 계정별 JSON을 보관한다.
    // 인증은 기존 엔드포인트와 동일하게 세션 토큰만 신뢰한다(?email= 무시).
    if (url.pathname === "/studylog" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ ok:false, msg:"로그인이 필요해!" }, cors);
      try {
        const row = await env.DB.prepare(
          "SELECT data, updated_at FROM study_log WHERE email = ?"
        ).bind(email).first();
        if (!row) return json({ ok:true, log:null, updatedAt:0 }, cors);
        return json({ ok:true, log: JSON.parse(row.data), updatedAt: row.updated_at }, cors);
      } catch (e) {
        return json({ ok:false, msg:"기록을 불러오지 못했어." }, cors);
      }
    }

    if (url.pathname === "/studylog" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ ok:false, msg:"로그인이 필요해!" }, cors);
      try {
        const body = await request.json();
        const log = body && body.log;
        // 형식이 아닌 값을 그대로 저장하면 다음 로드에서 앱이 깨진다.
        if (!log || typeof log !== "object" || Array.isArray(log)) {
          return json({ ok:false, msg:"형식이 올바르지 않아." }, cors);
        }
        const data = JSON.stringify(log);
        if (data.length > 200000) {
          return json({ ok:false, msg:"기록이 너무 커서 저장할 수 없어." }, cors);
        }
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO study_log (email, data, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(email) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
        ).bind(email, data, now).run();
        return json({ ok:true, updatedAt: now }, cors);
      } catch (e) {
        return json({ ok:false, msg:"기록을 저장하지 못했어." }, cors);
      }
    }

    if (url.pathname === "/getacademy") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ ok:false, msg:"로그인이 필요해! 위에서 로그인 링크를 받아줘." }, cors);
      const existing = await env.SUBS.get(email);
      if (!existing) return json({ ok:true, academies: [] }, cors);
      const sub = JSON.parse(existing);
      return json({ ok:true, academies: sub.academies || [] }, cors);
    }

        if (url.pathname === "/setdday" && request.method === "POST") {
      try {
        const body = await request.json();
        const { ddays } = body;
        const email = await getSessionEmail(request, env);
        if (!email) return json({ ok:false, msg:"로그인이 필요해! 위에서 로그인 링크를 받아줘." }, cors);
        const existing = await env.SUBS.get(email);
        if (!existing) return json({ ok:false, msg:"먼저 학교를 구독해줘!" }, cors);
        const sub = JSON.parse(existing);
        if (!sub.verified) return json({ ok:false, msg:"이메일 인증을 먼저 해줘!" }, cors);
        sub.ddays = ddays || [];
        await env.SUBS.put(email, JSON.stringify(sub));
        return json({ ok:true, msg:"디데이 저장 완료! 🎯" }, cors);
      } catch (e) { return json({ ok:false, msg:"오류: "+e.message }, cors); }
    }

    if (url.pathname === "/getdday") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ ok:false, msg:"로그인이 필요해! 위에서 로그인 링크를 받아줘." }, cors);
      const existing = await env.SUBS.get(email);
      if (!existing) return json({ ok:true, ddays: [] }, cors);
      const sub = JSON.parse(existing);
      return json({ ok:true, ddays: sub.ddays || [] }, cors);
    }

    // 오늘 학습 항목을 완료했다는 신호만 받고, 스트릭 계산은 서버(D1)가 KST 기준으로 함
    if (url.pathname === "/checkin" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ ok:false, msg:"로그인이 필요해! 위에서 로그인 링크를 받아줘." }, cors);
      try {
        await env.DB.prepare(
          "INSERT INTO checkins (email, date, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"
        ).bind(email, kstDateStr(), Date.now()).run();
        const streak = await calcStreakFromD1(email, env);
        return json({ ok:true, streak }, cors);
      } catch (e) { return json({ ok:false, msg:"오류: "+e.message }, cors); }
    }

    if (url.pathname === "/streak") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ ok:false, msg:"로그인이 필요해! 위에서 로그인 링크를 받아줘." }, cors);
      const streak = await calcStreakFromD1(email, env);
      return json({ ok:true, streak }, cors);
    }

    // 개인 기록 카드용. 체크인 날짜 원본과 요약 수치를 함께 준다.
    if (url.pathname === "/history") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ ok:false, msg:"로그인이 필요해!" }, cors);

      const { results } = await env.DB.prepare(
        "SELECT date FROM checkins WHERE email = ? ORDER BY date DESC LIMIT 400"
      ).bind(email).all();
      const dates = results.map(r => r.date);
      const set = new Set(dates);
      return json({
        ok: true, dates,
        streak: streakFromDates(set),
        best: bestStreakFromDates(set),
        total: set.size
      }, cors);
    }

    // 앱에서 학교나 학년/반을 바꿨을 때 서버 프로필을 맞춘다.
    // 이게 없으면 D1은 구독 시점 값에 묶여 랭킹이 엉뚱한 학교로 나간다.
    if (url.pathname === "/profile" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ ok:false, msg:"로그인이 필요해! 위에서 로그인 링크를 받아줘." }, cors);

      const body = await request.json().catch(() => null);
      if (!body) return json({ ok:false, msg:"요청 형식이 올바르지 않아." }, cors);

      const { officeCode, schoolCode, schoolName, grade, classNm, nickname } = body;
      if (!officeCode || !schoolCode) return json({ ok:false, msg:"학교 정보가 필요해." }, cors);

      await upsertUserProfile(env, {
        email, officeCode, schoolCode, schoolName,
        grade: grade || null, classNm: classNm || null,
        nickname: (nickname || "").trim().slice(0, 12) || null
      });
      return json({ ok:true }, cors);
    }

    // 같은 학교 사용자들의 스트릭 랭킹. 이메일 원문/개인정보는 응답에 절대 포함하지 않는다.
    if (url.pathname === "/ranking") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ ok:false, msg:"로그인이 필요해! 위에서 로그인 링크를 받아줘." }, cors);

      const me = await env.DB.prepare(
        "SELECT officeCode, schoolCode, schoolName FROM users WHERE email = ?"
      ).bind(email).first();
      if (!me) return json({ ok:false, msg:"학교 정보를 먼저 저장해줘! (재구독하면 반영돼)" }, cors);

      const { results } = await env.DB.prepare(
        "SELECT email, grade, classNm, nickname FROM users WHERE officeCode = ? AND schoolCode = ? LIMIT 500"
      ).bind(me.officeCode, me.schoolCode).all();

      // 사용자마다 쿼리를 던지면 학교 규모만큼 D1 왕복이 늘어난다.
      // 학교 전체 체크인을 한 번에 받아 이메일별로 묶는다.
      const { results: rows } = await env.DB.prepare(
        `SELECT c.email, c.date FROM checkins c
         JOIN users u ON u.email = c.email
         WHERE u.officeCode = ? AND u.schoolCode = ? AND c.date >= ?`
      ).bind(me.officeCode, me.schoolCode, rankWindowStart()).all();

      const byEmail = new Map();
      for (const r of rows) {
        let set = byEmail.get(r.email);
        if (!set) { set = new Set(); byEmail.set(r.email, set); }
        set.add(r.date);
      }

      const ranked = [];
      for (const u of results) {
        const streak = streakFromDates(byEmail.get(u.email) || new Set());
        if (streak > 0) {
          ranked.push({
            email: u.email,
            display: u.nickname || `${u.grade || "?"}학년 ${u.classNm || "?"}반`,
            avatar: avatarForEmail(u.email),
            streak
          });
        }
      }
      ranked.sort((a, b) => b.streak - a.streak);

      const list = ranked.slice(0, 20).map((r, i) => ({
        rank: i + 1, avatar: r.avatar, display: r.display, streak: r.streak, isMe: r.email === email
      }));
      const myIndex = ranked.findIndex(r => r.email === email);
      const myRank = myIndex === -1 ? null : myIndex + 1;
      const myStreak = myIndex === -1 ? 0 : ranked[myIndex].streak;

      return json({ ok:true, schoolName: me.schoolName, myRank, myStreak, list }, cors);
    }

    if (url.pathname === "/debug") {
      const email = url.searchParams.get("email");
      const data = await env.SUBS.get(email);
      if (!data) return new Response("데이터 없음", { headers: { "Content-Type":"text/plain; charset=utf-8" } });
      return new Response(data, { headers: { "Content-Type":"application/json; charset=utf-8" } });
    }

    if (url.pathname === "/unsubscribe") {
      const email = url.searchParams.get("email");
      if (email) {
        await env.SUBS.delete(email);
        return new Response("구독이 취소됐어요. 그동안 고마웠어요! 🙏", { headers:{ "Content-Type":"text/plain; charset=utf-8" } });
      }
      return new Response("이메일이 필요해요.", { headers:{ "Content-Type":"text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/test") {
      const email = url.searchParams.get("email");
      if (email) {
        const data = await env.SUBS.get(email);
        if (!data) return new Response("그 이메일로 구독한 기록이 없어.", { headers:{ "Content-Type":"text/plain; charset=utf-8" } });
        const sub = JSON.parse(data);
        const [weather, air, meal, timetable] = await Promise.all([
          getWeather(sub.lat, sub.lon), getAir(sub.lat, sub.lon),
          getMeal(sub.officeCode, sub.schoolCode, env), getTimetable(sub.officeCode, sub.schoolCode, sub.grade, sub.classNm, env)
        ]);
        const cheer = CHEERS[Math.floor(Math.random() * CHEERS.length)];
        const rank = await rankInfoFor(env, sub);
        const html = buildHtml(sub, weather, air, meal, timetable, cheer, rank);
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "오늘급식 <onboarding@resend.dev>", to: sub.email, subject: `🌅 오늘의 아침 브리핑 (${dateKorean()})`, html })
        });
        const banner = `<div style="background:#16a34a;color:#fff;text-align:center;padding:12px;font-family:sans-serif;font-weight:700">✅ 메일도 보냈어! Gmail 확인해봐. (아래는 미리보기)</div>`;
        return new Response(banner + html, { headers:{ "Content-Type":"text/html; charset=utf-8" } });
      }
    }

    return new Response("오늘급식 자동 메일 서버입니다. 매일 아침 7시에 자동 발송돼요.", { headers:{ "Content-Type":"text/plain; charset=utf-8" } });
  },

  async scheduled(event, env, ctx) {
    await sendMailToAll(env);
  }
};
