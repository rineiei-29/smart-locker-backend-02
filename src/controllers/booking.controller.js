/**
 * =========================================================================================
 * ไฟล์: src/controllers/booking.controller.js (ระบบจัดการการจองตู้ล็อกเกอร์)
 * -----------------------------------------------------------------------------------------
 * หน้าที่หลักของไฟล์นี้:
 * 1. ตรวจสอบเงื่อนไขและสร้างรายการจองตู้ล็อกเกอร์ (Booking Creation)
 * 2. สุ่มรหัส PIN 6 หลักสำหรับใช้เปิดตู้
 * 3. ตรวจสอบการทับซ้อนของช่วงเวลาจอง (Time Overlap Validation) ไม่ให้ชนกับการจองอื่น
 * 4. บันทึกและดึงข้อมูลรายการจองของผู้ใช้งาน (My Bookings) และแอดมิน (All Bookings)
 * 5. จัดการการปลดล็อกตู้และคืนตู้ ทั้งแบบเดี่ยวและแบบกลุ่ม (Batch Action)
 * 6. ดึงประวัติการใช้งานย้อนหลังพร้อมคำนวณระยะเวลาจริงและสรุปยอดค่าบริการ (My History)
 * 
 * ความสัมพันธ์และการเชื่อมโยงข้อมูล (Architecture & Data Flow):
 * - ตารางฐานข้อมูลที่เกี่ยวข้อง (Database Tables):
 *   - `bookings`: จัดเก็บข้อมูลการจอง (user_id, locker_id, pin_code, start_time, end_time, status, amount)
 *   - `lockers`: จัดเก็บข้อมูลตู้ล็อกเกอร์ (locker_number, size, location, status)
 *   - `logs`: บันทึกประวัติกิจกรรม (book, open, close, admin_release)
 *   - `users`: จัดเก็บข้อมูลผู้ใช้ (username, firstname, lastname)
 * 
 * - ไฟล์ที่เรียกใช้งานร่วมกัน:
 *   - `../config/db.js`: Pool สำหรับเชื่อมต่อฐานข้อมูล PostgreSQL (Supabase)
 *   - `../utils/scheduling.js`: ฟังก์ชันตรวจเช็คเวลาจองล่วงหน้าและตรวจการจองซ้อน
 *   - `../config/pricing.js`: ตารางราคาค่าบริการตามขนาดตู้ (small=20, medium=30, large=50)
 *   - `./payment.controller.js`: เรียกใช้ finalizeBooking() เมื่อชำระเงินสำเร็จ
 * 
 * - หน้าบ้าน (Frontend) ที่เรียกใช้งาน API จากคอนโทรลเลอร์นี้:
 *   - `HomePage.jsx`: เรียกดูการจองปัจจุบัน (/my-bookings), สั่งปลดล็อก/คืนตู้ (/batch-action)
 *   - `UserHistory.jsx`: เรียกดูประวัติการใช้งานย้อนหลังและยอดรวม (/my-history)
 *   - `AdminPage.jsx`: เรียกดูรายการจองทั้งหมด (/all-bookings) และปล่อยตู้ (/release-booking/:id)
 * =========================================================================================
 */

const pool = require('../config/db');
const { normalizeStartTime, findOverlappingBooking } = require('../utils/scheduling');
const { SIZE_PRICE } = require('../config/pricing');

// กำหนดขอบเขตระยะเวลาการจองขั้นต่ำและสูงสุด
const MIN_PLANNED_MINUTES = 15;        // ขั้นต่ำ 15 นาที
const MAX_PLANNED_MINUTES = 24 * 60;   // สูงสุด 24 ชั่วโมง (1440 นาที)

/**
 * ฟังก์ชันตรวจสอบความถูกต้องของระยะเวลาการจองที่ส่งเข้ามา
 * @param {number|string} minutes - จำนวนนาทีที่ต้องการจอง
 * @returns {number|null} คืนค่าจำนวนนาทีเป็นตัวเลขจำนวนเต็ม หรือ null หากข้อมูลไม่ถูกต้อง
 */
function normalizePlannedMinutes(minutes) {
  const value = Number(minutes);
  // ตรวจสอบว่าต้องเป็นตัวเลขจำนวนเต็มเท่านั้น
  if (!Number.isInteger(value)) return null;
  // ตรวจสอบว่าต้องอยู่ในช่วง 15 นาที ถึง 24 ชั่วโมง
  if (value < MIN_PLANNED_MINUTES || value > MAX_PLANNED_MINUTES) return null;
  return value;
}

