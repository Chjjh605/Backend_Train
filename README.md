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
# 1. AWS CLI를 통한 ECR 로그인 인증 획득 (AWS 계정 프로필 지정)
aws ecr get-login-password --region ap-northeast-2 --profile team | docker login --username AWS --password-stdin 009152047332.dkr.ecr.ap-northeast-2.amazonaws.com

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
aws eks update-kubeconfig --region ap-northeast-2 --name team-train-dev-eks --profile team
```

#### [4단계] 쿠버네티스 환경변수 및 보안 설정 (`env-config.yaml` & `train-secret`)
1. `Train_repo/modules/infra/k8s-manifests/env-config.yaml` 파일의 `data` 영역에 테라폼 아웃풋으로 확인한 `SQS_QUEUE_URL`, `DB_HOST`, `REDIS_HOST` 등의 주소들을 입력합니다.
2. 데이터베이스 접속 인증용 Secret을 생성합니다. (만약 ESO가 설치되어 있지 않다면 아래 명령어를 통해 수동으로 생성해 줍니다.)
   ```bash
   kubectl create secret generic train-secret --from-literal=DB_PASSWORD="Password123!" --from-literal=DB_USER="admin" --dry-run=client -o yaml | kubectl apply -f -
   ```
> 💡 EKS용 ServiceAccount(`booking-sa`)는 테라폼 배포 단계(`eks_network.tf`)에서 자동으로 생성되므로 별도로 생성할 필요가 없습니다.

#### [5단계] 백엔드 및 워커 컨테이너 배포
1. `Train_repo/modules/infra/k8s-manifests` 폴더로 이동한 후, 쿠버네티스 매니페스트 파일들을 클러스터에 일괄 배포합니다.
   ```bash
   kubectl apply -f .
   ```
2. 이미 배포된 상태에서 소스코드가 수정되어 새 이미지로 롤링 업데이트가 필요한 경우, 아래 명령어를 실행하여 파드를 재시작합니다.
   ```bash
   kubectl rollout restart deployment train-backend
   kubectl rollout restart deployment train-worker
   ```

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
SQS_QUEUE_URL=https://sqs.ap-northeast-2.amazonaws.com/009152047332/reservation-queue
MAIL_QUEUE_URL=https://sqs.ap-northeast-2.amazonaws.com/009152047332/mail-queue
```

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
