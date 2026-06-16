const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const mysql = require('mysql2/promise');
const config = require('./config'); // 중앙 설정 파일 로드

// AWS Cognito JWT 검증 Verifier 및 인증 미들웨어 추가
const { CognitoJwtVerifier } = require("aws-jwt-verify");

let verifier = null;
if (config.aws.userPoolId && config.aws.clientId) {
  try {
    verifier = CognitoJwtVerifier.create({
      userPoolId: config.aws.userPoolId,
      tokenUse: "id", // ID Token 검증용 (Access Token 검증 시 "access")
      clientId: config.aws.clientId,
    });
    console.log("🔒 [Cognito] JWT Verifier가 정상적으로 초기화되었습니다.");
  } catch (err) {
    console.error("⚠️ [Cognito] JWT Verifier 초기화 실패 (Mock 모드로 진행):", err.message);
  }
} else {
  console.log("ℹ️ [Cognito] 환경변수가 감지되지 않았습니다. 인증 Mock 모드로 동작합니다.");
}

// Cognito JWT 검증용 공통 인증 미들웨어
const authMiddleware = async (req, res, next) => {
  const isMock = process.env.USE_MOCK_AUTH === 'true' || !verifier;

  if (isMock) {
    // Mock 모드: 바디/쿼리/헤더에서 userId를 획득하고 없으면 테스트용 UUID 기본 사용
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      req.userId = authHeader.split(" ")[1];
    } else {
      req.userId = req.body.userId || req.query.userId || 'e9a6f3b0-4f51-4b7b-8c88-e9f06a1f81d1';
    }
    return next();
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "인증 토큰(Bearer)이 누락되었습니다." });
    }
    const token = authHeader.split(" ")[1];
    const payload = await verifier.verify(token);
    req.userId = payload.sub; // 검증 완료된 Cognito sub을 req.userId로 바인딩
    next();
  } catch (err) {
    console.error("❌ [Cognito] JWT 서명/만료시간 검증 실패:", err.message);
    return res.status(401).json({ message: "유효하지 않거나 만료된 인증 토큰입니다." });
  }
};


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

const app = express();
// ALLOWED_ORIGINS가 쉼표로 구분된 여러 도메인일 경우 배열로 파싱하여 허용
const origins = config.allowedOrigins
  ? (config.allowedOrigins.includes(',') ? config.allowedOrigins.split(',') : config.allowedOrigins)
  : '*';

app.use(cors({
  origin: origins,
  credentials: true
}));
app.use(express.json());

const crypto = require('crypto');

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

ensureUserColumns();

// 아이디로 이메일 조회 API (Cognito 이메일 로그인 우회용)
app.get('/api/auth/lookup', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ message: 'userId가 필요합니다.' });
  }
  try {
    const [rows] = await pool.execute('SELECT email FROM users WHERE username = ?', [userId]);
    if (rows.length === 0) {
      return res.status(404).json({ message: '가입되지 않은 아이디입니다.' });
    }
    res.json({ email: rows[0].email });
  } catch (err) {
    console.error('❌ 유저 조회 오류:', err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

// 회원가입 API
app.post('/api/auth/signup', async (req, res) => {
  const { userId, password, name, email, phone, cognito_sub } = req.body;

  // 만약 Cognito 연동 가입 정보 등록 요청이라면
  if (cognito_sub) {
    try {
      const [existing] = await pool.execute('SELECT id FROM users WHERE cognito_sub = ?', [cognito_sub]);
      if (existing.length > 0) {
        return res.json({ success: true, message: '이미 등록된 회원입니다.' });
      }
      await pool.execute(
        'INSERT INTO users (cognito_sub, email, name, username, phone) VALUES (?, ?, ?, ?, ?)',
        [cognito_sub, email, name, userId || null, phone || null]
      );
      return res.status(201).json({ success: true, message: 'Cognito 회원정보가 동기화되었습니다.' });
    } catch (err) {
      console.error('❌ Cognito 회원정보 동기화 오류:', err);
      return res.status(500).json({ message: '회원정보 동기화 중 오류가 발생했습니다.' });
    }
  }

  // 일반/로컬 가입
  if (!userId || !password || !name || !email) {
    return res.status(400).json({ message: '필수 가입 정보가 누락되었습니다.' });
  }

  try {
    // 중복 체크 (username 또는 email)
    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [userId, email]
    );
    if (existing.length > 0) {
      return res.status(400).json({ message: '이미 사용 중인 아이디 또는 이메일입니다.' });
    }

    // Cognito Sub 대용 임의 UUID 생성
    const mockSub = `mock-${crypto.randomUUID()}`;

    await pool.execute(
      'INSERT INTO users (cognito_sub, email, name, password, phone, username) VALUES (?, ?, ?, ?, ?, ?)',
      [mockSub, email, name, password, phone || null, userId]
    );

    res.status(201).json({ success: true, message: '회원가입이 완료되었습니다.' });
  } catch (err) {
    console.error('❌ 회원가입 오류:', err);
    res.status(500).json({ message: '회원가입 처리 중 서버 오류가 발생했습니다.' });
  }
});

// 로그인 API
app.post('/api/auth/login', async (req, res) => {
  const { userId, password } = req.body;
  // 일반 로그인 (ID/PW 방식)
  if (!userId || !password) {
    return res.status(400).json({ message: '아이디와 비밀번호를 입력해주세요.' });
  }

  try {
    // username 또는 email로 조회
    const [rows] = await pool.execute(
      'SELECT cognito_sub, email, name, password FROM users WHERE username = ? OR email = ?',
      [userId, userId]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: '가입되지 않은 사용자입니다.' });
    }

    const user = rows[0];
    if (user.password !== password) {
      return res.status(400).json({ message: '비밀번호가 일치하지 않습니다.' });
    }

    res.json({
      success: true,
      cognito_sub: user.cognito_sub,
      name: user.name,
      email: user.email
    });
  } catch (err) {
    console.error('❌ 로그인 오류:', err);
    res.status(500).json({ message: '로그인 처리 중 서버 오류가 발생했습니다.' });
  }
});


