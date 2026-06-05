const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const config = require('./config'); // 중앙 설정 파일 로드

// Redis 캐시 서버 연결
const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port
});

redis.on('connect', () => console.log('⚡ Worker: Redis 캐시 서버 연결 완료!'));

// AWS SQS 및 MySQL DB 세팅
const sqsClient = new SQSClient({ region: config.aws.region });
const SQS_QUEUE_URL = config.aws.sqsQueueUrl;

const pool = mysql.createPool({
  host: config.db.host,
  user: config.db.user,
  password: config.db.password,
  database: config.db.name,
  connectionLimit: 20 // pod 갯수 * 커넥션리밋 = 총 커넥션
});

// 무한 루프로 SQS 감시 및 DB 저장
async function pollMessages() {
  console.log('👀 Worker 서버가 SQS 우체통 감시를 시작합니다...');

  while (true) {
    try {
      // [STEP 1] SQS에서 메시지 꺼내오기
      const data = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MaxNumberOfMessages: 10, // 최대갯수 = 10
        WaitTimeSeconds: 20 // 20초 동안 큐에 데이터가 들어오길 기다림 (롱 폴링 비용 절감)
      }));

      if (data.Messages && data.Messages.length > 0) {
        for (const msg of data.Messages) {
          try {
            // 1. 메시지 바디 파싱
            const body = JSON.parse(msg.Body);
            console.log(`📦 SQS 메시지 수신 완료: 유저 ${body.userId}님의 열차 ${body.trainId} 예매 건`);

            // 2. MySQL DB 저장 (트랜잭션 적용)
            const connection = await pool.getConnection();

            try {
              await connection.beginTransaction();

              // A. 예약 내역 삽입
              await connection.execute(
                'INSERT INTO reservations (user_id, train_id, status) VALUES (?, ?, "PENDING")',
                [body.userId, body.trainId]
              );
              // B. trains 테이블 실제 잔여 좌석 차감 (available_seats > 0 검증 포함)
                          const [updateResult] = await connection.execute(
                'UPDATE trains SET available_seats = available_seats - 1 WHERE id = ? AND available_seats > 0',
                [body.trainId]
              );
              if (updateResult.affectedRows === 0) {
                // 실제 DB 상의 잔여 좌석이 부족한 비정상 케이스 (정합성 에러)
                throw new Error(`열차(${body.trainId})의 DB 잔여 좌석이 부족합니다.`);
              }
              await connection.commit();
              console.log(`✅ DB 예약 생성 및 좌석 차감 완료 (User: ${body.userId}, Train: ${body.trainId})`);
            } catch (dbErr) {
              await connection.rollback();
              throw dbErr; // 예외를 던져 SQS에서 메시지가 삭제되지 않고 재처리되도록 유도
            } finally {
              connection.release(); // 커넥션 풀 반납
            }

            // 3. 처리가 정상적으로 끝나면 SQS에서 영수증을 파기해 메시지 제거 (중복 처리 방지)
            await sqsClient.send(new DeleteMessageCommand({
              QueueUrl: SQS_QUEUE_URL,
              ReceiptHandle: msg.ReceiptHandle
            }));

            console.log(`✅ DB 저장 완료 및 SQS 영수증 파기 성공!`);
          } catch (msgError) {
            // 특정 개별 메시지 처리 중 오류가 나도 로그만 남기고 루프가 지속됨
            console.error(`❌ 개별 메시지 처리 중 에러 발생 (MessageId: ${msg.MessageId}):`, msgError.message);
            // SQS에서 DeleteMessageCommand가 호출되지 않으므로, 이 메시지는 대기열에 유지되어 다시 재처리 기회를 가집니다.
          }
        }
      }
    } catch (error) {
      // 바깥쪽 에러는 대기열 메시지 처리 실패가 아니라 SQS 연결 오류 등이므로 로그만 찍고 넘어감
      console.error('❌ Worker 서버 작동 중 에러 발생:', error.message);
    }
  }
}

// Worker 실행
pollMessages();

// 만료 예약 정리 함수 (5분 경과한 PENDING 건을 CANCELLED로 변경하고 좌석 수 복구)
async function cleanupExpiredReservations() {
  console.log('🧹 [Scheduler] 만료된 PENDING 예약을 검색합니다...');

  let connection;
  try {
    connection = await pool.getConnection();

    // 1. 5분이 지난 PENDING 예약 내역 조회 (NOW()와 created_at 비교)
    const [expiredRows] = await connection.execute(
      `SELECT id, user_id, train_id FROM reservations 
       WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL 5 MINUTE`
    );

    if (expiredRows.length === 0) {
      return;
    }

    console.log(`🧹 [Scheduler] 만료 대상 예약 발견: ${expiredRows.length}건`);

    for (const reservation of expiredRows) {
      const { id, user_id, train_id } = reservation;
      
      await connection.beginTransaction();
      try {
        // A. DB 상태 업데이트 (PENDING -> CANCELLED)
        await connection.execute(
          "UPDATE reservations SET status = 'CANCELLED' WHERE id = ?",
          [id]
        );

        // B. DB 실제 좌석 수 복구 (+1)
        await connection.execute(
          "UPDATE trains SET available_seats = available_seats + 1 WHERE id = ?",
          [train_id]
        );

        // C. Redis 복구 (좌석 수 +1, 유저 임시 키 삭제)
        const userKey = `train:${train_id}:user:${user_id}`;
        const seatKey = `train:${train_id}:seats`;

        const pipeline = redis.pipeline();
        pipeline.incr(seatKey);
        pipeline.del(userKey);
        await pipeline.exec();

        await connection.commit();
        console.log(`✅ [Scheduler] 예약 만료 처리 완료: 예약 ID ${id} (User: ${user_id}, Train: ${train_id})`);
      } catch (err) {
        await connection.rollback();
        console.error(`❌ [Scheduler] 예약 ID ${id} 만료 처리 중 오류 발생:`, err.message);
      }
    }

  } catch (err) {
    console.error('❌ [Scheduler] 만료 예약 정리 중 에러 발생:', err.message);
  } finally {
    if (connection) connection.release();
  }
}

// 1분(60,000ms)마다 스케줄러 실행
setInterval(cleanupExpiredReservations, 60000);