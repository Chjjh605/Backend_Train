# Node.js 18 (Alpine Linux 기반 가벼운 이미지)
FROM node:18-alpine

# 컨테이너 내 작업 디렉토리 설정
WORKDIR /usr/src/app

# 패키지 매니저 파일들 먼저 복사 (캐싱 효율화)
COPY package*.json ./

# 의존성 모듈 설치 (프로덕션 환경에서는 npm ci 권장)
RUN npm install --production

# 나머지 소스코드 전체 복사
COPY . .

# 포트 개방
EXPOSE 8080

# 컨테이너 시작 시 실행될 기본 명령어 (앱 서버 시작)
CMD ["npm", "run", "start"]
