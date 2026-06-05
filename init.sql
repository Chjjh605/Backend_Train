## users (회원 테이블)
CREATE TABLE users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    cognito_sub VARCHAR(255) NOT NULL UNIQUE, -- AWS Cognito JWT 검증용 식별자
    email VARCHAR(255) NOT NULL UNIQUE,       -- SES 발송용 이메일
    name VARCHAR(50) NOT NULL,
    INDEX idx_cognito_sub (cognito_sub)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

## trains (기차 및 구간 정보 테이블)
CREATE TABLE trains (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    train_number VARCHAR(50) NOT NULL,        -- 예: KTX-101
    segment VARCHAR(50) NOT NULL,             -- 예: 서울-부산(전구간), 서울-대전, 대전-부산
    departure_time DATETIME NOT NULL,         -- 출발 시간 (오픈 전 Redis 캐싱 기준 데이터)
    total_seats INT NOT NULL,                 -- 이 구간에 할당된 총 좌석 수
    available_seats INT NOT NULL,              -- DB 최종 동기화용 잔여 좌석 수
    -- 성능 최적화: 구간 검색과 출발 시간을 묶은 복합 인덱스 추가
  INDEX idx_segment_departure (segment, departure_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

## reservations (예매 내역 테이블 - 최종 영수증)
CREATE TABLE reservations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,                  -- users 테이블 참조 (FK)
    train_id BIGINT NOT NULL,                 -- trains 테이블 참조 (FK)
    status ENUM('PENDING', 'SUCCESS', 'CANCELLED') NOT NULL DEFAULT 'PENDING', -- PENDING, SUCCESS, CANCELLED
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users (id),
    FOREIGN KEY (train_id) REFERENCES trains (id),
    INDEX idx_user_id (user_id),               -- 마이페이지 조회 최적화
    INDEX idx_train_status (train_id, status) -- SQS 동기화 및 잔여석 정산 최적화
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

## 테스트용 데이터
INSERT IGNORE INTO users (id, cognito_sub, email, name) VALUES (1, 'local-test-sub', 'test@example.com', '홍길동');

INSERT IGNORE INTO trains (id, train_number, segment, departure_time, total_seats, available_seats) 
VALUES (1, 'KTX-101', '서울-부산', '2026-06-10 10:00:00', 100, 100);