// Cognito 설정 정보 제공 API (프론트에서 SDK 초기화에 사용, 하드코딩 방지)
app.get('/api/auth/config', (req, res) => {
  const isMock = process.env.USE_MOCK_AUTH === 'true' || !verifier;
  res.json({
    mockMode: isMock,
    region: config.aws.region,
    userPoolId: isMock ? null : config.aws.userPoolId,
    clientId: isMock ? null : config.aws.clientId,
  });
});

// Route 53 헬스체크용 엔드포인트
app.get('/health', (req, res) => {
  if (process.env.HEALTH_FAIL === 'true') {
    return res.status(500).send('FAIL');
  }
  res.status(200).send('OK');
});

// Redis 캐시 서버 연결 (로컬 환경일 때는 Standalone으로, AWS EKS 배포 환경에서는 ElastiCache Redis Cluster TLS 연결)
const isLocalRedis = config.redis.host === '127.0.0.1' || config.redis.host === 'localhost';
const redis = isLocalRedis
  ? new Redis({ host: config.redis.host, port: config.redis.port, enableOfflineQueue: false })
  : new Redis.Cluster(
    [{ host: config.redis.host, port: config.redis.port }],
    {
      dnsLookup: (address, callback) => callback(null, address),
      enableOfflineQueue: false,
      redisOptions: {
        tls: {
          // 클러스터 노드가 IP로 반환되더라도 TLS 호스트네임 검증을 통과하도록 설정
          checkServerIdentity: () => undefined
        }
      }
    }
  );

redis.on('connect', () => console.log('⚡ Redis 캐시 서버 연결 완료!'));
redis.on('error', (err) => {
  console.error('⚠️ Redis 캐시 서버 연결 오류 발생 (캐시 없이 계속 진행):', err.message);
});

// AWS SQS 클라이언트 세팅
const SQS_QUEUE_URL = config.aws.sqsQueueUrl;
const sqsClient = new SQSClient({
  region: config.aws.region
});

// 정해진 역 순서 정의 (서울 -> 대전 -> 대구 -> 부산)
const STATIONS = ['SEOUL', 'DAEJEON', 'DAEGU', 'BUSAN'];

// 다중 세그먼트 키 일괄 차감 LUA 스크립트 (Redis Cluster CROSSSLOT 방지를 위해 모든 키를 KEYS 배열에 정의)
const MULTI_RESERVE_LUA = `
  local userKey = KEYS[1]
  local expireTime = tonumber(ARGV[1])
  local count = tonumber(ARGV[2]) or 1
  
  if redis.call('EXISTS', userKey) == 1 then
    return -2
  end
  
  for i = 2, #KEYS do
    local key = KEYS[i]
    local seats = redis.call('GET', key)
    if not seats or tonumber(seats) < count then
      return -1
    end
  end
  
  for i = 2, #KEYS do
    local key = KEYS[i]
    redis.call('DECRBY', key, count)
  end
  
  redis.call('SET', userKey, 'PENDING', 'EX', expireTime)
  return 1
`;

