import express from 'express';
const router = express.Router();

// Logout is handled by DELETE /api/users/session (canonical endpoint).
// This router is reserved for future auth-specific routes (e.g., token refresh).

export default router;
module.exports = router;
