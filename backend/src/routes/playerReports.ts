import { Router, Request, Response, NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import { requireDiscordRole, requireDashboardAuth } from '../middleware/auth';
import { listPlayerReports, updatePlayerReport, createPlayerReportWeb, uploadReportImage, listMinePlayerReports, getMinePlayerReport } from '../controllers/playerReportsController';

// Store in memory — never touch the filesystem; we stream directly to MinIO
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 }, // 5 MB per file, 3 files max
  fileFilter: (_req, file, cb) => {
    // Pre-screen by MIME type header; magic-byte check happens in the service
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// SR-005: catch MulterError before it reaches the global error handler
function multerErrorHandler(err: any, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof MulterError) {
    const detail = err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be under 5 MB.'
      : err.code === 'LIMIT_FILE_COUNT' ? 'Maximum 3 images per report.'
      : `Upload error: ${err.field ?? err.code}`;
    res.status(422).json({ title: 'Upload Error', detail });
    return;
  }
  next(err);
}

const router = Router();
router.get('/', requireDiscordRole('owner', 'admin', 'moderator'), listPlayerReports);
// Own-scoped (dweller self-service) — must precede '/:id' so 'mine' isn't
// captured as an id by the staff PATCH route below.
router.get('/mine', requireDashboardAuth, listMinePlayerReports);
router.get('/mine/:id', requireDashboardAuth, getMinePlayerReport);
// Create + image upload accept ANY signed-in web user (dashboard dweller OR
// public-form user) — requireDashboardAuth normalizes both into req.dashboardUser.
router.post('/', requireDashboardAuth, createPlayerReportWeb);
router.post('/upload-image', requireDashboardAuth, upload.array('images', 3), multerErrorHandler, uploadReportImage);
router.patch('/:id', requireDiscordRole('owner', 'admin', 'moderator'), updatePlayerReport);
export default router;