// 예매 API (구간별 수량 차감 연동 방식)
app.post('/api/reserve', authMiddleware, async (req, res) => {
  if (process.env.READ_ONLY_MODE === 'true') {
    return res.status(403).json({ message: '현재 시스템은 재해 복구(DR) 대기 모드입니다. 조회 서비스만 이용 가능합니다.' });
  }

  const userId = req.userId;
  const { trainId, startStation, endStation, passengerCount } = req.body;
  const count = parseInt(passengerCount, 10) || 1;

  if (!userId || !trainId || !startStation || !endStation) {
    return res.status(400).json({ message: '필수 요청 파라미터가 누락되었습니다.' });
  }

  // Cognito sub (문자열)를 데이터베이스 사용자 기본키 id (숫자형)로 변환 (미등록 Cognito 유저인 경우 동적 생성)
  let dbUserId;
  try {
    const [userRows] = await pool.execute('SELECT id FROM users WHERE cognito_sub = ?', [userId]);
    if (userRows.length === 0) {
      console.log(`ℹ️ [Reserve] 신규 Cognito 유저 감지 (${userId}) - DB에 임시 계정을 생성합니다.`);
      const tempEmail = `user-${userId.substring(0, 8)}@korail-dev.com`;

      // 랜덤 한국인 성명 생성기 (시연용 데이터 고도화)
      const surnames = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임'];
      const firstNames = ['민준', '서준', '도윤', '예준', '시우', '하은', '서윤', '서연', '지우', '지유', '하윤', '준우', '지아', '수아', '지민'];
      const randomSurname = surnames[Math.floor(Math.random() * surnames.length)];
      const randomFirstName = firstNames[Math.floor(Math.random() * firstNames.length)];
      const tempName = `${randomSurname}${randomFirstName}`;

      try {
        const [insertResult] = await pool.execute(
          'INSERT INTO users (cognito_sub, email, name) VALUES (?, ?, ?)',
          [userId, tempEmail, tempName]
        );
        dbUserId = insertResult.insertId;
      } catch (insertErr) {
        // 병렬 요청으로 인해 중복 삽입 에러가 발생한 경우 재조회하여 ID 획득
        if (insertErr.code === 'ER_DUP_ENTRY') {
          const [retryRows] = await pool.execute('SELECT id FROM users WHERE cognito_sub = ?', [userId]);
          dbUserId = retryRows[0].id;
        } else {
          throw insertErr;
        }
      }
    } else {
      dbUserId = userRows[0].id;
    }
  } catch (dbErr) {
    console.error('❌ [Reserve] 유저 DB 조회/생성 중 오류:', dbErr.message);
    return res.status(500).json({ message: '사용자 정보 조회/등록 중 서버 오류가 발생했습니다.' });
  }

  const startIndex = STATIONS.indexOf(startStation);
  const endIndex = STATIONS.indexOf(endStation);

  if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
    return res.status(400).json({ message: '유효하지 않은 출발역 또는 도착역입니다.' });
  }

  // 예매하려는 세그먼트 Redis 키 추출
  const segmentKeys = [];
  for (let i = startIndex; i < endIndex; i++) {
    segmentKeys.push(`{train:${trainId}}:${STATIONS[i]}-${STATIONS[i + 1]}`);
  }

  // 1. [Lazy Cache Warming] 관련 세그먼트 키 중 Redis에 없는 키가 있다면 DB에서 조회하여 캐싱
  try {
    const keyChecks = await Promise.all(segmentKeys.map(key => redis.exists(key)));
    const missingKeys = segmentKeys.filter((key, idx) => keyChecks[idx] === 0);

    if (missingKeys.length > 0) {
      console.log(`ℹ️ [Reserve] Cache Miss - DB에서 구간 데이터를 로드하여 Redis에 캐싱합니다. (Missing: ${missingKeys.join(', ')})`);
      const querySegments = [];
      missingKeys.forEach(key => {
        const match = key.match(/:([A-Z]+)-([A-Z]+)$/);
        if (match) {
          querySegments.push([match[1], match[2]]);
        }
      });

      if (querySegments.length > 0) {
        const placeholders = querySegments.map(() => '(start_station = ? AND end_station = ?)').join(' OR ');
        const queryParams = [trainId];
        querySegments.forEach(seg => queryParams.push(seg[0], seg[1]));

        const [rows] = await pool.execute(
          `SELECT start_station, end_station, available_seats FROM train_segments WHERE train_id = ? AND (${placeholders})`,
          queryParams
        );

        if (rows.length !== querySegments.length) {
          return res.status(404).json({ message: "해당 노선 구간의 DB 정보가 존재하지 않습니다." });
        }

        const writePipeline = redis.pipeline();
        rows.forEach(row => {
          const key = `{train:${trainId}}:${row.start_station}-${row.end_station}`;
          writePipeline.set(key, row.available_seats, 'EX', 3600);
        });
        await writePipeline.exec();
      }
    }
  } catch (cacheErr) {
    console.error('⚠️ [Reserve] 캐시 워밍 중 에러 발생 (작업 계속 진행):', cacheErr.message);
  }

  // 2. 고유 예약 식별자 UUID 생성
  const crypto = require('crypto');
  const reservationId = crypto.randomUUID();
  const userKey = `{train:${trainId}}:user:${dbUserId}:${reservationId}`;
  let isReservedInRedis = false;

  try {
    // 3. Redis LUA 스크립트로 탑승 구간 전체 원자적 차감 실행 (userKey와 segmentKeys를 모두 KEYS 배열로 전달)
    const result = await redis.eval(MULTI_RESERVE_LUA, segmentKeys.length + 1, userKey, ...segmentKeys, 300, count);

    if (result === -1) return res.status(400).json({ message: '매진 (일부 구간 좌석 매진)' });
    if (result === -2) return res.status(400).json({ message: '이미 예약 진행 중' });

    isReservedInRedis = true; // Redis 예약 성공 표시

    // 4. SQS 메시지 전송 (구간 정보, 인원 수 및 reservationId 포함)
    const messageBody = JSON.stringify({
      reservationId,
      userId: dbUserId, // SQS에는 DB의 숫자형 유저 ID를 발송
      trainId,
      startStation,
      endStation,
      status: 'PENDING',
      passengerCount: count, // 인원 수 정보 추가
      timestamp: Date.now()
    });

    const command = new SendMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MessageBody: messageBody,
    });
    await sqsClient.send(command);

    res.json({ success: true, message: '예약 요청이 대기열에 등록되었습니다.', reservationId });
  } catch (err) {
    console.error('❌ 예약 요청 처리 중 에러 발생:', err);

    // 5. [롤백 로직] Redis 예약은 성공했으나 SQS 실패 시 모든 세그먼트 좌석 원상 복구 (인원 수만큼 복원)
    if (isReservedInRedis) {
      console.log(`🔄 [Rollback] SQS 전송 실패로 인해 Redis 상태를 롤백합니다. (User: ${dbUserId}, Train: ${trainId}, Res: ${reservationId})`);
      const rollbackPipeline = redis.pipeline();
      for (const key of segmentKeys) {
        rollbackPipeline.incrby(key, count);
      }
      rollbackPipeline.del(userKey);
      await rollbackPipeline.exec();
    }
    res.status(500).json({ message: '예약 요청 실패 (서버 에러)' });
  }
});

