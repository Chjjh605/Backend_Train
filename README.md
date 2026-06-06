
## ⚙️ 로컬 개발 환경 실행 가이드 -> AWS RDS연동이면 할 필요 없습니다

로컬에서 소스 코딩 후 동작 확인 및 디버깅을 하기 위한 가이드입니다.

### 1) 의존성 라이브러리 설치
```bash
npm install
```

### 2) 로컬 데이터베이스 및 캐시 구동 (Docker)
로컬에 MySQL(3306 포트)과 Redis(6379 포트)를 실행합니다. 실행 시 `init.sql`에 정의된 테이블 스키마와 테스트용 데이터가 자동으로 세팅됩니다.
```bash
# 로컬 인프라 백그라운드 기동
docker-compose up -d

# 인프라 종료 및 데이터 초기화 (볼륨 삭제)
docker-compose down -v
```

### 3) 백엔드 어플리케이션 실행

#### ■ API 웹서버 실행 (Express)
사용자의 열차 조회 및 예약 접수/확정 API를 가동합니다. (기본 포트: 8080)
```bash
npm start
```

#### ■ 백그라운드 워커 실행 (SQS & DB)
SQS 대기열의 예약을 감시하여 DB에 적재하고, 5분이 경과한 미결제 PENDING 예약을 자동 만료 처리하는 스케줄러를 가동합니다.
```bash
npm run worker
```

---

## 🔑 환경 변수 설정 (.env)

프로젝트 루트 디렉토리에 `.env` 파일을 생성하여 아래와 같이 환경 설정을 지정합니다. (로컬 기본 구동용 예시)

```env
PORT=8080
HEALTH_FAIL=false

# AWS SQS 설정
AWS_REGION=ap-northeast-2
SQS_QUEUE_URL=your-aws-sqs-queue-url  # 실제 AWS SQS 주소 연동 시 기입

# MySQL 데이터베이스 설정
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=rootpassword
DB_NAME=trail_db

# Redis 캐시 설정
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
```

---

## 📂 프로젝트 폴더 구조

```text
Backend_Train/
├── src/
│   ├── app.js          # Express API 웹서버 (조회, 예매 접수 및 확정 API)
│   ├── worker.js       # SQS 대기열 감시, MySQL 데이터 적재 및 만료 스케줄러
│   └── config.js       # 환경변수 로딩 및 모듈화 설정 파일
├── docker-compose.yml  # 로컬 테스트용 MySQL & Redis 도커 가동 파일
├── init.sql            # 로컬 DB 최초 실행 시 테이블 자동 생성용 DDL
├── .env                # 환경변수 설정 파일 (로컬 테스트용)
├── package.json        # 패키지 의존성 파일
└── README.md           # 프로젝트 가이드 (본 파일)
```

---

## 🛠️ **협업 및 배포 약속**

백엔드 코드를 동기화하고 변경 사항을 반영할 때는 아래 규칙을 준수해 주세요.

```bash
# 1. 작업 시작 전 원격 저장소 최신화 필수
git pull origin main

# 2. 커밋 메시지 컨벤션 준수 (이름(영문): 작업 요약)
# 예시: git commit -m "whwog: 예약 만료 처리 스케줄러 구현 완료"
git commit -m "이름: 작업 내용 작성"

# 3. 원격 저장소 푸시 및 공유
git push origin main

# 4. 푸시 완료 후 팀 톡방에 공유 알림 남기기!
```
