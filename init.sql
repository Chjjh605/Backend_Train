-- users (회원 테이블)
CREATE TABLE users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    cognito_sub VARCHAR(255) NOT NULL UNIQUE, -- AWS Cognito JWT 검증용 식별자 (자동으로 Unique Index 생성됨)
    email VARCHAR(255) NOT NULL UNIQUE,       -- SES 발송용 이메일
    name VARCHAR(50) NOT NULL,
    username VARCHAR(255) NULL UNIQUE,        -- 일반 로그인 아이디 (Cognito 미사용 대비)
    password VARCHAR(255) NULL,               -- 일반 로그인 비밀번호 (Cognito 미사용 대비)
    phone VARCHAR(50) NULL                    -- 사용자 연락처
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- trains (기차 및 구간 정보 테이블)
CREATE TABLE trains (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    train_number VARCHAR(50) NOT NULL,        -- 예: KTX-1001
    segment VARCHAR(50) NOT NULL,             -- 예: 서울-부산(전구간), 서울-대전, 대전-부산
    departure_date DATE NOT NULL,             -- 출발 날짜 (예: 2026-06-26)
    departure_time TIME NOT NULL,             -- 출발 시각 (예: 09:13:00)
    arrival_time TIME NOT NULL,               -- 도착 시각 (예: 11:50:00)
    total_seats INT NOT NULL,                 -- 이 구간에 할당된 총 좌석 수
    available_seats INT NOT NULL,             -- DB 최종 동기화용 잔여 좌석 수
  INDEX idx_segment_departure (segment, departure_date, departure_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- train_segments (구간별 상세 잔여석 테이블)
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

-- reservations (예매 내역 테이블 - 최종 영수증)
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

INSERT IGNORE INTO users (id, cognito_sub, email, name, username, password) VALUES 
(1, 'e9a6f3b0-4f51-4b7b-8c88-e9f06a1f81d1', 'whwogus2483@naver.com', '한지혁', 'test01', '1234'),
(2, 'd4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a', 'chjjh605@gmail.com', '정소윤', 'test02', '1234');

-- 2026-06-26
-- 1번 열차 (KTX 001, 출발 total_seats09:13, 도착 11:50)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (1, 'KTX-001', '서울-부산', '2026-06-26', '09:13:00', '11:50:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(1, 'SEOUL', 'DAEJEON', 100, 100),
(1, 'DAEJEON', 'DAEGU', 100, 100),
(1, 'DAEGU', 'BUSAN', 100, 100);

-- 2번 열차 (KTX 161, 출발 09:50, 도착 12:48)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (2, 'KTX-161', '서울-부산', '2026-06-26', '09:50:00', '12:48:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(2, 'SEOUL', 'DAEJEON', 100, 100),
(2, 'DAEJEON', 'DAEGU', 100, 100),
(2, 'DAEGU', 'BUSAN', 100, 100);

-- 3번 열차 (KTX 003, 출발 100:100, 도착 12:59)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (3, 'KTX-003', '서울-부산', '2026-06-26', '100:100:00', '12:59:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(3, 'SEOUL', 'DAEJEON', 100, 100),
(3, 'DAEJEON', 'DAEGU', 100, 100),
(3, 'DAEGU', 'BUSAN', 100, 100);

-- 4번 열차 (ITX-새마을 1001, 출발 11:20, 도착 16:40)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (4, 'ITX-새마을 1001', '서울-부산', '2026-06-26', '11:20:00', '16:40:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(4, 'SEOUL', 'DAEJEON', 100, 100),
(4, 'DAEJEON', 'DAEGU', 100, 100),
(4, 'DAEGU', 'BUSAN', 100, 100);

-- 5번 열차 (KTX 005, 출발 12:05, 도착 14:50)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (5, 'KTX-005', '서울-부산', '2026-06-26', '12:05:00', '14:50:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(5, 'SEOUL', 'DAEJEON', 100, 100),
(5, 'DAEJEON', 'DAEGU', 100, 100),
(5, 'DAEGU', 'BUSAN', 100, 100);

-- 6번 열차 (KTX-산천 075, 출발 13:15, 도착 16:01)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (6, 'KTX-산천 075', '서울-부산', '2026-06-26', '13:15:00', '16:01:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(6, 'SEOUL', 'DAEJEON', 100, 100),
(6, 'DAEJEON', 'DAEGU', 100, 100),
(6, 'DAEGU', 'BUSAN', 100, 100);

-- 7번 열차 (ITX-새마을 1003, 출발 14:40, 도착 19:53)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (7, 'ITX-새마을 1003', '서울-부산', '2026-06-26', '14:40:00', '19:53:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(7, 'SEOUL', 'DAEJEON', 100, 100),
(7, 'DAEJEON', 'DAEGU', 100, 100),
(7, 'DAEGU', 'BUSAN', 100, 100);

-- 8번 열차 (무궁화호 1151, 출발 15:30, 도착 21:04)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (8, '무궁화호 1151', '서울-부산', '2026-06-26', '15:30:00', '21:04:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(8, 'SEOUL', 'DAEJEON', 100, 100),
(8, 'DAEJEON', 'DAEGU', 100, 100),
(8, 'DAEGU', 'BUSAN', 100, 100);

-- 2026-06-27
-- 9번 열차 (KTX 001, 출발 09:13, 도착 11:50)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (9, 'KTX-001', '서울-부산', '2026-06-27', '09:13:00', '11:50:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(9, 'SEOUL', 'DAEJEON', 100, 100),
(9, 'DAEJEON', 'DAEGU', 100, 100),
(9, 'DAEGU', 'BUSAN', 100, 100);

-- 10번 열차 (KTX 161, 출발 09:50, 도착 12:48)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (10, 'KTX-161', '서울-부산', '2026-06-27', '09:50:00', '12:48:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(10, 'SEOUL', 'DAEJEON', 100, 100),
(10, 'DAEJEON', 'DAEGU', 100, 100),
(10, 'DAEGU', 'BUSAN', 100, 100);

-- 11번 열차 (KTX 003, 출발 100:100, 도착 12:59)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (11, 'KTX-003', '서울-부산', '2026-06-27', '100:100:00', '12:59:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(11, 'SEOUL', 'DAEJEON', 100, 100),
(11, 'DAEJEON', 'DAEGU', 100, 100),
(11, 'DAEGU', 'BUSAN', 100, 100);

-- 12번 열차 (ITX-새마을 1001, 출발 11:20, 도착 16:40)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (12, 'ITX-새마을 1001', '서울-부산', '2026-06-27', '11:20:00', '16:40:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(12, 'SEOUL', 'DAEJEON', 100, 100),
(12, 'DAEJEON', 'DAEGU', 100, 100),
(12, 'DAEGU', 'BUSAN', 100, 100);

-- 13번 열차 (KTX 005, 출발 12:05, 도착 14:50)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (13, 'KTX-005', '서울-부산', '2026-06-27', '12:05:00', '14:50:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(13, 'SEOUL', 'DAEJEON', 100, 100),
(13, 'DAEJEON', 'DAEGU', 100, 100),
(13, 'DAEGU', 'BUSAN', 100, 100);

-- 14번 열차 (KTX-산천 075, 출발 13:15, 도착 16:01)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (14, 'KTX-산천 075', '서울-부산', '2026-06-27', '13:15:00', '16:01:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(14, 'SEOUL', 'DAEJEON', 100, 100),
(14, 'DAEJEON', 'DAEGU', 100, 100),
(14, 'DAEGU', 'BUSAN', 1000, 100);

-- 15번 열차 (ITX-새마을 1003, 출발 14:40, 도착 19:53)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (15, 'ITX-새마을 1003', '서울-부산', '2026-06-27', '14:40:00', '19:53:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(15, 'SEOUL', 'DAEJEON', 100, 100),
(15, 'DAEJEON', 'DAEGU', 100, 100),
(15, 'DAEGU', 'BUSAN', 100, 100);

-- 16번 열차 (무궁화호 1151, 출발 15:30, 도착 21:04)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (16, '무궁화호 1151', '서울-부산', '2026-06-27', '15:30:00', '21:04:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(16, 'SEOUL', 'DAEJEON', 100, 100),
(16, 'DAEJEON', 'DAEGU', 100, 100),
(16, 'DAEGU', 'BUSAN', 100, 100);

-- 2026-06-28
-- 17번 열차 (KTX 001, 출발 09:13, 도착 11:50)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (17, 'KTX-001', '서울-부산', '2026-06-28', '09:13:00', '11:50:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(17, 'SEOUL', 'DAEJEON', 100, 100),
(17, 'DAEJEON', 'DAEGU', 100, 100),
(17, 'DAEGU', 'BUSAN', 100, 100);

-- 18번 열차 (KTX 161, 출발 09:50, 도착 12:48)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (18, 'KTX-161', '서울-부산', '2026-06-28', '09:50:00', '12:48:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(18, 'SEOUL', 'DAEJEON', 100, 100),
(18, 'DAEJEON', 'DAEGU', 100, 100),
(18, 'DAEGU', 'BUSAN', 100, 100);

-- 19번 열차 (KTX 003, 출발 100:100, 도착 12:59)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (19, 'KTX-003', '서울-부산', '2026-06-28', '100:100:00', '12:59:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(19, 'SEOUL', 'DAEJEON', 100, 100),
(19, 'DAEJEON', 'DAEGU', 100, 100),
(19, 'DAEGU', 'BUSAN', 100, 100);

-- 20번 열차 (ITX-새마을 1001, 출발 11:20, 도착 16:40)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (20, 'ITX-새마을 1001', '서울-부산', '2026-06-28', '11:20:00', '16:40:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(20, 'SEOUL', 'DAEJEON', 100, 100),
(20, 'DAEJEON', 'DAEGU', 100, 100),
(20, 'DAEGU', 'BUSAN', 100, 100);

-- 21번 열차 (KTX 005, 출발 12:05, 도착 14:50)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (21, 'KTX-005', '서울-부산', '2026-06-28', '12:05:00', '14:50:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(21, 'SEOUL', 'DAEJEON', 100, 100),
(21, 'DAEJEON', 'DAEGU', 100, 100),
(21, 'DAEGU', 'BUSAN', 100, 100);

-- 22번 열차 (KTX-산천 075, 출발 13:15, 도착 16:01)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (22, 'KTX-산천 075', '서울-부산', '2026-06-28', '13:15:00', '16:01:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(22, 'SEOUL', 'DAEJEON', 100, 100),
(22, 'DAEJEON', 'DAEGU', 100, 100),
(22, 'DAEGU', 'BUSAN', 100, 100);

-- 23번 열차 (ITX-새마을 1003, 출발 14:40, 도착 19:53)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (23, 'ITX-새마을 1003', '서울-부산', '2026-06-28', '14:40:00', '19:53:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(23, 'SEOUL', 'DAEJEON', 100, 100),
(23, 'DAEJEON', 'DAEGU', 100, 100),
(23, 'DAEGU', 'BUSAN', 100, 100);

-- 24번 열차 (무궁화호 1151, 출발 15:30, 도착 21:04)
INSERT IGNORE INTO trains (id, train_number, segment, departure_date, departure_time, arrival_time, total_seats, available_seats) 
VALUES (24, '무궁화호 1151', '서울-부산', '2026-06-28', '15:30:00', '21:04:00', 100, 100);

INSERT IGNORE INTO train_segments (train_id, start_station, end_station, total_seats, available_seats) VALUES
(24, 'SEOUL', 'DAEJEON', 100, 100),
(24, 'DAEJEON', 'DAEGU', 100, 100),
(24, 'DAEGU', 'BUSAN', 100, 100);