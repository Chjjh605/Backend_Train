## 🛠 Tech Stack
- **Runtime**: Node.js (Express)
- **Database**: Aurora MySQL (Multi-AZ CQRS) / Azure Database for MySQL (Standby Target)
- **Cache & Concurrency**: Redis (ElastiCache / Cluster mode)
- **Queueing & Event-driven**: AWS SQS (Simple Queue Service)
- **Container**: Docker

---

## ✨ 핵심 아키텍처 및 구현 기여

### 1. Redis Lua Script를 활용한 실시간 좌석 동시성 제어
- 다수의 사용자가 동시에 동일한 기차 좌석을 예매할 때 발생하는 **데이터 레이스(Race Condition) 및 초과 예약(Over-booking) 방지**.
- 좌석 조회가 빈번히 발생하는 구간 세그먼트(서울-대전-대구-부산)의 잔여 재고 관리를 단일 스레드로 작동하는 Redis 상에서 **원자적(Atomic) 연산(Lua Script)**으로 처리하여 정합성 및 속도 확보.

### 2. AWS SQS 기반 이벤트 드리븐 비동기 처리
- 트래픽 폭주 시점(예: 예매 오픈 시간)의 서버 CPU 및 DB 쓰기 부하 격리.
- 임시 예약을 완료한 요청 건을 **AWS SQS 큐로 즉시 적재(Buffering)**한 뒤, 백그라운드 워커(`worker.js`)가 순차적으로 처리하여 DB 커넥션 병목 해소 및 유실 차단.

### 3. Aurora MySQL Multi-AZ CQRS 패턴 및 실시간 복제
- 서비스의 안정적 쓰기(Write) 작업 보장과 빠른 조회(Read) 제공을 위해 **Writer와 Reader DB 엔드포인트를 완전히 분리 설계**.
- AWS Aurora Primary DB의 트랜잭션 로그(Binlog)를 **AWS DMS(Database Migration Service)**를 활용해 재해 복구용 Azure Database for MySQL로 실시간 동기화(CDC).

---

## ⚙️ 로컬 개발 환경 실행 가이드

로컬 PC에서 데이터베이스, 캐시 서버, 대기열 서버와 연동하여 동작을 확인하고 디버깅하기 위한 가이드입니다.

### 1) 의존성 라이브러리 설치
```bash
npm install
```

### 2) 로컬 인프라 구동 (Docker)
MySQL(3306 포트) 및 Redis(6379 포트)를 로컬 백그라운드 환경에 구동합니다. 구동 시 `init.sql` 파일이 자동으로 로드되어 테스트용 스키마 및 데이터가 적용됩니다.
```bash
docker-compose up -d
```

### 3) 로컬 환경변수 설정 (`.env`)
프로젝트 루트 폴더에 `.env` 파일을 복사/생성하여 아래 내용을 입력합니다.
```env
PORT=8080
ALLOWED_ORIGINS=http://localhost:5173
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=admin
DB_PASSWORD=Password123!
DB_NAME=trail_db
AWS_REGION=ap-northeast-2
SQS_QUEUE_URL=mock://local-queue
```
> 💡 `SQS_QUEUE_URL` 값을 입력하지 않거나 `mock://`로 지정하면 로컬 개발 편의를 위해 `mock_sqs_queue.json` 파일을 가상 대기열 큐 파일로 활용하는 **Mock SQS 모드**가 활성화됩니다.

### 4) 어플리케이션 가동

#### ■ API 웹 서버 가동 (Express)
사용자의 열차 조회, 예약 요청 및 확정 API를 기동합니다. (기본 포트: 8080)
```bash
npm run app
```

#### ■ 비동기 이관 처리 워커 가동 (Worker)
가상 대기열(SQS)에 쌓인 예약 건을 폴링하여 MySQL 데이터베이스에 영구 반영하는 데몬을 구동합니다.
```bash
npm run worker
```

### 5) 로컬 환경 정리 (종료 시)
테스트 완료 후 생성된 도커 자원과 임시 데이터를 모두 삭제합니다.
```bash
docker-compose down -v
```

---

## ☁️ AWS EKS 배포 및 연동 가이드

테라폼(`Train_repo`)으로 배포한 실제 AWS 클라우드 환경에 백엔드 서비스를 연계하고 기동하는 방법입니다.

