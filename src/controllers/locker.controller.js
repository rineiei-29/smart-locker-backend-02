/**
 * =========================================================================================
 * ไฟล์: src/controllers/locker.controller.js (ระบบจัดการและแสดงสถานะตู้ล็อกเกอร์)
 * -----------------------------------------------------------------------------------------
 * หน้าที่หลักของไฟล์นี้:
 * 1. ดึงรายการตู้ล็อกเกอร์ทั้งหมดพร้อมคำนวณสถานะแสดงผลแบบเรียลไทม์ (Live Display Status)
 * 2. จัดการการอัปเดตสถานะตู้และขนาดตู้โดยผู้ดูแลระบบ (Admin Locker Management)
 * 
 * กลไกการคำนวณสถานะของตู้ (Dynamic Status Computation):
 * - ในฐานข้อมูล `lockers.status` จะมีค่าคงที่ระดับฮาร์ดแวร์/ผู้ดูแลระบบ:
 *   - 'available' = ตู้พร้อมเปิดให้บริการตามปกติ
 *   - 'unavailable' = แอดมินปิดการใช้งานตู้ชั่วคราว (จะบล็อกการจองทุกช่วงเวลา)
 *   - 'maintenance' = ตู้ปิดปรับปรุง/ชำรุด
 * 
 * - สถานะที่ส่งกลับไปให้หน้าเว็บ (`display_status`) จะถูกคำนวณสด ณ เวลาปัจจุบัน (computeDisplayStatus):
 *   - 'available': ตู้ว่าง ไม่มีใครกำลังใช้งาน ณ วินาทีนี้ (กดจองใช้งานได้ทันที)
 *   - 'occupied': มีผู้ใช้งานจองและอยู่ในช่วงเวลา start_time ถึง end_time (แสดงเวลาที่จะว่าง available_at)
 *   - 'overdue': เลยเวลาสิ้นสุด end_time แล้วแต่ผู้ใช้ยังไม่กดคืนตู้ (แสดงเวลาที่เริ่มเกิน overdue_since)
 *   - 'maintenance' / 'unavailable': แอดมินปิดใช้งานตู้
 * 
 * ความสัมพันธ์และการเชื่อมโยงข้อมูล (Dependencies):
 * - `../config/db.js`: การเชื่อมต่อฐานข้อมูล PostgreSQL
 * - `../utils/scheduling.js`: คำนวณสถานะตู้จากช่วงเวลาจอง (computeDisplayStatus, getActiveBookingsByLocker)
 * - Frontend:
 *   - `HomePage.jsx`: โหลดรายการตู้ไปแสดงบน Grid Dashboard ทุก 5 วินาที
 *   - `AdminPage.jsx`: โหลดรายการตู้ไปแสดงในแท็บจัดการตู้ และใช้แก้ไขสถานะ/ขนาดตู้
 * =========================================================================================
 */

const pool = require('../config/db');
const { computeDisplayStatus, getActiveBookingsByLocker } = require('../utils/scheduling');

/**
 * Controller: ดึงรายการตู้ล็อกเกอร์ทั้งหมดพร้อมสถานะคำนวณสด
 * Method: GET /lockers
 * 
 * ขั้นตอนการทำงาน:
 * 1. Query ตู้ทั้งหมดจากตาราง lockers เรียงตาม locker_number
 * 2. ดึงรายการ active bookings ทั้งหมดของทุกล็อกเกอร์เพื่อนำมาเช็คช่วงเวลา
 * 3. วนลูปคำนวณ display_status, available_at, overdue_since ของแต่ละตู้เทียบกับเวลาปัจจุบัน (now)
 * 4. ส่งข้อมูลตู้พร้อมสถานะสดกลับไปให้ Frontend
 */
async function listLockers(req, res) {
  // 1. ดึงข้อมูลตู้ล็อกเกอร์ทั้งหมดจากฐานข้อมูล
  const result = await pool.query('SELECT * FROM lockers ORDER BY locker_number');
  const lockers = result.rows;

  // 2. ดึงการจองที่ยัง active อยู่ของตู้ทั้งหมด เพื่อนำมาตรวจสอบช่วงเวลา
  const bookingsByLocker = await getActiveBookingsByLocker(lockers.map((l) => l.locker_id));
  const now = new Date();

  // 3. ผสานสถานะที่คำนวณได้เข้ากับข้อมูลตู้แต่ละใบ
  const data = lockers.map((locker) => {
    const activeBookings = bookingsByLocker[locker.locker_id] || [];
    // computeDisplayStatus จะเปรียบเทียบเวลาปัจจุบันกับการจอง เพื่อดูว่าว่าง, กำลังใช้, หรือเกินเวลา
    const { display_status, available_at, overdue_since } = computeDisplayStatus(locker, activeBookings, now);
    return { ...locker, display_status, available_at, overdue_since };
  });

  // 4. ส่งข้อมูลกลับไปยังหน้าบ้าน
  res.json({ success: true, data });
}

/**
 * Controller: อัปเดตข้อมูลตู้ล็อกเกอร์ (สำหรับผู้ดูแลระบบ)
 * Method: PUT /lockers/:id
 * 
 * ข้อมูลที่สามารถแก้ไขได้ (Body):
 * - status: 'available' | 'unavailable' | 'maintenance' (การเปิด/ปิดตู้โดยแอดมิน)
 * - size: 'small' | 'medium' | 'large' (ขนาดของช่องตู้)
 * 
 * ความปลอดภัย:
 * - ใช้ Dynamic Parameterized Query ($1, $2, ...) เพื่อป้องกันการเกิด SQL Injection
 */
async function updateLocker(req, res) {
  const { status, size } = req.body;
  const fields = [];
  const values = [];
  let paramIndex = 1;

  // ตรวจสอบความถูกต้องของสถานะที่ต้องการเปลี่ยน
  if (status) {
    if (!['available', 'unavailable', 'maintenance'].includes(status)) {
      return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
    }
    fields.push(`status = $${paramIndex++}`);
    values.push(status);
  }

  // ตรวจสอบความถูกต้องของขนาดตู้ที่ต้องการเปลี่ยน
  if (size) {
    if (!['small', 'medium', 'large'].includes(size)) {
      return res.status(400).json({ success: false, message: 'ขนาดไม่ถูกต้อง' });
    }
    fields.push(`size = $${paramIndex++}`);
    values.push(size);
  }

  // หากไม่มีการส่งฟิลด์ที่ต้องการแก้ไขมา ให้ตอบกลับข้อผิดพลาด
  if (fields.length === 0) {
    return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลให้อัปเดต' });
  }

  // เพิ่ม locker_id ในพารามิเตอร์ตัวสุดท้าย
  values.push(req.params.id);
  const queryText = `UPDATE lockers SET ${fields.join(', ')} WHERE locker_id = $${paramIndex}`;
  const result = await pool.query(queryText, values);

  if (result.rowCount === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }

  res.json({ success: true, message: 'อัปเดตตู้ล็อกเกอร์สำเร็จ' });
}

module.exports = { listLockers, updateLocker };