// 승차권 조회 API (GET) - 프론트 MyTicketList / TicketInfo 연동용
// 케이스 1: ?userId=...         → 회원의 최신 SUCCESS 예약 1건 조회 → { ticket: {...} }
// 케이스 2: ?ticketNumber=...&email=... → 비회원 발권번호+이메일로 단건 조회
app.get('/api/reserve', async (req, res) => {
  const { userId, ticketNumber, email } = req.query;

  // ── 케이스 1: 회원 최신 예약 조회 (MyTicketList.tsx) ──
  if (userId) {
    try {
      const [rows] = await pool.execute(`
        SELECT
          r.reservation_uuid,
          r.start_station,
          r.end_station,
          r.passenger_count,
          t.train_number,
          t.departure_date,
          t.departure_time,
          t.arrival_time
        FROM reservations r
        JOIN trains t ON r.train_id = t.id
        WHERE r.user_id = (SELECT id FROM users WHERE cognito_sub = ? LIMIT 1)
          AND r.status = 'SUCCESS'
        ORDER BY r.created_at DESC
        LIMIT 1
      `, [userId]);

      if (rows.length === 0) {
        return res.status(404).json({ message: '조회된 승차권이 없습니다.' });
      }

      const row = rows[0];

      // departure_date(YYYY-MM-DD 또는 Date 객체)에서 년/월/일 파싱
      const depDateStr = row.departure_date instanceof Date
        ? row.departure_date.toISOString().slice(0, 10)
        : String(row.departure_date).slice(0, 10);
      const [yearStr, monthStr, dayStr] = depDateStr.split('-');

      // 프론트 TicketData 인터페이스에 맞춰 응답 구성
      const ticket = {
        reservationId: row.reservation_uuid,
        startStation: row.start_station,
        endStation: row.end_station,
        selectedYear: parseInt(yearStr, 10),
        selectedMonth: parseInt(monthStr, 10),
        selectedDay: parseInt(dayStr, 10),
        depTime: row.departure_time,
        trainType: 'KTX',
        trainNumber: row.train_number,
        seatType: '일반실',
        passengerStr: `어른 ${row.passenger_count}명`,
        totalPassengers: row.passenger_count,
        totalPriceStr: `${(row.passenger_count * 59800).toLocaleString()}원`
      };

      return res.json({ ticket });
    } catch (err) {
      console.error('❌ [GET /api/reserve] 회원 승차권 조회 오류:', err.message);
      return res.status(500).json({ message: '승차권 조회 중 서버 오류가 발생했습니다.' });
    }
  }

  // ── 케이스 2: 비회원 발권번호 + 이메일 조회 (TicketInfo.tsx) ──
  if (ticketNumber && email) {
    try {
      const [rows] = await pool.execute(`
        SELECT
          r.reservation_uuid,
          r.start_station,
          r.end_station,
          r.status,
          r.passenger_count,
          r.created_at,
          t.train_number,
          t.departure_date,
          t.departure_time,
          t.arrival_time,
          u.name AS passenger_name
        FROM reservations r
        JOIN trains t ON r.train_id = t.id
        JOIN users u ON r.user_id = u.id
        WHERE r.reservation_uuid = ? AND u.email = ? AND r.status = 'SUCCESS'
        LIMIT 1
      `, [ticketNumber, email]);

      if (rows.length === 0) {
        return res.status(404).json({ message: '일치하는 결제 완료 내역이 없거나 정보가 올바르지 않습니다.' });
      }

      return res.json(rows[0]);
    } catch (err) {
      console.error('❌ [GET /api/reserve] 비회원 승차권 조회 오류:', err.message);
      return res.status(500).json({ message: '승차권 조회 중 서버 오류가 발생했습니다.' });
    }
  }

  return res.status(400).json({ message: '조회 파라미터(userId 또는 ticketNumber+email)가 필요합니다.' });
});

