const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const config = require('./config'); // 중앙 설정 파일 로드

// Redis 캐시 서버 연결 (로컬 개발 환경에서는 단일 노드, AWS EKS 배포 환경에서는 Cluster 모드로 가동)
const isLocalRedis = config.redis.host === '127.0.0.1' || config.redis.host === 'localhost';
const redis = isLocalRedis
  ? new Redis({ host: config.redis.host, port: config.redis.port })
  : new Redis.Cluster(
      [{ host: config.redis.host, port: config.redis.port }],
      { 
        redisOptions: { tls: { rejectUnauthorized: false } },
        dnsLookup: (address, callback) => callback(null, address)
      }
    );

redis.on('connect', () => console.log('⚡ Worker: Redis 캐시 서버 연결 완료!'));

// AWS SQS 및 MySQL DB 세팅 (로컬 테스트용 Mock SQS 지원)
const SQS_QUEUE_URL = config.aws.sqsQueueUrl;
const isMockSqs = !SQS_QUEUE_URL || SQS_QUEUE_URL.includes('여기에') || SQS_QUEUE_URL.startsWith('mock://');

let sqsClient;
if (isMockSqs) {
  console.log('☁️ SQS: 로컬 테스트용 Mock SQS 클라이언트를 활성화합니다.');
  const fs = require('fs');
  const path = require('path');
  const queuePath = path.join(__dirname, '../mock_sqs_queue.json');

  if (!fs.existsSync(queuePath)) {
    fs.writeFileSync(queuePath, JSON.stringify([]));
  }

  sqsClient = {
    send: async (command) => {
      const input = command.input || {};
      const messages = JSON.parse(fs.readFileSync(queuePath, 'utf8'));

      if (input.MaxNumberOfMessages !== undefined) {
        if (messages.length === 0) {
          return { Messages: [] };
        }
        const max = input.MaxNumberOfMessages || 10;
        const popped = messages.splice(0, max);
        fs.writeFileSync(queuePath, JSON.stringify(messages, null, 2));
        return { Messages: popped };
      }
      else if (input.ReceiptHandle !== undefined) {
        return {};
      }
      return {};
    }
  };
} else {
  sqsClient = new SQSClient({ region: config.aws.region });
}

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.name,
  connectionLimit: 20, // pod 갯수 * 커넥션리밋 = 총 커넥션
  ssl: {
    rejectUnauthorized: false
  }
});

// 정해진 역 순서 정의 (서울 -> 대전 -> 대구 -> 부산)
const STATIONS = ['SEOUL', 'DAEJEON', 'DAEGU', 'BUSAN'];

