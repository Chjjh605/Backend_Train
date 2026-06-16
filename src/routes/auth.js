const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../db');
const config = require('../config');

// AWS Cognito JWT 검증 Verifier
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

// 아이디로 이메일 조회 API (Cognito 이메일 로그인 우회용)
router.get('/lookup', async (req, res) => {
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
router.post('/signup', async (req, res) => {
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
router.post('/login', async (req, res) => {
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
router.get('/config', (req, res) => {
  const isMock = process.env.USE_MOCK_AUTH === 'true' || !verifier;
  res.json({
    mockMode: isMock,
    region: config.aws.region,
    userPoolId: isMock ? null : config.aws.userPoolId,
    clientId: isMock ? null : config.aws.clientId,
  });
});

module.exports = { router, authMiddleware };