// 열차 조회 API (구간별 잔여석의 최솟값 계산 방식 + 열차 정보 추가)
app.get('/api/trains/:trainId', async (req, res) => {
  const { trainId } = req.params;
  const { start, end } = req.query;

  const startStation = start || 'SEOUL';
  const endStation = end || 'BUSAN';

  const startIndex = STATIONS.indexOf(startStation);
  const endIndex = STATIONS.indexOf(endStation);

  if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
    return res.status(400).json({ message: '유효하지 않은 출발역 또는 도착역입니다.' });
  }

  // 조회 구간 세그먼트 키 리스트 추출
  const segmentKeys = [];
  for (let i = startIndex; i < endIndex; i++) {
    segmentKeys.push(`{train:${trainId}}:${STATIONS[i]}-${STATIONS[i + 1]}`);
  }

  try {
    let seatValues;
    let isCacheMiss = true;

    try {
      // 1. Redis에서 모든 관련 구간의 잔여석 조회
      seatValues = await Promise.all(segmentKeys.map(key => redis.get(key)));
      isCacheMiss = seatValues.some(val => val === null);
    } catch (redisErr) {
      console.warn('⚠️ Redis 연결 실패로 인해 DB에서 직접 조회합니다:', redisErr.message);
      isCacheMiss = true;
      seatValues = null;
    }

    let finalAvailableSeats;

    if (isCacheMiss) {
      console.log(`ℹ️ Cache Miss 또는 Redis 미연결 - DB에서 열차 ${trainId} (${startStation} -> ${endStation}) 구간 데이터를 로드합니다.`);

      // 2. DB에서 필요한 모든 세그먼트 조회
      const querySegments = [];
      for (let i = startIndex; i < endIndex; i++) {
        querySegments.push([STATIONS[i], STATIONS[i + 1]]);
      }

      const placeholders = querySegments.map(() => '(start_station = ? AND end_station = ?)').join(' OR ');
      const queryParams = [trainId];
      querySegments.forEach(seg => queryParams.push(seg[0], seg[1]));

      const [rows] = await pool.execute(
        `SELECT start_station, end_station, available_seats FROM train_segments WHERE train_id = ? AND (${placeholders})`,
        queryParams
      );

      if (rows.length !== querySegments.length) {
        return res.status(404).json({ message: "해당 노선 구간 정보를 찾을 수 없습니다." });
      }

      let minSeats = Infinity;

      try {
        const writePipeline = redis.pipeline();
        rows.forEach(row => {
          const key = `{train:${trainId}}:${row.start_station}-${row.end_station}`;
          writePipeline.set(key, row.available_seats, 'EX', 3600);
          if (row.available_seats < minSeats) {
            minSeats = row.available_seats;
          }
        });
        await writePipeline.exec();
      } catch (writeErr) {
        console.warn('⚠️ Redis 캐시 쓰기 실패 (DB 조회 결과로 계속 진행):', writeErr.message);
        minSeats = Infinity;
        rows.forEach(row => {
          if (row.available_seats < minSeats) {
            minSeats = row.available_seats;
          }
        });
      }

      finalAvailableSeats = minSeats;

    } else {
      finalAvailableSeats = Math.min(...seatValues.map(val => parseInt(val, 10)));
    }

    // DB에서 trains 정보도 조회해서 같이 내려줍니다.
    const [trainRows] = await pool.execute(
      'SELECT train_number, departure_date, departure_time, arrival_time FROM trains WHERE id = ?',
      [trainId]
    );

    let trainInfo = {};
    if (trainRows.length > 0) {
      trainInfo = {
        trainNumber: trainRows[0].train_number,
        departureDate: trainRows[0].departure_date,
        departureTime: trainRows[0].departure_time,
        arrivalTime: trainRows[0].arrival_time
      };
    }

    res.json({
      trainId,
      startStation,
      endStation,
      availableSeats: finalAvailableSeats,
      ...trainInfo
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "조회 중 에러 발생" });
  }
});

