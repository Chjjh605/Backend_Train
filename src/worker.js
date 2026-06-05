const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const mysql = require('mysql2/promise');
const config = require('./config'); // 중앙 설정 파일 로드

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

            // 2. MySQL DB 저장 (사용자 보유 테이블 및 쿼리)
            await pool.execute(
              'INSERT INTO reservations (user_id, train_id, status) VALUES (?, ?, "PENDING")',
              [body.userId, body.trainId]
            );

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