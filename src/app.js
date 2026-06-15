const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const mysql = require('mysql2/promise');
const config = require('./config'); // 중앙 설정 파일 로드

// MySQL DB 커넥션 풀 생성 (Azure SSL 접속 대응)
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.name,
  connectionLimit: 10,
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

// Route 53 헬스체크용 엔드포인트
app.get('/health', (req, res) => {
  if (process.env.HEALTH_FAIL === 'true') {
    return res.status(500).send('FAIL');
  }
  res.status(200).send('OK');
});

// Redis 캐시 서버 연결 (AWS EKS 배포 환경 - ElastiCache Redis Cluster TLS 연결)
const redis = new Redis.Cluster(
  [{ host: config.redis.host, port: config.redis.port }],
  {
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
  
  if redis.call('EXISTS', userKey) == 1 then
    return -2
  end
  
  for i = 2, #KEYS do
    local key = KEYS[i]
    local seats = redis.call('GET', key)
    if not seats or tonumber(seats) <= 0 then
      return -1
    end
  end
  
  for i = 2, #KEYS do
    local key = KEYS[i]
    redis.call('DECR', key)
  end
  
  redis.call('SET', userKey, 'PENDING', 'EX', expireTime)
  return 1
`;

// 예매 API (구간별 수량 차감 연동 방식)
app.post('/api/reserve', async (req, res) => {
  if (process.env.READ_ONLY_MODE === 'true') {
    return res.status(403).json({ message: '현재 시스템은 재해 복구(DR) 대기 모드입니다. 조회 서비스만 이용 가능합니다.' });
  }

  const { userId, trainId, startStation, endStation } = req.body;

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
    const result = await redis.eval(MULTI_RESERVE_LUA, segmentKeys.length + 1, userKey, ...segmentKeys, 300);

    if (result === -1) return res.status(400).json({ message: '매진 (일부 구간 좌석 매진)' });
    if (result === -2) return res.status(400).json({ message: '이미 예약 진행 중' });

    isReservedInRedis = true; // Redis 예약 성공 표시

    // 4. SQS 메시지 전송 (구간 정보 및 reservationId 포함)
    const messageBody = JSON.stringify({
      reservationId,
      userId: dbUserId, // SQS에는 DB의 숫자형 유저 ID를 발송
      trainId,
      startStation,
      endStation,
      status: 'PENDING',
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

    // 5. [롤백 로직] Redis 예약은 성공했으나 SQS 실패 시 모든 세그먼트 좌석 원상 복구
    if (isReservedInRedis) {
      console.log(`🔄 [Rollback] SQS 전송 실패로 인해 Redis 상태를 롤백합니다. (User: ${dbUserId}, Train: ${trainId}, Res: ${reservationId})`);
      const rollbackPipeline = redis.pipeline();
      for (const key of segmentKeys) {
        rollbackPipeline.incr(key);
      }
      rollbackPipeline.del(userKey);
      await rollbackPipeline.exec();
    }
    res.status(500).json({ message: '예약 요청 실패 (서버 에러)' });
  }
});

// 열차 조회 API (구간별 잔여석의 최솟값 계산 방식)
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
      // Redis 조회 실패 시 캐시 미스로 처리하여 DB 쿼리로 폴백
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

      // Redis가 연결되어 있을 때만 캐시 쓰기 파이프라인 수행
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
        // 캐시 실패 시 메모리상에서 직접 최솟값 계산
        minSeats = Infinity;
        rows.forEach(row => {
          if (row.available_seats < minSeats) {
            minSeats = row.available_seats;
          }
        });
      }

      finalAvailableSeats = minSeats;

    } else {
      // 캐시 히트 시 가져온 잔여석 값 중 최솟값(Minimum)이 예매 가능 수량이 됨
      finalAvailableSeats = Math.min(...seatValues.map(val => parseInt(val, 10)));
    }

    res.json({
      trainId,
      startStation,
      endStation,
      availableSeats: finalAvailableSeats
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "조회 중 에러 발생" });
  }
});

// 예약 확정 (결제 완료) API
app.post('/api/reserve/confirm', async (req, res) => {
  if (process.env.READ_ONLY_MODE === 'true') {
    return res.status(403).json({ message: '현재 시스템은 재해 복구(DR) 대기 모드입니다. 결제 및 예매 확정이 불가능합니다.' });
  }

  const { userId, trainId, reservationId } = req.body;

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

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 코레일 다중구간 예매 서버가 포트 ${PORT}에서 실행 중입니다.`);
  console.log(`==================================================`);
});