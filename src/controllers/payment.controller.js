/**
 * =========================================================================================
 * ไฟล์: src/controllers/payment.controller.js (ระบบคิดเงินและจำลองการชำระเงินด้วย QR Code)
 * -----------------------------------------------------------------------------------------
 * หน้าที่หลักของไฟล์นี้:
 * 1. สร้างเซสชันการชำระเงินชั่วคราว (Temporary Payment Session)
 * 2. คำนวณราคาค่าบริการตามขนาดตู้ (SIZE_PRICE: small=20, medium=30, large=50)
 * 3. สร้างรหัสอ้างอิง (Ref Code) และ Payload สำหรับแสดงเป็น QR Code บนหน้าเว็บ
 * 4. ตรวจสอบการทับซ้อนของช่วงเวลา 2 ชั้น (Double Check Overlapping):
 *    - ชั้นที่ 1: ตรวจตอนกด "จองตู้นี้" (สร้าง session)
 *    - ชั้นที่ 2: ตรวจอีกครั้งตอนกด "ฉันชำระเงินแล้ว" (ยืนยัน confirm) ป้องกันคนอื่นจองตัดหน้า
 * 5. ยืนยันการชำระเงินและเรียก finalizeBooking() เพื่อสร้างรายการจองและรหัส PIN จริง
 * 
 * ความสัมพันธ์และการเชื่อมโยงข้อมูล (Dependencies):
 * - `../config/db.js`: การเชื่อมต่อฐานข้อมูล PostgreSQL
 * - `./booking.controller.js`: ฟังก์ชัน finalizeBooking สำหรับสร้าง record การจอง
 * - `../utils/paymentSessions.js`: เก็บ session ในหน่วยความจำชั่วคราว (In-Memory Map)
 * - `../config/pricing.js`: ตารางราคาตามขนาดตู้
 * - `../utils/scheduling.js`: ตรวจสอบช่วงเวลาไม่ให้ชนกัน
 * 
 * Frontend ที่เรียกใช้งาน:
 * - `HomePage.jsx`: แสดง Modal คิดเงิน, สแกน QR Code, และยืนยันการชำระเงิน
 * =========================================================================================
 */

const pool = require('../config/db');
const { finalizeBooking, normalizePlannedMinutes } = require('./booking.controller');
const { createSession, getSession, deleteSession } = require('../utils/paymentSessions');
const { SIZE_PRICE } = require('../config/pricing');
const { normalizeStartTime, findOverlappingBooking } = require('../utils/scheduling');

/**
 * ฟังก์ชันสร้างรหัสอ้างอิงการชำระเงิน (Reference Code)
 * รูปแบบ: LK-<timestamp>-<สุ่ม 6 ตัวอักษร> เช่น LK-1728889999000-A8B9C1
 * @returns {string} รหัสอ้างอิงเฉพาะรายการ
 */