// 무한 루프로 SQS 감시 및 DB 저장
async function pollMessages() {
  console.log('👀 Worker 서버가 SQS 우체통 감시를 시작합니다...');

  while (!isShuttingDown) {
    try {
      // [STEP 1] SQS에서 메시지 꺼내오기
      const data = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20
      }));

      if (isShuttingDown) break;

      if (data.Messages && data.Messages.length > 0) {
        for (const msg of data.Messages) {
          try {
            // 1. 메시지 바디 파싱
            const body = JSON.parse(msg.Body);
            console.log(`📦 SQS 메시지 수신: 유저 ${body.userId} (열차 ${body.trainId}: ${body.startStation} -> ${body.endStation}) [Res: ${body.reservationId}]`);

            const startIndex = STATIONS.indexOf(body.startStation);
            const endIndex = STATIONS.indexOf(body.endStation);

            if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
              throw new Error('유효하지 않은 구간 정보가 메시지에 포함되어 있습니다.');
            }

            // 2. MySQL DB 저장 (트랜잭션 적용)
            const connection = await pool.getConnection();

            try {
              await connection.beginTransaction();

              // A. 예약 내역 삽입 (구간 정보 및 reservation_uuid 포함)
              await connection.execute(
                'INSERT INTO reservations (reservation_uuid, user_id, train_id, start_station, end_station, status) VALUES (?, ?, ?, ?, ?, "PENDING")',
                [body.reservationId, body.userId, body.trainId, body.startStation, body.endStation]
              );

              // B. trains_segments 테이블 실제 해당 탑승 구간들의 잔여 좌석 각각 차감
              for (let i = startIndex; i < endIndex; i++) {
                const [updateResult] = await connection.execute(
                  'UPDATE train_segments SET available_seats = available_seats - 1 WHERE train_id = ? AND start_station = ? AND end_station = ? AND available_seats > 0',
                  [body.trainId, STATIONS[i], STATIONS[i + 1]]
                );

                if (updateResult.affectedRows === 0) {
                  // DB 상의 특정 구간 잔여 좌석이 부족한 비정상 케이스 (정합성 깨짐)
                  throw new Error(`열차(${body.trainId})의 [${STATIONS[i]}-${STATIONS[i + 1]}] 구간 잔여 좌석이 부족합니다.`);
                }
              }

              await connection.commit();
              console.log(`✅ DB 예약 생성 및 구간별 좌석 차감 완료 (User: ${body.userId}, Train: ${body.trainId})`);
            } catch (dbErr) {
              await connection.rollback();
              console.error(`❌ DB 트랜잭션 오류로 인해 롤백 처리합니다. (User: ${body.userId}, Train: ${body.trainId}):`, dbErr.message);

              // 외래키 제약조건 위반(1452) 또는 중복 키 에러(1062) 등 재시도가 무의미한 영구적 에러인 경우 SQS에서 메시지 파기 (Poison Pill 방지)
              if (dbErr.errno === 1452 || dbErr.errno === 1062 || dbErr.code === 'ER_NO_REFERENCED_ROW_2' || dbErr.code === 'ER_DUP_ENTRY') {
                // Redis 차감 상태 및 임시 예약 키 롤백 (영구적 실패이므로 상태 복구)
                const userKey = `{train:${body.trainId}}:user:${body.userId}:${body.reservationId}`;
                const rollbackPipeline = redis.pipeline();
                for (let i = startIndex; i < endIndex; i++) {
                  rollbackPipeline.incr(`{train:${body.trainId}}:${STATIONS[i]}-${STATIONS[i + 1]}`);
                }
                rollbackPipeline.del(userKey);
                await rollbackPipeline.exec();
                console.log(`🔄 [Rollback] 영구적인 DB 오류로 인해 Redis 상태 복구를 성공적으로 처리했습니다.`);

                console.warn(`⚠️ 영구적인 DB 오류가 감지되어 SQS 메시지를 큐에서 영구 삭제합니다. (MessageId: ${msg.MessageId})`);
                await sqsClient.send(new DeleteMessageCommand({
                  QueueUrl: SQS_QUEUE_URL,
                  ReceiptHandle: msg.ReceiptHandle
                }));
              } else {
                // 커넥션 풀 부족, 타임아웃 등 일시적인 장애는 throw하여 SQS 메시지가 재시도(Retry)될 수 있도록 함 (이때 Redis 상태는 유지)
                throw dbErr;
              }
            } finally {
              connection.release(); // 커넥션 풀 반납
            }

            // 3. 정상 종료 시 SQS 영수증 파기 (메시지 삭제)
            await sqsClient.send(new DeleteMessageCommand({
              QueueUrl: SQS_QUEUE_URL,
              ReceiptHandle: msg.ReceiptHandle
            }));

            console.log(`✅ DB 저장 완료 및 SQS 영수증 파기 성공!`);
          } catch (msgError) {
            console.error(`❌ 개별 메시지 처리 중 에러 발생 (MessageId: ${msg.MessageId}):`, msgError.message);
          }
        }
      }
    } catch (error) {
      if (isShuttingDown) {
        console.log('🔌 DB 커넥션 종료에 따른 폴링 루프 중단.');
        break;
      }
      console.error('❌ Worker 서버 작동 중 에러 발생:', error.message);
    }
  }
}

// worker.js 종료 처리 핸들러 추가
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 ${signal} 수신. Worker를 안전하게 종료합니다...`);

  try {
    console.log('🔌 DB Connection Pool 종료 중...');
    await pool.end();
    console.log('✅ DB Connection Pool 안전 종료 완료.');
    process.exit(0);
  } catch (err) {
    console.error('❌ 종료 처리 중 에러 발생:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Worker 실행
pollMessages();

// 만료 예약 정리 함수 (5분 경과한 PENDING 건을 CANCELLED로 변경하고 구간 좌석 수 복구)
async function cleanupExpiredReservations() {
  console.log('🧹 [Scheduler] 만료된 PENDING 예약을 검색합니다...');

  let connection;
  try {
    connection = await pool.getConnection();

    // 1. 5분이 지난 PENDING 예약 내역 조회 (구간 정보 및 reservation_uuid 포함)
    const [expiredRows] = await connection.execute(
      `SELECT id, reservation_uuid, user_id, train_id, start_station, end_station FROM reservations 
       WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL 5 MINUTE`
    );

    if (expiredRows.length === 0) {
      return;
    }

    console.log(`🧹 [Scheduler] 만료 대상 예약 발견: ${expiredRows.length}건`);

    for (const reservation of expiredRows) {
      const { id, reservation_uuid, user_id, train_id, start_station, end_station } = reservation;

      await connection.beginTransaction();
      try {
        // A. DB 상태 업데이트 (PENDING -> CANCELLED)
        await connection.execute(
          "UPDATE reservations SET status = 'CANCELLED' WHERE id = ?",
          [id]
        );

        // B. DB 실제 탑승한 세그먼트 좌석 수 복구 (+1)
        const startIndex = STATIONS.indexOf(start_station);
        const endIndex = STATIONS.indexOf(end_station);

        for (let i = startIndex; i < endIndex; i++) {
          await connection.execute(
            "UPDATE train_segments SET available_seats = available_seats + 1 WHERE train_id = ? AND start_station = ? AND end_station = ?",
            [train_id, STATIONS[i], STATIONS[i + 1]]
          );
        }

        // C. Redis 복구 (해당 탑승 구간들의 Redis 키 좌석 수 +1, 유저 임시 키 삭제)
        const userKey = `{train:${train_id}}:user:${user_id}:${reservation_uuid}`;
        const pipeline = redis.pipeline();

        for (let i = startIndex; i < endIndex; i++) {
          pipeline.incr(`{train:${train_id}}:${STATIONS[i]}-${STATIONS[i + 1]}`);
        }
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