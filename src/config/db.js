const { Pool } = require('pg');

// บังคับพารามิเตอร์ timezone=Asia/Bangkok ใน connectionString เพื่อให้ Supabase และ Postgres ใช้เวลาไทยเสมอ
let connectionString = process.env.DATABASE_URL || '';
if (connectionString && !connectionString.includes('timezone=')) {
  const separator = connectionString.includes('?') ? '&' : '?';
  connectionString = `${connectionString}${separator}options=-c%20timezone=Asia/Bangkok`;
}

const pool = new Pool({
  connectionString,
  options: '-c TimeZone=Asia/Bangkok',
  ssl: {
    rejectUnauthorized: false, // จำเป็นสำหรับการเชื่อมต่อ Supabase บน Cloud
  },
});

// กำหนด TimeZone เป็น Asia/Bangkok ทุกครั้งที่เชื่อมต่อ client ใหม่
pool.on('connect', (client) => {
  client.query("SET timezone = 'Asia/Bangkok'").catch((err) => {
    console.error('Error setting timezone on connect:', err);
  });
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PG client:', err);
});

module.exports = pool;