// 열차 목록 조회 API (날짜, 시간, 출발역, 도착역 필터링 및 구간별 최솟값 계산)
app.get('/api/trains', async (req, res) => {
  const { start, end, date, time } = req.query;

  if (!date) {
    return res.status(400).json({ message: '출발 날짜(date)는 필수 입력 항목입니다.' });
  }

  const startStation = start || 'SEOUL';
  const endStation = end || 'BUSAN';
  let queryTime = time || '00:00:00';
  if (queryTime.length === 5) {
    queryTime += ':00'; // HH:MM -> HH:MM:00
  }

  const startIndex = STATIONS.indexOf(startStation);
  const endIndex = STATIONS.indexOf(endStation);

  if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
    return res.status(400).json({ message: '유효하지 않은 출발역 또는 도착역입니다.' });
  }

  try {
    // 1. 지정된 날짜 및 시간 이후에 출발하는 열차 목록을 DB에서 기본 조회
    const [trains] = await pool.execute(
      'SELECT id, train_number, segment, departure_date, departure_time, arrival_time, total_seats FROM trains WHERE departure_date = ? AND departure_time >= ? ORDER BY departure_time ASC',
      [date, queryTime]
    );

    if (trains.length === 0) {
      return res.json([]);
    }

    const result = [];
    const allKeys = [];
    const trainSegmentMap = {};

    trains.forEach(train => {
      const segmentKeys = [];
      for (let i = startIndex; i < endIndex; i++) {
        const key = `{train:${train.id}}:${STATIONS[i]}-${STATIONS[i + 1]}`;
        segmentKeys.push(key);
        allKeys.push(key);
      }
      trainSegmentMap[train.id] = segmentKeys;
    });

    let cachedValues = [];
    let isRedisAvailable = true;

    try {
      if (allKeys.length > 0) {
        cachedValues = await redis.mget(...allKeys);
      }
    } catch (redisErr) {
      console.warn('⚠️ [ListTrains] Redis MGET 실패, DB 직접 조회로 폴백:', redisErr.message);
      isRedisAvailable = false;
    }

    const cacheMap = {};
    allKeys.forEach((key, idx) => {
      cacheMap[key] = (isRedisAvailable && cachedValues[idx] !== null) ? parseInt(cachedValues[idx], 10) : null;
    });

    for (const train of trains) {
      const keys = trainSegmentMap[train.id];
      const missingKeys = keys.filter(k => cacheMap[k] === null);

      let finalAvailableSeats;

      if (missingKeys.length > 0) {
        console.log(`ℹ️ [ListTrains] Cache Miss - DB에서 열차 ${train.id}의 구간 데이터를 로드합니다.`);

        const querySegments = [];
        for (let i = startIndex; i < endIndex; i++) {
          querySegments.push([STATIONS[i], STATIONS[i + 1]]);
        }

        const placeholders = querySegments.map(() => '(start_station = ? AND end_station = ?)').join(' OR ');
        const queryParams = [train.id];
        querySegments.forEach(seg => queryParams.push(seg[0], seg[1]));

        const [rows] = await pool.execute(
          `SELECT start_station, end_station, available_seats FROM train_segments WHERE train_id = ? AND (${placeholders})`,
          queryParams
        );

        if (rows.length !== querySegments.length) {
          continue; // 구간 정보 불완전 시 제외
        }

        let minSeats = Infinity;
        const writePipeline = redis.pipeline();

        rows.forEach(row => {
          const key = `{train:${train.id}}:${row.start_station}-${row.end_station}`;
          if (isRedisAvailable) {
            writePipeline.set(key, row.available_seats, 'EX', 3600);
          }
          if (row.available_seats < minSeats) {
            minSeats = row.available_seats;
          }
        });

        if (isRedisAvailable) {
          try {
            await writePipeline.exec();
          } catch (writeErr) {
            console.warn('⚠️ [ListTrains] Redis 캐시 쓰기 실패:', writeErr.message);
          }
        }

        finalAvailableSeats = minSeats;
      } else {
        finalAvailableSeats = Math.min(...keys.map(k => cacheMap[k]));
      }

      result.push({
        trainId: train.id,
        trainNumber: train.train_number,
        departureDate: train.departure_date,
        departureTime: train.departure_time,
        arrivalTime: train.arrival_time,
        totalSeats: train.total_seats,
        availableSeats: finalAvailableSeats
      });
    }

    res.json(result);

  } catch (err) {
    console.error('❌ [ListTrains] 열차 목록 조회 중 에러:', err);
    res.status(500).json({ message: '열차 목록 조회 중 서버 에러가 발생했습니다.' });
  }
});

