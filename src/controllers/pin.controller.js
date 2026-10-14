/**
 * =========================================================================================
 * ไฟล์: src/controllers/pin.controller.js (ระบบตรวจสอบรหัส PIN และควบคุมการเปิด/คืนตู้)
 * -----------------------------------------------------------------------------------------
 * หน้าที่หลักของไฟล์นี้:
 * 1. ตรวจสอบรหัส PIN 6 หลักที่ผู้ใช้กรอกผ่านหน้าตู้ หรือผ่านหน้าเว็บ
 * 2. ป้องกันความปลอดภัย: หากกรอก PIN ผิด จะบันทึกเหตุการณ์ 'wrong_pin' ลงใน logs
 * 3. ควบคุมการทำงานของตู้ล็อกเกอร์:
 *    - action = 'open': ปลดล็อกประตูตู้เพื่อเปิดเอาของ (สถานะการจองยังคงเป็น active)
 *    - action = 'close': ผู้ใช้ยืนยันการคืนตู้ (เปลี่ยนสถานะเป็น 'completed' และบันทึกเวลาเสร็จสิ้น)
 * 4. รองรับการเชื่อมต่อกับฮาร์ดแวร์จริง เช่น บอร์ดไมโครคอนโทรลเลอร์ ESP32 และกลอนแม่เหล็กไฟฟ้า (Solenoid Lock)
 * 
 * ความสัมพันธ์และการเชื่อมโยงข้อมูล (Dependencies):
 * - `../config/db.js`: การเชื่อมต่อฐานข้อมูล PostgreSQL
 * - ตารางที่เกี่ยวข้อง: `bookings` (ตรวจสอบ pin_code และอัปเดตสถานะ), `logs` (บันทึกประวัติการเปิด/ปิด/PIN ผิด)
 * - Frontend ที่เรียกใช้งาน:
 *   - `HomePage.jsx`: Modal กรอกรหัส PIN สำหรับจำลองการเปิดตู้หรือคืนตู้ที่หน้าตู้ล็อกเกอร์
 * =========================================================================================
 */

const pool = require('../config/db');

/**
 * Controller: ตรวจสอบรหัส PIN และสั่งการตู้ล็อกเกอร์
 * Method: POST /pin/verify (หรือ POST /pin/open, POST /pin/close)
 * 
 * พารามิเตอร์ที่รับเข้ามา (Body):
 * - booking_id: รหัสรายการจองที่ต้องการทำรายการ
 * - pin_code: รหัสผ่าน 6 หลักที่ผู้ใช้ป้อนเข้ามา
 * - action: คำสั่งที่ต้องการทำ ('open' = ปลดล็อกตู้, 'close' = คืนตู้)
 * 
 * ขั้นตอนการทำงาน:
 * 1. ค้นหารายการจองจากฐานข้อมูลตาม booking_id
 * 2. เปรียบเทียบรหัส pin_code:
 *    - หากไม่ตรง: บันทึกประวัติ 'wrong_pin' ลง logs แล้วตอบกลับข้อผิดพลาด 401
 * 3. หากรหัสถูกต้อง:
 *    - ในการต่อยอดระบบจริง: ส่งสัญญาณ HTTP/MQTT ไปสั่งงานบอร์ด ESP32 เพื่อปลดล็อกกลอน
 *    - หาก action === 'close': อัปเดตสถานะการจองเป็น 'completed' และ completed_at = NOW()
 *    - บันทึกประวัติกิจกรรมลง logs (action = 'open' หรือ 'close')
 * 4. ส่งข้อความตอบกลับยืนยันผลการดำเนินการสำเร็จ
 */
async function verifyPin(req, res) {
  const { booking_id, pin_code, action } = req.body;

  // 1. ตรวจสอบว่ามีรายการจองนี้อยู่ในระบบหรือไม่
  const result = await pool.query('SELECT * FROM bookings WHERE booking_id = $1', [booking_id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการจองนี้' });
  }
  const booking = result.rows[0];

  // 2. ตรวจสอบความถูกต้องของรหัส PIN
  if (booking.pin_code !== pin_code) {
    // หากรหัส PIN ไม่ถูกต้อง บันทึกความพยายามที่ผิดพลาดลงตาราง logs
    await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [
      booking.locker_id,
      booking.user_id,
      'wrong_pin',
    ]);
    return res.status(401).json({ success: false, message: 'รหัส PIN ไม่ถูกต้อง' });
  }

  // 3. จำลองการสั่งงานฮาร์ดแวร์ภายนอก (ในระบบจริงจะยิง HTTP request / MQTT ไปยัง ESP32 เพื่อดีดกลอน)

  // 4. หากเป็นการ "คืนตู้" (action === 'close') ให้เปลี่ยนสถานะการจองเป็นเสร็จสิ้น
  if (action === 'close') {
    // ผู้ใช้สามารถคืนตู้ได้ทุกเมื่อ ไม่ว่าจะก่อนหรือหลังเวลาที่ระบุไว้
    // เมื่อ booking เปลี่ยนเป็น 'completed' ระบบจะคำนวณให้ตู้นี้กลับมาเป็น "ว่าง" (available) อัตโนมัติ
    await pool.query(
      'UPDATE bookings SET status = $1, completed_at = NOW() WHERE booking_id = $2',
      ['completed', booking_id]
    );
  }

  // 5. บันทึกประวัติการกระทำที่สำเร็จลงตาราง logs (action: 'open' หรือ 'close')
  await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [
    booking.locker_id,
    booking.user_id,
    action,
  ]);

  // 6. ส่งข้อความแจ้งเตือนผลสำเร็จกลับไปยังหน้าบ้าน
  res.json({ success: true, message: action === 'open' ? 'ปลดล็อกตู้สำเร็จ' : 'คืนตู้สำเร็จ' });
}

module.exports = { verifyPin };

