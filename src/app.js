const express = require('express');
const Redis = require('ioredis');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const config = require('./config'); // 중앙 설정 파일 로드

const app = express();
app.use(express.json());

// Route 53 헬스체크용 엔드포인트
app.get('/health', (req, res) => {
  // 테스트용 환경변수가 true면 의도적으로 500 에러를 뱉어 장애를 연출
  if (process.env.HEALTH_FAIL === 'true') {
    return res.status(500).send('FAIL');
  }
  res.status(200).send('OK');
});

// Redis 연결
const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port
});

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

  try {
    // Redis에서 수량 차감 및 중복 체크
    const result = await redis.reserveSeat(`train:${trainId}:seats`, `train:${trainId}:user:${userId}`);

    if (result === -1) return res.status(400).json({ message: '매진' });
    if (result === -2) return res.status(400).json({ message: '이미 예약됨' });

    // MySQL 직접 저장을 빼고, AWS SQS로 메시지 전송
    const messageBody = JSON.stringify({ userId, trainId, status: 'PENDING', timestamp: Date.now() });

    const command = new SendMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MessageBody: messageBody,
    });

    await sqsClient.send(command);

    // 유저에게는 예약 접수로 응답 (실제 DB 저장은 백그라운드에서 진행)
    res.json({ success: true, message: '예약 요청이 SQS 대기열에 등록되었습니다.' });

  } catch (err) {
    console.error('서버 에러:', err);
    res.status(500).json({ message: '에러 발생' });
  }
});

// Redis 열차 조회 API
app.get('/api/trains/:trainId', async (req, res) => {
  const { trainId } = req.params;
  try {
    // 1. DB로 가지 않고 Redis 캐시에서 먼저 좌석 수량을 조회
    const seats = await redis.get(`train:${trainId}:seats`);

    if (seats === null) {
      // 만약 Redis에 데이터가 없으면 평상시엔 DB에서 긁어와야 하지만, 
      // 인프라 테스트용이므로 임시 값 반환 혹은 데이터 없음 처리
      return res.status(404).json({ message: "열차 정보가 캐시에 없습니다. 초기화가 필요합니다." });
    }

    res.json({ trainId, availableSeats: parseInt(seats) });
  } catch (err) {
    res.status(500).json({ message: "조회 중 에러 발생" });
  }
});

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 코레일 예매 서버(SQS 연동 버전)가 포트 ${PORT}에서 실행 중입니다.`);
  console.log(`==================================================`);
});