### ⚙️ 배포 및 연동 절차

#### [1단계] 인프라 엔드포인트 확보
테라폼 배포 완료 후 터미널에 출력되는 핵심 엔드포인트들을 확인합니다.
- `aurora_writer_endpoint` (RDS DB 호스트)
- `redis_primary_endpoint` (ElastiCache 호스트)
- `sqs_queue_url` (실제 AWS SQS 대기열 주소)

#### [2단계] Docker 이미지 빌드 및 AWS ECR 푸시
수정된 소스코드를 가벼운 Alpine Node.js 이미지 기반으로 컨테이너화하여 AWS ECR 저장소로 푸시합니다.
```bash
# 1. AWS CLI를 통한 ECR 로그인 인증 획득
aws ecr get-login-password --region ap-northeast-2 | docker login --username AWS --password-stdin 009152047332.dkr.ecr.ap-northeast-2.amazonaws.com

# 2. 로컬 Docker 이미지 빌드 (Backend 폴더 루트에서 실행)
docker build -t train-backend .

# 3. ECR 저장소 경로로 업로드용 이미지 태그 지정
docker tag train-backend:latest 009152047332.dkr.ecr.ap-northeast-2.amazonaws.com/train-backend:latest

# 4. AWS ECR 레포지토리로 컨테이너 이미지 푸시
docker push 009152047332.dkr.ecr.ap-northeast-2.amazonaws.com/train-backend:latest
```

#### [3단계] AWS EKS 연결 설정
로컬 터미널의 쿠버네티스 연결 컨텍스트를 업데이트합니다.
```bash
aws eks update-kubeconfig --region ap-northeast-2 --name team-train-dev-eks
```

#### [4단계] SQS 권한용 ServiceAccount 생성 및 적용
`service-account.yaml`을 생성하고 테라폼이 출력한 `booking_pod_role_arn` 값을 annotation으로 기입한 뒤 클러스터에 배포합니다.
```bash
kubectl apply -f service-account.yaml
```

#### [5단계] 백엔드 및 워커 컨테이너 배포
1. `backend-deployment.yaml`과 `worker-deployment.yaml` 파일의 환경변수(`env`) 설정 영역에 RDS, Redis, SQS 엔드포인트 주소들을 입력합니다.
2. EKS 클러스터에 배포 명령을 실행하거나, 이미 구동 중인 파드를 새 이미지로 롤링 업데이트합니다.
   ```bash
   # 최초 배포 시 실행
   kubectl apply -f backend-deployment.yaml
   kubectl apply -f worker-deployment.yaml

   # 이미지 업데이트 후 EKS의 백엔드 컨테이너 롤링 재시작 시 실행
   kubectl rollout restart deployment train-backend
   ```

---

## 📂 프로젝트 폴더 구조

```text
Backend/
├── src/
│   ├── app.js          # Express API 웹서버 (조회, 예매 접수 및 확정)
│   ├── worker.js       # SQS 대기열 감시, MySQL 데이터 적재 및 만료 스케줄러
│   └── config.js       # 환경변수 로딩 및 중앙 설정 파일
├── docker-compose.yml  # 로컬 테스트용 MySQL & Redis 도커 가동 파일
├── init.sql            # 로컬 DB 최초 실행 시 테이블 자동 생성용 DDL
├── .env                # 환경변수 설정 파일 (로컬 테스트용, Git 커밋에서 제외)
├── .dockerignore       # 도커 빌드 시 무시할 폴더 및 자격증명 정의
├── package.json        # 패키지 의존성 파일
└── README.md           # 프로젝트 실행 및 아키텍처 가이드 (본 파일)
```

---

## 🛠️ 협업 및 배포 규칙

팀 프로젝트 코드를 푸시할 때 아래 규칙을 철저히 지켜주세요.

```bash
# 1. 작업 시작 전 항상 최신 코드로 풀(Pull)을 받아 변경사항을 싱크합니다.
git pull origin main

# 2. 작업 완료 후 커밋 시 아래 템플릿 형태로 작성합니다.
git commit -m "JH: 예약 로직 유저 ID 정합성 수정 및 예외 처리 보강"

# 3. 원격 저장소에 푸시 후 팀원들에게 알립니다.
git push origin main
```
