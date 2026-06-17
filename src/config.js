const path = require('path');
// 로컬 개발 환경에서만 .env 파일을 읽어오도록 설정
require('dotenv').config({ path: path.join(__dirname, '../.env') });

module.exports = {
  port: process.env.PORT || 8080,
  allowedOrigins: process.env.ALLOWED_ORIGINS, // AWS 배포 환경에서는 환경변수 필수 주입
  aws: {
    region: process.env.AWS_REGION || 'ap-northeast-2',
    sqsQueueUrl: process.env.SQS_QUEUE_URL,
    mailQueueUrl: process.env.MAIL_QUEUE_URL,
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    clientId: process.env.COGNITO_CLIENT_ID
  },
  db: {
    host: process.env.DB_HOST, // AWS RDS 연결을 위해 필수 주입
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    name: process.env.DB_NAME || 'trail_db'
  },
  redis: {
    host: process.env.REDIS_HOST, // AWS ElastiCache 연결을 위해 필수 주입
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_AUTH_TOKEN
  }
};
