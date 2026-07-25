CREATE TABLE users (
  email TEXT PRIMARY KEY,
  officeCode TEXT NOT NULL,
  schoolCode TEXT NOT NULL,
  schoolName TEXT,
  grade TEXT,
  classNm TEXT,
  nickname TEXT,              -- 지금은 항상 NULL. 나중에 닉네임 기능에서 채움
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_users_school ON users(officeCode, schoolCode);