/**
 * ฟังก์ชันบันทึกการจองลงฐานข้อมูลขั้นสุดท้าย (สร้าง Record จริงในตาราง bookings)
 * ถูกเรียกใช้งานทั้งจาก:
 * 1) createBooking (กรณีจองโดยตรง/ระบบไม่มีการชำระเงิน)
 * 2) confirmPaymentSession (กรณีชำระเงินผ่าน QR Code สำเร็จใน payment.controller.js)
 * 
 * @param {Object} params ข้อมูลการจอง
 * @param {number} params.user_id - รหัสผู้ใช้งาน
 * @param {number} params.locker_id - รหัสตู้ล็อกเกอร์
 * @param {number} params.planned_minutes - ระยะเวลาที่ตั้งใจฝาก (นาที)
 * @param {Date} params.start_time - เวลาเริ่มต้นใช้งาน
 * @param {number} [params.amount] - จำนวนเงินค่าบริการ (หากไม่ส่งมาระบบจะคำนวณตามขนาดตู้)
 * @returns {Promise<Object>} คืนค่าข้อมูลการจองที่สร้างเสร็จสมบูรณ์รวมถึงรหัส PIN
 */
async function finalizeBooking({ user_id, locker_id, planned_minutes, start_time, amount }) {
  // สุ่มรหัส PIN 6 หลัก (100000 ถึง 999999) สำหรับใช้กดเปิดตู้
  const pinCode = Math.floor(100000 + Math.random() * 900000).toString();
  
  // คำนวณเวลาสิ้นสุด (end_time) จากเวลาเริ่มต้น + จำนวนนาทีที่เลือก
  const endTime = new Date(start_time.getTime() + planned_minutes * 60 * 1000);

  // คำนวณค่าบริการตามขนาดตู้ล็อกเกอร์ หากไม่มีการส่งยอดเงิน amount เข้ามา
  let bookingAmount = amount;
  if (bookingAmount == null) {
    const lockerRes = await pool.query('SELECT size FROM lockers WHERE locker_id = $1', [locker_id]);
    if (lockerRes.rows.length > 0) {
      bookingAmount = SIZE_PRICE[lockerRes.rows[0].size] ?? 0;
    } else {
      bookingAmount = 0;
    }
  }

  // ทำการบันทึกข้อมูลการจองใหม่ลงตาราง bookings ในฐานข้อมูล PostgreSQL
  // สถานะเริ่มต้นจะเป็น 'active'
  const bookingResult = await pool.query(
    `INSERT INTO bookings (user_id, locker_id, pin_code, planned_minutes, start_time, end_time, status, amount)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7) RETURNING booking_id`,
    [user_id, locker_id, pinCode, planned_minutes, start_time, endTime, bookingAmount]
  );

  // บันทึกประวัติกิจกรรมลงตาราง logs ว่าผู้ใช้คนนี้ได้ทำการจองตู้นี้ (action = 'book')
  await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [locker_id, user_id, 'book']);

  // ส่งข้อมูลผลลัพธ์กลับไปยังผู้เรียกใช้งาน
  return { 
    booking_id: bookingResult.rows[0].booking_id, 
    pin_code: pinCode, 
    start_time, 
    end_time: endTime, 
    amount: bookingAmount 
  };
}

/**
 * Controller: สร้างการจองตู้ล็อกเกอร์โดยตรง
 * Method: POST /bookings (หรือ API จองทั่วไป)
 * 
 * ขั้นตอนการทำงาน:
 * 1. ตรวจสอบข้อมูลนำเข้า (user_id, locker_id, minutes, start_time)
 * 2. ตรวจสอบสถานะตู้ว่าไม่ถูกปิดปรับปรุง (maintenance) หรือปิดให้บริการ (unavailable)
 * 3. ตรวจสอบว่าช่วงเวลาที่ต้องการจอง ทับซ้อนกับการจองของผู้อื่นหรือไม่
 * 4. หากผ่านเงื่อนไขทั้งหมด ทำการบันทึกการจองและส่งรหัส PIN กลับไปให้ผู้ใช้งาน
 */