function generateRefCode() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LK-${Date.now()}-${rand}`;
}

/**
 * Controller: สร้างเซสชันการชำระเงิน (Payment Session)
 * Method: POST /payment-sessions
 * 
 * ขั้นตอนการทำงาน:
 * 1. ตรวจสอบความถูกต้องของ user_id, locker_id, minutes, start_time
 * 2. ตรวจสอบว่าตู้ไม่ได้ปิดปรับปรุง (maintenance) หรือปิดให้บริการ (unavailable)
 * 3. ตรวจสอบว่าช่วงเวลาที่เลือกไม่ชนกับการจองที่มีอยู่แล้ว (findOverlappingBooking)
 * 4. ดึงราคาจากขนาดตู้ (SIZE_PRICE) และสร้าง ref_code
 * 5. บันทึก session ลงในหน่วยความจำชั่วคราว
 * 6. ส่ง session_id, qr_payload, และรายละเอียดกลับไปให้หน้าเว็บแสดงผล
 */
async function createPaymentSession(req, res) {
  const { user_id, locker_id, minutes, start_time } = req.body;
  if (!user_id || !locker_id) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุ user_id และ locker_id' });
  }

  // ตรวจสอบระยะเวลาการจอง (15 นาที ถึง 24 ชั่วโมง)
  const plannedMinutes = normalizePlannedMinutes(minutes);
  if (!plannedMinutes) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกระยะเวลาที่ต้องการฝาก (15 นาที - 24 ชม.)' });
  }

  // แปลงและตรวจสอบเวลาเริ่มต้น (ต้องไม่เกิน 7 วันล่วงหน้า และไม่อยู่ในอดีต)
  const startResult = normalizeStartTime(start_time);
  if (startResult.error) {
    return res.status(400).json({ success: false, message: startResult.error });
  }
  const startTime = startResult.value;
  const endTime = new Date(startTime.getTime() + plannedMinutes * 60 * 1000);

  // ตรวจสอบข้อมูลตู้ล็อกเกอร์จากฐานข้อมูล
  const lockerResult = await pool.query('SELECT * FROM lockers WHERE locker_id = $1', [locker_id]);
  if (lockerResult.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  const locker = lockerResult.rows[0];
  if (locker.status === 'maintenance' || locker.status === 'unavailable') {
    return res.status(400).json({ success: false, message: 'ตู้นี้ปิดใช้งานอยู่ หรืออยู่ระหว่างซ่อมบำรุง' });
  }

  // ตรวจสอบว่าช่วงเวลานี้ชนกับการจองที่มีอยู่ก่อนหน้าหรือไม่ (ตรวจรอบที่ 1)
  const conflict = await findOverlappingBooking(locker_id, startTime, endTime);
  if (conflict) {
    return res.status(400).json({ success: false, message: 'ช่วงเวลานี้ถูกจองไปแล้ว กรุณาเลือกช่วงเวลาอื่น' });
  }

  // ดึงราคาตามขนาดตู้
  const amount = SIZE_PRICE[locker.size] ?? 0;
  const refCode = generateRefCode(); // สุ่ม Ref Code ใหม่ทุกครั้ง
  const qrPayload = `LOCKER|${locker.locker_number}|${amount}|${refCode}`; // ข้อความจำลองสำหรับสร้าง QR Code

  // บันทึกข้อมูล session ลงใน paymentSessions (หน่วยความจำชั่วคราว)
  const session = createSession({
    user_id,
    locker_id,
    locker_number: locker.locker_number,
    locker_size: locker.size,
    planned_minutes: plannedMinutes,
    start_time: startTime,
    end_time: endTime,
    amount,
    ref_code: refCode,
  });

  // ส่งผลลัพธ์กลับไปยังหน้าบ้านเพื่อเรนเดอร์ QR Code และสรุปยอดชำระ
  res.json({
    success: true,
    session_id: session.session_id,
    locker_number: locker.locker_number,
    locker_size: locker.size,
    amount,
    ref_code: refCode,
    qr_payload: qrPayload,
    planned_minutes: plannedMinutes,
    start_time: startTime,
    end_time: endTime,
  });
}

/**
 * Controller: ยกเลิกเซสชันการชำระเงิน
 * Method: DELETE /payment-sessions/:id
 * 
 * เรียกเมื่อผู้ใช้กดยกเลิก หรือปิดหน้าต่างชำระเงิน (Modal)
 * ทำการลบ session_id ออกจากหน่วยความจำชั่วคราว
 */
async function cancelPaymentSession(req, res) {
  deleteSession(req.params.id);
  res.json({ success: true, message: 'ยกเลิกรายการชำระเงินแล้ว' });
}

/**
 * Controller: ยืนยันการชำระเงินและสร้างการจองจริง
 * Method: POST /payment-sessions/:id/confirm
 * 
 * ขั้นตอนการทำงาน:
 * 1. ดึง session จากหน่วยความจำ หากไม่พบแสดงว่าหมดอายุหรือถูกยกเลิกไปแล้ว
 * 2. ตรวจสอบสถานะตู้ล็อกเกอร์อีกครั้งว่ายังเปิดใช้งานอยู่
 * 3. ตรวจสอบการทับซ้อนของช่วงเวลาอีกครั้ง (ตรวจรอบที่ 2 ป้องกันคนอื่นจองแทรกระหว่างที่กำลังสแกนจ่าย)
 * 4. เรียก finalizeBooking() เพื่อบันทึกลงตาราง bookings และ logs พร้อมสร้างรหัส PIN 6 หลัก
 * 5. ลบ session ออกจากหน่วยความจำ
 * 6. ส่งข้อมูลผลการจองและรหัส PIN กลับไปให้ผู้ใช้งาน
 */
async function confirmPaymentSession(req, res) {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการชำระเงินนี้ หรือหมดอายุแล้ว กรุณาลองจองใหม่' });
  }

  // ตรวจสอบตู้ล็อกเกอร์ว่ายังพร้อมใช้งานอยู่หรือไม่
  const lockerResult = await pool.query('SELECT * FROM lockers WHERE locker_id = $1', [session.locker_id]);
  const locker = lockerResult.rows[0];
  if (!locker || locker.status === 'maintenance' || locker.status === 'unavailable') {
    deleteSession(req.params.id);
    return res.status(400).json({ success: false, message: 'ตู้นี้ปิดใช้งานไปแล้ว กรุณาเลือกตู้ใหม่' });
  }

  // ตรวจสอบการชนของเวลาซ้ำอีกครั้ง เพื่อป้องกันกรณีมีผู้ใช้อีกคนกดยืนยันตัดหน้า
  const conflict = await findOverlappingBooking(session.locker_id, session.start_time, session.end_time);
  if (conflict) {
    deleteSession(req.params.id);
    return res.status(400).json({ success: false, message: 'ช่วงเวลานี้ถูกคนอื่นจองไปก่อนแล้ว กรุณาเลือกช่วงเวลาใหม่' });
  }

  // บันทึกการจองจริงลงในฐานข้อมูลตาราง bookings และบันทึกประวัติลง logs
  const booking = await finalizeBooking({
    user_id: session.user_id,
    locker_id: session.locker_id,
    planned_minutes: session.planned_minutes,
    start_time: session.start_time,
    amount: session.amount,
  });

  // ลบ session ออกจากหน่วยความจำหลังทำรายการเสร็จสิ้น
  deleteSession(req.params.id);

  // ส่งข้อมูลยืนยันการจองพร้อมรหัส PIN ให้หน้าเว็บ
  res.json({
    success: true,
    message: 'ชำระเงินสำเร็จ',
    booking_id: booking.booking_id,
    pin_code: booking.pin_code,
    locker_number: locker.locker_number,
    planned_minutes: session.planned_minutes,
    start_time: booking.start_time,
    end_time: booking.end_time,
    amount: session.amount,
  });
}

module.exports = { createPaymentSession, cancelPaymentSession, confirmPaymentSession };

