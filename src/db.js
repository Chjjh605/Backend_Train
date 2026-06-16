const mysql = require('mysql2/promise');
const config = require('./config');

// MySQL DB 커넥션 풀 생성 (Azure SSL 접속 대응)
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.name,
  connectionLimit: 10,
  charset: 'utf8mb4',
  multipleStatements: true, // 복수 쿼리 일괄 실행 허용 (init.sql 등)
  ssl: {
    rejectUnauthorized: false
  }
});

// 테이블 스키마 자동 업그레이드 함수 (일반 로그인용 필드 추가)
const ensureUserColumns = async () => {
  try {
    const connection = await pool.getConnection();
    try {
      // 서버 시작 시 데이터베이스 스키마 및 초기 데이터 자동 주입
      const fs = require('fs');
      const path = require('path');
      const initSqlPath = path.join(__dirname, '../init.sql');

      if (fs.existsSync(initSqlPath)) {
        console.log("🔄 [DB] init.sql 자동 실행 중...");
        const initSql = fs.readFileSync(initSqlPath, 'utf8');
        await connection.query(initSql);
        console.log("✅ [DB] init.sql 자동 주입 완료!");
      }

      const [columns] = await connection.execute("SHOW COLUMNS FROM users LIKE 'password'");
      if (columns.length === 0) {
        console.log("ℹ️ [DB] Adding 'password' column to 'users' table...");
        await connection.execute("ALTER TABLE users ADD COLUMN password VARCHAR(255) NULL");
      }
      const [phoneCols] = await connection.execute("SHOW COLUMNS FROM users LIKE 'phone'");
      if (phoneCols.length === 0) {
        console.log("ℹ️ [DB] Adding 'phone' column to 'users' table...");
        await connection.execute("ALTER TABLE users ADD COLUMN phone VARCHAR(50) NULL");
      }
      const [usernameCols] = await connection.execute("SHOW COLUMNS FROM users LIKE 'username'");
      if (usernameCols.length === 0) {
        console.log("ℹ️ [DB] Adding 'username' column to 'users' table...");
        await connection.execute("ALTER TABLE users ADD COLUMN username VARCHAR(255) NULL UNIQUE");
      }

      // reservations 테이블에 passenger_count 컬럼이 존재하는지 확인 및 추가
      const [resCols] = await connection.execute("SHOW COLUMNS FROM reservations LIKE 'passenger_count'");
      if (resCols.length === 0) {
        console.log("ℹ️ [DB] Adding 'passenger_count' column to 'reservations' table...");
        await connection.execute("ALTER TABLE reservations ADD COLUMN passenger_count INT NOT NULL DEFAULT 1");
      }

      console.log("✅ [DB] 회원 및 예약 테이블 스키마 검증 완료!");
    } finally {
      connection.release();
    }
  } catch (err) {
    console.warn("⚠️ [DB] 스키마 검증/업데이트 중 오류 발생 (DB가 오프라인일 수 있음):", err.message);
  }
};

module.exports = { pool, ensureUserColumns };