async function createBooking(req, res) {
  const { user_id, locker_id, minutes, start_time } = req.body;
  
  // ตรวจสอบว่าส่ง user_id และ locker_id มาครบถ้วนหรือไม่
  if (!user_id || !locker_id) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุ user_id และ locker_id' });
  }

  // ตรวจสอบและแปลงระยะเวลานาทีที่ต้องการฝาก
  const plannedMinutes = normalizePlannedMinutes(minutes);
  if (!plannedMinutes) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกระยะเวลาที่ต้องการฝาก (15 นาที - 24 ชม.)' });
  }

  // ตรวจสอบและแปลงเวลาเริ่มต้นให้อยู่ในรูปแบบที่ถูกต้อง (ไม่เกิน 7 วันล่วงหน้า)
  const startResult = normalizeStartTime(start_time);
  if (startResult.error) {
    return res.status(400).json({ success: false, message: startResult.error });
  }
  const startTime = startResult.value;
  const endTime = new Date(startTime.getTime() + plannedMinutes * 60 * 1000);

  // ดึงข้อมูลตู้ล็อกเกอร์จากฐานข้อมูล เพื่อเช็คการมีอยู่และสถานะความพร้อมของตู้
  const lockerResult = await pool.query('SELECT * FROM lockers WHERE locker_id = $1', [locker_id]);
  if (lockerResult.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  const locker = lockerResult.rows[0];
  if (locker.status === 'maintenance' || locker.status === 'unavailable') {
    return res.status(400).json({ success: false, message: 'ตู้นี้ปิดใช้งานอยู่ หรืออยู่ระหว่างซ่อมบำรุง' });
  }

  // ตรวจสอบว่าช่วงเวลา startTime ถึง endTime นี้ ตู้นี้มีคิวจองที่ทับซ้อนกันอยู่แล้วหรือไม่
  const conflict = await findOverlappingBooking(locker_id, startTime, endTime);
  if (conflict) {
    return res.status(400).json({ success: false, message: 'ช่วงเวลานี้ถูกจองไปแล้ว กรุณาเลือกช่วงเวลาอื่น' });
  }

  // บันทึกการจองและสร้างรหัส PIN
  const booking = await finalizeBooking({ user_id, locker_id, planned_minutes: plannedMinutes, start_time: startTime });

  // ตอบกลับผลการจองสำเร็จ พร้อมข้อมูลสำคัญให้ผู้ใช้เห็นทันที
  res.json({
    success: true,
    message: 'จองตู้สำเร็จ',
    booking_id: booking.booking_id,
    pin_code: booking.pin_code,
    locker_number: locker.locker_number,
    planned_minutes: plannedMinutes,
    start_time: booking.start_time,
    end_time: booking.end_time,
  });
}

/**
 * Controller: ดูรายการจองทั้งหมดของผู้ใช้คนหนึ่ง (ใช้ในหน้าแรก HomePage ของ User)
 * Method: GET /my-bookings?user_id=...
 * 
 * ดึงรายการจองของผู้ใช้ พร้อม JOIN ตาราง lockers เพื่อแสดงหมายเลขตู้, สถานที่, และขนาด
 * เรียงลำดับตาม start_time ล่าสุดขึ้นก่อน
 */
async function myBookings(req, res) {
  const { user_id } = req.query;
  const result = await pool.query(
    `SELECT b.*, l.locker_number, l.location, l.size
     FROM bookings b JOIN lockers l ON b.locker_id = l.locker_id
     WHERE b.user_id = $1 ORDER BY b.start_time DESC`,
    [user_id]
  );
  res.json({ success: true, data: result.rows });
}

/**
 * Controller: รายการจองทั้งหมดในระบบ (สำหรับหน้า Admin Dashboard)
 * Method: GET /all-bookings
 * 
 * ดึงรายการจองล่าสุด 100 รายการ โดย JOIN ตาราง lockers และ users
 * เพื่อให้แอดมินเห็นว่าใครจองตู้ไหน เวลาใด และสถานะใด
 */
async function allBookings(req, res) {
  const result = await pool.query(
    `SELECT b.*, l.locker_number, u.username, u.firstname, u.lastname
     FROM bookings b
     JOIN lockers l ON b.locker_id = l.locker_id
     JOIN users u ON b.user_id = u.user_id
     ORDER BY b.created_at DESC
     LIMIT 100`
  );
  res.json({ success: true, data: result.rows });
}

/**
 * Controller: ปล่อยตู้ฉุกเฉินโดยผู้ดูแลระบบ (Admin Release)
 * Method: POST /release-booking/:id
 * 
 * ใช้ในกรณีที่ผู้ใช้ลืมของ, เกินเวลาใช้งานนาน, หรือมีเหตุขัดข้อง
 * แอดมินสามารถกดปล่อยตู้เพื่อยกเลิกรายการจอง ทำให้ตู้นั้นกลับมาว่างและผู้อื่นจองต่อได้ทันที
 */
