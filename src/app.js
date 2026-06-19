const express = require('express');
const cors = require('cors');
const config = require('./config');
const { ensureUserColumns } = require('./db');
const { router: authRouter } = require('./routes/auth');
const trainRouter = require('./routes/train');

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
  res.status(200).json({
    status: 'OK',
    readOnlyMode: process.env.READ_ONLY_MODE || 'undefined'
  });
});

// 라우터 마운트
app.use('/api/auth', authRouter);
app.use('/api', trainRouter);

// DB 스키마 자동 업그레이드
ensureUserColumns();

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 코레일 다중구간 예매 서버가 포트 ${PORT}에서 실행 중입니다.`);
  console.log(`==================================================`);
});