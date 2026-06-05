const path = require('path');
// 로컬 개발 환경에서만 .env 파일을 읽어오도록 설정
require('dotenv').config({ path: path.join(__dirname, '../.env') });

module.exports = {
  port: process.env.PORT || 8080,
  aws: {
    region: process.env.AWS_REGION || 'ap-northeast-2',
    sqsQueueUrl: process.env.SQS_QUEUE_URL
  },
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'rootpassword',
    name: process.env.DB_NAME || 'trail_db'
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379
  }
};
