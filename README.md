
## ⚙️ 로컬 개발 환경 실행 가이드 -> AWS RDS연동이면 할 필요 없습니다

로컬에서 소스 코딩 후 동작 확인 및 디버깅을 하기 위한 가이드입니다.
Docker 프로그램을 별개로 다운로드 해야합니다.

### 1) 의존성 라이브러리 설치
```bash
npm install
```

### 2) 로컬 인프라 구동 (Docker)
```bash
# MySQL(3306) 및 Redis(6379) 백그라운드 구동 (init.sql이 자동 실행되어 데이터베이스 초기화)
docker-compose up -d
```

### 3) AWS SQS 생성
AWS 콘솔에서 SQS 큐를 생성합니다.
생성 후 SQS UR을 '.env' 파일에 입력합니다

### 4) 백엔드 어플리케이션 실행

#### ■ API 웹서버 실행 (Express)
사용자의 열차 조회 및 예약 접수/확정 API를 가동합니다. (기본 포트: 8080)
```bash
# 로컬 개발 API 서버 가동 (http://localhost:8080)
npm start
```

### 5) 비동기 DB 이관 워커 실행
```bash
# SQS 대기열 감시 및 MySQL 데이터 이관, 만료 정리 워커 가동
npm run worker
```

### 6) 로컬 환경 정리
```bash
# 테스트 종료 후 도커 컨테이너 중지 및 볼륨 삭제
docker-compose down -v
```

---

## ☁️ 2. AWS 연동 및 배포 테스트 가이드

테라폼으로 배포한 AWS 클라우드 인프라와 백엔드를 연동하여 연계성 및 트래픽 배포 테스트를 수행하는 가이드입니다.

### ⚙️ AWS 배포 및 연동 절차

#### [1단계] 테라폼 배포
테라폼 리포지토리(`Train_repo`)를 배포하고 엔드포인트를 확보합니다.

> 📌 테라폼 배포 후 다음 주소를 복사해 둡니다.
> - `aurora_writer_endpoint` (RDS 호스트)
> - `redis_primary_endpoint` (Redis 호스트)
> - `sqs_queue_url` (SQS 대기열 주소)

#### [2단계] AWS EKS 연결 설정
로컬 터미널의 쿠버네티스 도구(`kubectl`)를 생성된 EKS 클러스터와 연결합니다.
```bash
aws eks update-kubeconfig --region ap-northeast-2 --name team-train-dev-eks
```

#### [3단계] SQS 권한용 ServiceAccount 생성 및 적용
`service-account.yaml`을 생성하고 테라폼이 출력한 `booking_pod_role_arn` 값을 annotation으로 기입한 뒤 배포합니다.
```bash
kubectl apply -f service-account.yaml
```

#### [4단계] 백엔드 및 워커 컨테이너 배포
1. `backend-deployment.yaml`과 `worker-deployment.yaml` 파일의 환경변수(`env`) 설정 영역에 **[1단계]에서 복사한 RDS, Redis, SQS 엔드포인트 주소**들을 매핑해 줍니다.
2. EKS 클러스터에 컨테이너들을 기동합니다.
   ```bash
   # 백엔드 API & DB 적재 워커 배포 실행
   kubectl apply -f backend-deployment.yaml
   kubectl apply -f worker-deployment.yaml
   ```

---

## 📂 프로젝트 폴더 구조

```text
Backend_Train/
├── src/
│   ├── app.js          # Express API 웹서버 (조회, 예매 접수 및 확정)
│   ├── worker.js       # SQS 대기열 감시, MySQL 데이터 적재 및 만료 스케줄러
│   └── config.js       # 환경변수 로딩 및 중앙 설정 파일
├── docker-compose.yml  # 로컬 테스트용 MySQL & Redis 도커 가동 파일
├── init.sql            # 로컬 DB 최초 실행 시 테이블 자동 생성용 DDL
├── .env                # 환경변수 설정 파일 (로컬 테스트용)
├── package.json        # 패키지 의존성 파일
└── README.md           # 프로젝트 가이드 (본 파일)
```

---

## 🛠️ **배포 방법**

팀 프로젝트 진행 시 백엔드 코드를 동기화하고 배포하는 프로세스입니다. 아래 순서를 준수해 주세요.

```bash
# 작업 시작 전, 원격 저장소의 최신 변경 사항을 먼저 반영합니다.
git pull origin main

# 작업 내용 커밋하기
# 커밋 메시지는 이름(영문): 본인이 작업한 내용 작성 형식으로 통일합니다.
git commit -m "이름: 커밋 메시지"

# 원격 저장소에 푸시 후 공유
git push origin main

<<<<<<< HEAD
# 푸시가 완료되면 반드시 팀 톡방에 알림을 남겨주세요!
```