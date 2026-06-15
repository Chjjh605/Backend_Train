## users (회원 테이블)
CREATE TABLE users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    cognito_sub VARCHAR(255) NOT NULL UNIQUE, -- AWS Cognito JWT 검증용 식별자 (자동으로 Unique Index 생성됨)
    email VARCHAR(255) NOT NULL UNIQUE,       -- SES 발송용 이메일
    name VARCHAR(50) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

## trains (기차 및 구간 정보 테이블)
CREATE TABLE trains (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    train_number VARCHAR(50) NOT NULL,        -- 예: KTX-101
    segment VARCHAR(50) NOT NULL,             -- 예: 서울-부산(전구간), 서울-대전, 대전-부산
    departure_time DATETIME NOT NULL,         -- 출발 시간 (오픈 전 Redis 캐싱 기준 데이터)
    total_seats INT NOT NULL,                 -- 이 구간에 할당된 총 좌석 수
    available_seats INT NOT NULL,              -- DB 최종 동기화용 잔여 좌석 수
  INDEX idx_segment_departure (segment, departure_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

## train_segments (구간별 상세 잔여석 테이블)
CREATE TABLE train_segments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    train_id BIGINT NOT NULL,
    start_station VARCHAR(50) NOT NULL,       -- 예: SEOUL, DAEJEON, DAEGU
    end_station VARCHAR(50) NOT NULL,         -- 예: DAEJEON, DAEGU, BUSAN
    total_seats INT NOT NULL,
    available_seats INT NOT NULL,
    FOREIGN KEY (train_id) REFERENCES trains (id) ON DELETE CASCADE,
    UNIQUE KEY idx_train_segment (train_id, start_station, end_station)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

## reservations (예매 내역 테이블 - 최종 영수증)
CREATE TABLE reservations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    reservation_uuid VARCHAR(36) NOT NULL UNIQUE, -- 클라이언트/서버 생성 고유 예약 식별자
    user_id BIGINT NOT NULL,                  -- users 테이블 참조 (FK)
    train_id BIGINT NOT NULL,                 -- trains 테이블 참조 (FK)
    start_station VARCHAR(50) NOT NULL,       -- 출발역
    end_station VARCHAR(50) NOT NULL,         -- 도착역
    status ENUM('PENDING', 'SUCCESS', 'CANCELLED') NOT NULL DEFAULT 'PENDING', -- PENDING, SUCCESS, CANCELLED
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (train_id) REFERENCES trains (id) ON DELETE RESTRICT,
    INDEX idx_user_id (user_id),               -- 마이페이지 조회 최적화
    INDEX idx_train_status (train_id, status), -- SQS 동기화 및 잔여석 정산 최적화
    INDEX idx_res_uuid (reservation_uuid)     -- UUID 조회 속도 최적화
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO users (id, cognito_sub, email, name) VALUES 
(1, 'user123', 'whwogus2483@naver.com', '네이버'),
(2, '1', 'chjjh605@gmail.com', '구글');

-- 1번 열차 (KTX 001)
INSERT IGNORE INTO trains (id, train_number, segment, departure_time, total_seats, available_seats) 
VALUES (1, 'KTX-101', '서울-부산', '2026-06-10 10:00:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(1, 'SEOUL', 'DAEJEON', 100, 100),
(1, 'DAEJEON', 'DAEGU', 100, 100),
(1, 'DAEGU', 'BUSAN', 100, 100);

-- 2번 열차 (KTX 161)
INSERT IGNORE INTO trains (id, train_number, segment, departure_time, total_seats, available_seats) 
VALUES (2, 'KTX-161', '서울-부산', '2026-06-10 11:00:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(2, 'SEOUL', 'DAEJEON', 100, 100),
(2, 'DAEJEON', 'DAEGU', 100, 100),
(2, 'DAEGU', 'BUSAN', 100, 100);

-- 3번 열차 (KTX 001)
INSERT IGNORE INTO trains (id, train_number, segment, departure_time, total_seats, available_seats) 
VALUES (3, 'KTX-101', '서울-부산', '2026-06-10 12:00:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(3, 'SEOUL', 'DAEJEON', 100, 100),
(3, 'DAEJEON', 'DAEGU', 100, 100),
(3, 'DAEGU', 'BUSAN', 100, 100);

-- 4번 열차 (KTX 161)
INSERT IGNORE INTO trains (id, train_number, segment, departure_time, total_seats, available_seats) 
VALUES (4, 'KTX-161', '서울-부산', '2026-06-10 13:00:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(4, 'SEOUL', 'DAEJEON', 100, 100),
(4, 'DAEJEON', 'DAEGU', 100, 100),
(4, 'DAEGU', 'BUSAN', 100, 100);

-- 5번 열차 (KTX 001)
INSERT IGNORE INTO trains (id, train_number, segment, departure_time, total_seats, available_seats) 
VALUES (5, 'KTX-101', '서울-부산', '2026-06-10 14:00:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(5, 'SEOUL', 'DAEJEON', 100, 100),
(5, 'DAEJEON', 'DAEGU', 100, 100),
(5, 'DAEGU', 'BUSAN', 100, 100);

-- 6번 열차 (KTX 161)
INSERT IGNORE INTO trains (id, train_number, segment, departure_time, total_seats, available_seats) 
VALUES (6, 'KTX-161', '서울-부산', '2026-06-10 15:00:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(6, 'SEOUL', 'DAEJEON', 100, 100),
(6, 'DAEJEON', 'DAEGU', 100, 100),
(6, 'DAEGU', 'BUSAN', 100, 100);

-- 7번 열차 (KTX 001)
INSERT IGNORE INTO trains (id, train_number, segment, departure_time, total_seats, available_seats) 
VALUES (7, 'KTX-101', '서울-부산', '2026-06-10 16:00:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(7, 'SEOUL', 'DAEJEON', 100, 100),
(7, 'DAEJEON', 'DAEGU', 100, 100),
(7, 'DAEGU', 'BUSAN', 100, 100);

-- 8번 열차 (KTX 161)
INSERT IGNORE INTO trains (id, train_number, segment, departure_time, total_seats, available_seats) 
VALUES (8, 'KTX-161', '서울-부산', '2026-06-10 17:00:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(8, 'SEOUL', 'DAEJEON', 100, 100),
(8, 'DAEJEON', 'DAEGU', 100, 100),
(8, 'DAEGU', 'BUSAN', 100, 100);