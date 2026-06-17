const Redis = require('ioredis');
const { SQSClient } = require('@aws-sdk/client-sqs');
const config = require('./config');

// Redis 캐시 서버 연결 (로컬 환경일 때는 Standalone으로, AWS EKS 배포 환경에서는 ElastiCache Redis Cluster TLS 연결)
const isLocalRedis = config.redis.host === '127.0.0.1' || config.redis.host === 'localhost';
const redis = isLocalRedis
  ? new Redis({ host: config.redis.host, port: config.redis.port, password: config.redis.password, enableOfflineQueue: false })
  : new Redis.Cluster(
    [{ host: config.redis.host, port: config.redis.port }],
    {
      dnsLookup: (address, callback) => callback(null, address),
      enableOfflineQueue: false,
      redisOptions: {
        password: config.redis.password,
        tls: {
          // 클러스터 노드가 IP로 반환되더라도 TLS 호스트네임 검증을 통과하도록 설정
          checkServerIdentity: () => undefined
        }
      }
    }
  );

redis.on('connect', () => console.log('⚡ Redis 캐시 서버 연결 완료!'));
redis.on('error', (err) => {
  console.error('⚠️ Redis 캐시 서버 연결 오류 발생 (캐시 없이 계속 진행):', err.message);
});

// AWS SQS 클라이언트 세팅
const SQS_QUEUE_URL = config.aws.sqsQueueUrl;
const sqsClient = new SQSClient({
  region: config.aws.region
});

// 정해진 역 순서 정의 (서울 -> 대전 -> 대구 -> 부산)
const STATIONS = ['SEOUL', 'DAEJEON', 'DAEGU', 'BUSAN'];

// 다중 세그먼트 키 일괄 차감 LUA 스크립트 (Redis Cluster CROSSSLOT 방지를 위해 모든 키를 KEYS 배열에 정의)
const MULTI_RESERVE_LUA = `
  local userKey = KEYS[1]
  local expireTime = tonumber(ARGV[1])
  local count = tonumber(ARGV[2]) or 1
  
  if redis.call('EXISTS', userKey) == 1 then
    return -2
  end
  
  for i = 2, #KEYS do
    local key = KEYS[i]
    local seats = redis.call('GET', key)
    if not seats or tonumber(seats) < count then
      return -1
    end
  end
  
  for i = 2, #KEYS do
    local key = KEYS[i]
    redis.call('DECRBY', key, count)
  end
  
  redis.call('SET', userKey, 'PENDING', 'EX', expireTime)
  return 1
`;

module.exports = { redis, sqsClient, SQS_QUEUE_URL, STATIONS, MULTI_RESERVE_LUA };
