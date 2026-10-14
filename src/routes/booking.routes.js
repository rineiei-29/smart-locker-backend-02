/**
 * =========================================================================================
 * ไฟล์: src/routes/booking.routes.js (Booking Routes API)
 * -----------------------------------------------------------------------------------------
 * หน้าที่หลัก:
 * - กำหนด Endpoint เส้นทางเกี่ยวกับระบบการจองตู้ล็อกเกอร์ทั้งหมด
 * - เชื่อมโยงไปยังฟังก์ชันใน `../controllers/booking.controller.js`
 * 
 * รายการ Endpoint:
 * - POST /booking -> createBooking (สร้างการจองใหม่)
 * - GET /my-bookings -> myBookings (ดึงรายการจองปัจจุบันที่ active ของผู้ใช้ -> เรียกใช้ใน HomePage.jsx)
 * - GET /my-history -> myHistory (ดึงประวัติการจองในอดีต -> เรียกใช้ใน UserHistory.jsx)
 * - GET /bookings -> allBookings (ดึงการจองทั้งหมดในระบบ -> เรียกใช้ใน AdminPage.jsx)
 * - POST /bookings/batch-action -> batchAction (ปลดล็อกหรือคืนตู้จากในแอป)
 * - PUT /bookings/:id/release -> releaseBooking (แอดมินสั่งปล่อยตู้ที่ค้าง)
 * =========================================================================================
 */

const express = require('express');
const {
  createBooking,
  myBookings,
  allBookings,
  releaseBooking,
  batchAction,
  myHistory,
} = require('../controllers/booking.controller');

const router = express.Router();

router.post('/booking', createBooking);
router.get('/my-bookings', myBookings);
router.get('/my-history', myHistory);
router.get('/bookings', allBookings);
router.post('/bookings/batch-action', batchAction);
router.put('/bookings/:id/release', releaseBooking);

module.exports = router;
