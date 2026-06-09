const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const mysql = require('mysql2/promise');
const config = require('./config'); // 중앙 설정 파일 로드

// MySQL DB 커넥션 풀 생성
const pool = mysql.createPool({
  host: config.db.host,
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
  // 테스트용 환경변수가 true면 의도적으로 500 에러를 뱉어 장애를 연출
  if (process.env.HEALTH_FAIL === 'true') {
    return res.status(500).send('FAIL');
  }
  res.status(200).send('OK');
});

// Redis 캐시 서버 연결
const redis = new Redis.Cluster([
  {
    host: config.redis.host,
    port: config.redis.port
  }
]);

// AWS SQS 클라이언트 세팅
const sqsClient = new SQSClient({
  region: config.aws.region
});
const SQS_QUEUE_URL = config.aws.sqsQueueUrl;

redis.on('connect', () => console.log('⚡ Redis 캐시 서버 연결 완료!'));

redis.defineCommand('reserveSeat', {
  numberOfKeys: 2,
  lua: `
    if redis.call('EXISTS', KEYS[2]) == 1 then return -2 end
    if not redis.call('GET', KEYS[1]) or tonumber(redis.call('GET', KEYS[1])) <= 0 then return -1 end
    redis.call('DECR', KEYS[1])
    redis.call('SET', KEYS[2], 'PENDING', 'EX', 300)
    return 1
  `
});

// 예매 API (DB 직접 저장이 아닌 SQS로 전송)
app.post('/api/reserve', async (req, res) => {
  const { userId, trainId } = req.body;
  let isReservedInRedis = false;
  try {

    // 1. Redis 수량 차감 및 중복 체크
    const result = await redis.reserveSeat(`{train:${trainId}}:seats`, `{train:${trainId}}:user:${userId}`);
    if (result === -1) return res.status(400).json({ message: '매진' });
    if (result === -2) return res.status(400).json({ message: '이미 예약됨' });
    isReservedInRedis = true; // Redis 예약 성공 표시

    // 2. SQS 메시지 전송
    const messageBody = JSON.stringify({ userId, trainId, status: 'PENDING', timestamp: Date.now() });
    const command = new SendMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MessageBody: messageBody,
    });
    await sqsClient.send(command);
    res.json({ success: true, message: '예약 요청이 대기열에 등록되었습니다.' });
  } catch (err) {
    console.error('❌ 예약 요청 처리 중 에러 발생:', err);

    // 3. [롤백 로직] Redis 예약은 성공했으나 SQS 전송에 실패했을 때 원상 복구
    if (isReservedInRedis) {
      console.log(`🔄 [Rollback] SQS 전송 실패로 인해 Redis 상태를 롤백합니다. (User: ${userId}, Train: ${trainId})`);
      const rollbackPipeline = redis.pipeline();
      rollbackPipeline.incr(`{train:${trainId}}:seats`);              // 좌석 복구
      rollbackPipeline.del(`{train:${trainId}}:user:${userId}`);      // 예약 대기 상태 해제
      await rollbackPipeline.exec();
    }
    res.status(500).json({ message: '예약 요청 실패 (서버 에러)' });
  }
});

// Redis 열차 조회 API
app.get('/api/trains/:trainId', async (req, res) => {
  const { trainId } = req.params;
  try {

    // 1. Redis 캐시 조회
    let seats = await redis.get(`{train:${trainId}}:seats`);
    if (seats === null) {
      console.log(`ℹ️ Cache Miss - DB에서 열차 ${trainId} 데이터를 로드합니다.`);

      // 2. 캐시 미스 시 DB에서 데이터 조회
      const [rows] = await pool.execute(
        'SELECT available_seats FROM trains WHERE id = ?',
        [trainId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ message: "존재하지 않는 열차입니다." });
      }
      seats = rows[0].available_seats;

      // 3. Redis 캐시에 다시 쓰기 (만료 시간 설정 권장, 예: 1시간)
      await redis.set(`{train:${trainId}}:seats`, seats, 'EX', 3600);
    }
    res.json({ trainId, availableSeats: parseInt(seats, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "조회 중 에러 발생" });
  }
});

// 예약 확정 (결제 완료) API
app.post('/api/reserve/confirm', async (req, res) => {
  const { userId, trainId } = req.body;

  if (!userId || !trainId) {
    return res.status(400).json({ message: 'userId와 trainId가 필요합니다.' });
  }

  const userKey = `{train:${trainId}}:user:${userId}`;

  try {
    // 1. Redis에서 임시 예약 상태 확인
    const status = await redis.get(userKey);
    if (!status) {
      return res.status(400).json({ message: '예약 대기 시간이 만료되었거나 예약 요청 내역이 없습니다.' });
    }
    if (status === 'SUCCESS') {
      return res.status(400).json({ message: '이미 확정된 예약입니다.' });
    }
    if (status !== 'PENDING') {
      return res.status(400).json({ message: '유효하지 않은 예약 상태입니다.' });
    }

    // 2. MySQL DB에서 예약 확정 및 좌석 실차감 트랜잭션 처리
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // DB 상에 PENDING 상태의 예약이 존재하는지 확인 및 ID 획득
      const [reservations] = await connection.execute(
        'SELECT id FROM reservations WHERE user_id = ? AND train_id = ? AND status = "PENDING" LIMIT 1',
        [userId, trainId]
      );

      if (reservations.length === 0) {
        // SQS 비동기 처리가 밀려 DB에 아직 저장되지 않았을 경우를 고려
        throw new Error('예약 요청이 아직 처리 중입니다. 잠시 후 다시 결제를 시도해 주세요.');
      }

      const reservationId = reservations[0].id;

      // A. reservations 테이블 status 변경 (PENDING -> SUCCESS)
      await connection.execute(
        'UPDATE reservations SET status = "SUCCESS" WHERE id = ?',
        [reservationId]
      );

      await connection.commit();

      // 3. Redis 유저 예약 상태 업데이트 (SUCCESS로 변경하고 하루 동안 유지)
      await redis.set(userKey, 'SUCCESS', 'EX', 86400);

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
  console.log(`🚀 코레일 예매 서버(SQS 연동 버전)가 포트 ${PORT}에서 실행 중입니다.`);
  console.log(`==================================================`);
});