// 예약 확정 (결제 완료) API
app.post('/api/reserve/confirm', authMiddleware, async (req, res) => {
  if (process.env.READ_ONLY_MODE === 'true') {
    return res.status(403).json({ message: '현재 시스템은 재해 복구(DR) 대기 모드입니다. 결제 및 예매 확정이 불가능합니다.' });
  }

  const userId = req.userId;
  const { trainId, reservationId } = req.body;

  if (!userId || !trainId || !reservationId) {
    return res.status(400).json({ message: 'userId, trainId, reservationId가 필요합니다.' });
  }

  // Cognito sub (문자열)를 데이터베이스 사용자 기본키 id (숫자형)로 변환
  let dbUserId;
  let userEmail;
  let userName;
  try {
    const [userRows] = await pool.execute('SELECT id, email, name FROM users WHERE cognito_sub = ?', [userId]);
    if (userRows.length === 0) {
      return res.status(400).json({ message: '등록되지 않은 Cognito 유저입니다.' });
    }
    dbUserId = userRows[0].id;
    userEmail = userRows[0].email;
    userName = userRows[0].name;
  } catch (dbErr) {
    console.error('❌ [Confirm] 유저 DB 조회 중 오류:', dbErr.message);
    return res.status(500).json({ message: '사용자 정보 조회 중 서버 오류가 발생했습니다.' });
  }

  const userKey = `{train:${trainId}}:user:${dbUserId}:${reservationId}`;

  try {
    // 1. Redis에서 임시 예약 상태 확인
    const status = await redis.get(userKey);
    if (!status) {
      return res.status(400).json({ message: '예약 대기 시간이 만료되었거나 예약 요청 내역이 없습니다.' });
    }
    if (status === 'SUCCESS') {
      return res.status(400).json({ message: '이미 확정된 예약입니다.' });
    }

    // 2. MySQL DB에서 예약 확정 (PENDING -> SUCCESS)
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // 고유 예약 식별자 UUID를 기준으로 상태까지 상세 조회
      const [reservations] = await connection.execute(
        'SELECT id, status, start_station, end_station FROM reservations WHERE reservation_uuid = ? LIMIT 1',
        [reservationId]
      );

      if (reservations.length === 0) {
        throw new Error('예약 요청이 아직 처리 중입니다. 잠시 후 다시 결제를 시도해 주세요.');
      }

      const dbReservation = reservations[0];
      const dbReservationId = dbReservation.id;
      const dbStatus = dbReservation.status;
      const startStation = dbReservation.start_station;
      const endStation = dbReservation.end_station;

      if (dbStatus === 'CANCELLED') {
        throw new Error('예약 대기 시간이 초과되어 예약이 만료 취소되었습니다. 다시 예매해 주세요.');
      }
      if (dbStatus === 'SUCCESS') {
        throw new Error('이미 확정된 예약입니다.');
      }

      await connection.execute(
        'UPDATE reservations SET status = "SUCCESS" WHERE id = ?',
        [dbReservationId]
      );

      await connection.commit();

      // 3. Redis 유저 예약 상태 업데이트 (SUCCESS로 변경하고 1일 유지)
      await redis.set(userKey, 'SUCCESS', 'EX', 86400);

      // 4. 예매 완료 이메일 발송용 SQS 메시지 전송
      if (config.aws.mailQueueUrl) {
        try {
          const mailPayload = JSON.stringify({
            to: userEmail,
            subject: `[열차 예매 완료] ${userName}님, 승차권 결제가 완료되었습니다.`,
            message: `안녕하세요 ${userName} 고객님,\n\n승차권 결제 및 예매가 완료되었습니다.\n\n[예매 상세 정보]\n- 예약 번호: ${reservationId}\n- 열차 정보: ${trainId}번 열차\n- 구간: ${startStation} -> ${endStation}\n\n즐거운 여행 되시길 바랍니다!`
          });

          await sqsClient.send(new SendMessageCommand({
            QueueUrl: config.aws.mailQueueUrl,
            MessageBody: mailPayload
          }));
          console.log(`✅ SQS 알림 큐로 예매 완료 메일 요청 전송 완료! (User: ${userEmail})`);
        } catch (sqsErr) {
          console.error('⚠️ 알림 SQS 전송 중 실패 (결제 완료 상태이므로 에러는 무시하고 진행):', sqsErr.message);
        }
      }

      res.json({ success: true, message: '예약이 성공적으로 확정되었습니다.', reservationId });

    } catch (dbErr) {
      await connection.rollback();
      console.error('❌ DB 트랜잭션 오류:', dbErr.message);
      res.status(400).json({ message: dbErr.message || '예약 확정 처리 중 오류가 발생했습니다.' });
    } finally {
      connection.release();
    }

  } catch (err) {
    console.error('서버 에러:', err);
    res.status(500).json({ message: '서버 내부 오류가 발생했습니다.' });
  }
});

