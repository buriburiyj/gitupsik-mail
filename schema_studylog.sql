-- 학습 기록 서버 통합. localStorage의 studyLog를 계정별 JSON으로 보관한다.
-- 기기를 바꿔도 기록이 남게 하는 것이 목적이며, 로컬 저장은 그대로 유지한다.
CREATE TABLE IF NOT EXISTS study_log (
  email      TEXT PRIMARY KEY,
  data       TEXT NOT NULL,          -- studyLog 전체를 JSON 문자열로
  updated_at INTEGER NOT NULL        -- epoch ms. 로컬/서버 중 최신본 판단에 쓴다
);
