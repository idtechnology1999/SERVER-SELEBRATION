import { Router } from 'express';
import type { Response } from 'express';
import { Course, User, Notification } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';

const router = Router();

const VALID_STAGES = ['fish', 'dolphin', 'shark', 'whale'];

// Public — landing page course list
router.get('/public', asyncHandler(async (_req, res: Response) => {
  const courses = await Course.find({ status: 'active' })
    .select('title description thumbnail whatYouLearn stage stages')
    .lean();
  res.json({
    success: true,
    data: courses.map(c => ({
      id: c._id.toString(),
      title: c.title,
      description: c.description,
      thumbnail: c.thumbnail,
      stage: c.stage,
      whatYouLearn: c.whatYouLearn ?? [],
      stagesCount: c.stages?.length ?? 4,
    })),
  });
}));

router.use(requireAuth);

// GET /api/courses
router.get('/', asyncHandler(async (_req: AuthRequest, res: Response) => {
  const courses = await Course.find().sort({ createdAt: -1 });
  res.json({ success: true, data: courses });
}));

// POST /api/courses
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { title, description, thumbnail, whatYouLearn, stage } = req.body;
  if (!title) {
    res.status(400).json({ success: false, message: 'Title is required' });
    return;
  }
  if (!stage || !VALID_STAGES.includes(stage)) {
    res.status(400).json({ success: false, message: 'A valid stage (fish, dolphin, shark, whale) is required' });
    return;
  }

  const course = await Course.create({ title, description, thumbnail, whatYouLearn, stage });

  const students = await User.find({ role: 'student' }).select('_id');
  if (students.length > 0) {
    await Notification.insertMany(students.map(s => ({
      userId: s._id.toString(),
      userType: 'student',
      title: 'New Course Added',
      message: `Check out the new course: ${course.title}`,
      type: 'course_added',
    })));
  }

  res.status(201).json({ success: true, data: course });
}));

// PUT /api/courses/:id
router.put('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { title, description, thumbnail, whatYouLearn, status, stage } = req.body;
  if (stage !== undefined && !VALID_STAGES.includes(stage)) {
    res.status(400).json({ success: false, message: 'Invalid stage value' });
    return;
  }
  const course = await Course.findByIdAndUpdate(
    req.params.id,
    { $set: { title, description, thumbnail, whatYouLearn, status, stage } },
    { new: true, runValidators: false }
  );
  if (!course) { res.status(404).json({ success: false, message: 'Course not found' }); return; }
  res.json({ success: true, data: course });
}));

// DELETE /api/courses/:id
router.delete('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const course = await Course.findByIdAndDelete(req.params.id);
  if (!course) { res.status(404).json({ success: false, message: 'Course not found' }); return; }
  res.json({ success: true, message: 'Course deleted' });
}));

// POST /api/courses/:id/stages/:stage/videos — add video to a stage slot
router.post('/:id/stages/:stage/videos', asyncHandler(async (req: AuthRequest, res: Response) => {
  const stage = String(req.params.stage);
  if (!VALID_STAGES.includes(stage)) {
    res.status(400).json({ success: false, message: 'Invalid stage' });
    return;
  }

  const { title, description, videoUrl } = req.body;
  if (!title || !videoUrl) {
    res.status(400).json({ success: false, message: 'Title and video URL are required' });
    return;
  }

  const course = await Course.findById(req.params.id);
  if (!course) { res.status(404).json({ success: false, message: 'Course not found' }); return; }

  const stageDoc = course.stages.find((s: any) => s.stage === stage);
  if (!stageDoc) { res.status(404).json({ success: false, message: 'Stage not found' }); return; }

  const orderIndex = stageDoc.videos.length;
  stageDoc.videos.push({ title, description: description || '', videoUrl, orderIndex } as any);
  await course.save();

  res.status(201).json({ success: true, data: course });
}));

// PUT /api/courses/:id/stages/:stage/videos/:videoId — edit a video
router.put('/:id/stages/:stage/videos/:videoId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const stage = String(req.params.stage);
  const { videoId } = req.params;
  if (!VALID_STAGES.includes(stage)) {
    res.status(400).json({ success: false, message: 'Invalid stage' });
    return;
  }

  const course = await Course.findById(req.params.id);
  if (!course) { res.status(404).json({ success: false, message: 'Course not found' }); return; }

  const stageDoc = course.stages.find((s: any) => s.stage === stage);
  if (!stageDoc) { res.status(404).json({ success: false, message: 'Stage not found' }); return; }

  const video = stageDoc.videos.find((v: any) => v._id.toString() === videoId);
  if (!video) { res.status(404).json({ success: false, message: 'Video not found' }); return; }

  const { title, description, videoUrl } = req.body;
  if (title !== undefined) (video as any).title = title;
  if (description !== undefined) (video as any).description = description;
  if (videoUrl !== undefined) (video as any).videoUrl = videoUrl;

  await course.save();
  res.json({ success: true, data: course });
}));

// DELETE /api/courses/:id/stages/:stage/videos/:videoId — remove a video
router.delete('/:id/stages/:stage/videos/:videoId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const stage = String(req.params.stage);
  const { videoId } = req.params;
  if (!VALID_STAGES.includes(stage)) {
    res.status(400).json({ success: false, message: 'Invalid stage' });
    return;
  }

  const course = await Course.findById(req.params.id);
  if (!course) { res.status(404).json({ success: false, message: 'Course not found' }); return; }

  const stageDoc = course.stages.find((s: any) => s.stage === stage);
  if (!stageDoc) { res.status(404).json({ success: false, message: 'Stage not found' }); return; }

  stageDoc.videos = stageDoc.videos.filter((v: any) => v._id.toString() !== videoId) as any;
  await course.save();
  res.json({ success: true, data: course });
}));

export default router;