// 사용자의 예매 내역 전체 조회 API
app.get('/api/reservations', authMiddleware, async (req, res) => {
  const userId = req.userId; // authMiddleware에서 파싱된 cognito_sub 또는 mock_sub
  try {
    const [rows] = await pool.execute(`
      SELECT 
        r.id AS reservation_id,
        r.reservation_uuid, 
        r.start_station, 
        r.end_station, 
        r.status, 
        r.created_at,
        r.passenger_count,
        t.train_number, 
        t.departure_date, 
        t.departure_time, 
        t.arrival_time
      FROM reservations r
      JOIN trains t ON r.train_id = t.id
      WHERE r.user_id = (SELECT id FROM users WHERE cognito_sub = ? LIMIT 1)
      ORDER BY r.created_at DESC
    `, [userId]);

    res.json(rows);
  } catch (err) {
    console.error('❌ 예매 내역 조회 오류:', err);
    res.status(500).json({ message: '예매 내역 조회 중 서버 오류가 발생했습니다.' });
  }
});

// 🟢 평상시 및 비상시(Azure) 로그인 없이 단건 예매 정보만 확인하는 API
app.post('/api/reservations/guest-lookup', async (req, res) => {
  const { email, reservationId } = req.body;

  if (!email || !reservationId) {
    return res.status(400).json({ message: '예매 시 사용한 이메일과 예약 번호를 입력해주세요.' });
  }

  try {
    const [rows] = await pool.execute(`
      SELECT 
        r.id AS reservation_id,
        r.reservation_uuid, 
        r.start_station, 
        r.end_station, 
        r.status, 
        r.created_at,
        r.passenger_count,
        t.train_number, 
        t.departure_date, 
        t.departure_time, 
        t.arrival_time,
        u.name AS passenger_name
      FROM reservations r
      JOIN trains t ON r.train_id = t.id
      JOIN users u ON r.user_id = u.id
      WHERE r.reservation_uuid = ? AND u.email = ? AND r.status = 'SUCCESS'
      LIMIT 1
    `, [reservationId, email]);

    if (rows.length === 0) {
      return res.status(404).json({ message: '일치하는 결제 완료 내역이 없거나 정보가 올바르지 않습니다.' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('❌ 예매 정보 조회 오류:', err);
    res.status(500).json({ message: '예매 정보 조회 중 서버 오류가 발생했습니다.' });
  }
});

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 코레일 다중구간 예매 서버가 포트 ${PORT}에서 실행 중입니다.`);
  console.log(`==================================================`);
  console.log(`==================================================`);
});