async function releaseBooking(req, res) {
  // ค้นหารายการจองตาม ID ที่ส่งมาในพารามิเตอร์ URL
  const result = await pool.query('SELECT * FROM bookings WHERE booking_id = $1', [req.params.id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการจองนี้' });
  }
  const booking = result.rows[0];
  
  // ตรวจสอบว่าต้องเป็นรายการที่ยัง active อยู่เท่านั้น
  if (booking.status !== 'active') {
    return res.status(400).json({ success: false, message: 'รายการจองนี้ไม่ได้อยู่ในสถานะใช้งาน' });
  }

  // อัปเดตสถานะเป็น 'cancelled' และบันทึกเวลาเสร็จสิ้น completed_at = NOW()
  await pool.query('UPDATE bookings SET status = $1, completed_at = NOW() WHERE booking_id = $2', ['cancelled', req.params.id]);
  
  // บันทึกกิจกรรมลงตาราง logs เพื่อเป็นหลักฐานว่าแอดมินเป็นผู้ปล่อยตู้
  await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [
    booking.locker_id,
    booking.user_id,
    'admin_release',
  ]);

  res.json({ success: true, message: 'ปล่อยตู้สำเร็จ คืนสิทธิ์ให้ผู้อื่นจองต่อได้แล้ว' });
}

/**
 * Controller: ปลดล็อกตู้ หรือ คืนตู้ (Batch Action)
 * Method: POST /batch-action
 * 
 * รองรับการสั่งงานทั้งตู้เดียว หรือสั่งพร้อมกันหลายตู้ (Multi-select)
 * Body: { user_id, items: [ { booking_id, action: 'open' | 'close' }, ... ] }
 * - action = 'open': ผู้ใช้กดปลดล็อกตู้เพื่อเปิดเอาของ (สถานะจองยัง active เหมือนเดิม บันทึก log 'open')
 * - action = 'close': ผู้ใช้ยืนยันคืนตู้ (อัปเดตสถานะเป็น 'completed', completed_at = NOW(), บันทึก log 'close')
 */
async function batchAction(req, res) {
  const { user_id, items } = req.body;
  if (!user_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
  }

  const results = [];

  // วนลูปประมวลผลคำสั่งสำหรับแต่ละตู้ในรายการ items
  for (const item of items) {
    const { booking_id, action } = item;
    try {
      // ตรวจสอบว่ารายการจองนี้มีอยู่จริง และเป็นของ user_id คนนี้เท่านั้น (ป้องกันสวมสิทธิ์)
      const bRes = await pool.query(
        'SELECT * FROM bookings WHERE booking_id = $1 AND user_id = $2',
        [booking_id, user_id]
      );

      if (bRes.rows.length === 0) {
        results.push({ booking_id, success: false, message: 'ไม่พบรายการจองนี้หรือไม่มีสิทธิ์เข้าถึง' });
        continue;
      }

      const booking = bRes.rows[0];
      // ตรวจสอบว่าสถานะต้องเป็น 'active' เท่านั้นจึงจะสั่งงานได้
      if (booking.status !== 'active') {
        results.push({ booking_id, success: false, message: 'รายการจองนี้ไม่ได้อยู่ในสถานะใช้งาน' });
        continue;
      }

      if (action === 'close') {
        // กรณี "คืนตู้": อัปเดตสถานะการจองเป็น 'completed' และประทับเวลาปัจจุบัน
        await pool.query(
          'UPDATE bookings SET status = $1, completed_at = NOW() WHERE booking_id = $2',
          ['completed', booking_id]
        );
        // บันทึกประวัติการคืนตู้ลงใน logs (action = 'close')
        await pool.query(
          'INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)',
          [booking.locker_id, user_id, 'close']
        );
        results.push({ booking_id, success: true, message: 'คืนตู้สำเร็จ' });
      } else if (action === 'open') {
        // กรณี "ปลดล็อกตู้": บันทึกประวัติการเปิดตู้ลงใน logs (action = 'open')
        await pool.query(
          'INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)',
          [booking.locker_id, user_id, 'open']
        );
        results.push({ booking_id, success: true, message: 'ปลดล็อกตู้สำเร็จ' });
      } else {
        results.push({ booking_id, success: false, message: 'คำสั่งไม่ถูกต้อง' });
      }
    } catch (err) {
      console.error(`Batch action error on booking #${booking_id}:`, err);
      results.push({ booking_id, success: false, message: 'เกิดข้อผิดพลาดในการทำรายการ' });
    }
  }

  res.json({ success: true, results });
}

