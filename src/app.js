/**
 * =========================================================================================
 * ไฟล์: src/app.js (Express Application Setup & Router Aggregator)
 * -----------------------------------------------------------------------------------------
 * หน้าที่หลัก:
 * - ตัวกลางตั้งค่า Express Application, Middleware (JSON parser, Static files)
 * - รวบรวมและลงทะเบียนเส้นทาง API Routes ทั้งหมด 8 โมดูลหลัก:
 *   1) authRoutes: ระบบเข้าสู่ระบบ / สมัครสมาชิก (/login, /register)
 *   2) lockerRoutes: ระบบตู้ล็อกเกอร์และสถานะ (/lockers, /lockers/:id/status)
 *   3) bookingRoutes: ระบบการจองตู้ (/my-bookings, /bookings, /batch-action, /relocate)
 *   4) paymentRoutes: ระบบเซสชันชำระเงิน QR (/payment-sessions, /confirm)
 *   5) pinRoutes: ระบบปลดล็อกและคืนตู้ด้วย PIN (/pin/open, /pin/close)
 *   6) logRoutes: ระบบบันทึกเหตุการณ์ประวัติ (/logs)
 *   7) userRoutes: ระบบจัดการผู้ใช้งาน (/users, /users/:id/status)
 *   8) reportRoutes: ระบบสถิติ แดชบอร์ด และประวัติผู้ใช้ (/my-history, /reports/dashboard)
 * =========================================================================================
 */

const express = require('express');
const path = require('path');

const authRoutes = require('./routes/auth.routes');
const lockerRoutes = require('./routes/locker.routes');
const bookingRoutes = require('./routes/booking.routes');
const paymentRoutes = require('./routes/payment.routes');
const pinRoutes = require('./routes/pin.routes');
const logRoutes = require('./routes/log.routes');
const userRoutes = require('./routes/user.routes');
const reportRoutes = require('./routes/report.routes');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(authRoutes);
app.use(lockerRoutes);
app.use(bookingRoutes);
app.use(paymentRoutes);
app.use(pinRoutes);
app.use(logRoutes);
app.use(userRoutes);
app.use(reportRoutes);

// error handler ตัวสุดท้าย — ดัก error ที่หลุดมาจาก asyncHandler (เช่น query DB พัง, ต่อฐานข้อมูลไม่ติด)
// กัน process ทั้งตัวล้มเวลามี request เดียวพัง แค่ตอบ 500 กลับไปแทน
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง' });
});

module.exports = app;