/**
 * Controller: ดึงประวัติการใช้งานของผู้ใช้ที่เข้าสู่ระบบ (User History)
 * Method: GET /my-history?user_id=...
 * 
 * ดึงเฉพาะรายการที่เสร็จสิ้นแล้ว (completed) หรือถูกยกเลิก (cancelled)
 * นำมาคำนวณ:
 * 1. actual_minutes: ระยะเวลาที่ใช้งานจริง (จาก start_time ถึง completed_at)
 * 2. amount / fee_paid: ค่าบริการที่ชำระ (ดึงจากคอลัมน์ amount หรือคำนวณตามขนาดตู้หากเป็น null)
 * 3. summary: สรุปยอดรวมจำนวนครั้ง, เวลาที่ใช้รวม, และค่าบริการสะสมทั้งหมด
 * 
 * ส่งข้อมูลให้กับคอมโพเนนต์ UserHistory.jsx ในฝั่ง Frontend
 */
async function myHistory(req, res) {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุ user_id' });
    }

    // Query รายการจองที่สิ้นสุดแล้วของผู้ใช้นี้ โดย JOIN ตาราง lockers เพื่อเอาหมายเลขตู้ ขนาด และสถานที่
    const result = await pool.query(
      `SELECT b.*, l.locker_number, l.size, l.location
       FROM bookings b
       JOIN lockers l ON b.locker_id = l.locker_id
       WHERE b.user_id = $1 AND b.status IN ('completed', 'cancelled')
       ORDER BY COALESCE(b.completed_at, b.end_time, b.created_at) DESC`,
      [user_id]
    );

    // ประมวลผลแต่ละแถวเพื่อคำนวณเวลาที่ใช้จริง และค่าบริการ
    const rows = result.rows.map((r) => {
      let actual_minutes = null;
      // คำนวณเวลาใช้งานจริง (นาที) หากมีเวลาเสร็จสิ้น completed_at
      if (r.completed_at && r.start_time) {
        const diff = Math.round((new Date(r.completed_at) - new Date(r.start_time)) / 60000);
        actual_minutes = diff > 0 ? diff : (r.planned_minutes || 15);
      }
      
      // ดึงค่าบริการ: หากในตารางเป็น null ให้คำนวณตามขนาดตู้จาก SIZE_PRICE (small=20, medium=30, large=50)
      const fee = Number(r.amount ?? r.price ?? SIZE_PRICE[r.size] ?? 0);
      return {
        ...r,
        actual_minutes,
        amount: fee,
        fee_paid: fee, // ส่งทั้ง amount และ fee_paid เพื่อให้รองรับทุกคอมโพเนนต์ในหน้าบ้าน
      };
    });

    // แยกกลุ่มรายการที่คืนตู้สำเร็จ (completed) และรายการที่ยกเลิก (cancelled)
    const completed = rows.filter((r) => r.status === 'completed');
    const cancelled = rows.filter((r) => r.status === 'cancelled');
    
    // คำนวณยอดเงินรวมและเวลารวม เฉพาะรายการที่คืนตู้สำเร็จ
    const totalSpent = completed.reduce((sum, r) => sum + (r.amount || 0), 0);
    const totalMinutes = completed.reduce((sum, r) => sum + (r.actual_minutes || r.planned_minutes || 0), 0);

    // สร้างอ็อบเจกต์สรุปสถิติสำหรับส่งไปแสดงผลที่หน้าบ้าน
    const summary = {
      // คีย์หลักสำหรับ UserHistory.jsx
      total_bookings: rows.length,
      completed_bookings: completed.length,
      cancelled_bookings: cancelled.length,
      total_spent: totalSpent,
      total_minutes_used: totalMinutes,

      // คีย์สำรองสำหรับความเข้ากันได้ย้อนหลัง
      completed_count: completed.length,
      total_minutes: totalMinutes,
    };

    res.json({
      success: true,
      data: rows,
      summary,
    });
  } catch (error) {
    console.error('Error fetching my-history:', error);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงประวัติการใช้งาน' });
  }
}

module.exports = {
  createBooking,
  myBookings,
  allBookings,
  releaseBooking,
  batchAction,
  finalizeBooking,
  normalizePlannedMinutes,
  myHistory,
};


