import mongoose from 'mongoose';

const videoSchema = new mongoose.Schema({
  title:       { type: String, default: '' },
  description: { type: String, default: '' },
  videoUrl:    { type: String, default: '' },
  orderIndex:  { type: Number, default: 0 },
}, { _id: true });

const STAGE_KEYS = ['fish', 'dolphin', 'shark', 'whale'] as const;

const stageSchema = new mongoose.Schema({
  stage:  { type: String, enum: STAGE_KEYS, required: true },
  videos: [videoSchema],
}, { _id: false });

const courseSchema = new mongoose.Schema({
  title:         { type: String, required: true },
  description:   { type: String, default: '' },
  thumbnail:     { type: String, default: '' },
  status:        { type: String, enum: ['active', 'inactive'], default: 'active' },
  stage:         { type: String, enum: STAGE_KEYS, required: true },
  whatYouLearn:  [String],
  stages: {
    type: [stageSchema],
    default: () => STAGE_KEYS.map(s => ({ stage: s, videos: [] })),
  },
}, { timestamps: true });

export const STAGE_PRICES: Record<string, number> = {
  fish:    5000,
  dolphin: 15000,
  shark:   50000,
  whale:   150000,
};

export const STAGE_LABELS: Record<string, string> = {
  fish:    'Become a Fish',
  dolphin: 'Become a Dolphin',
  shark:   'Become a Shark',
  whale:   'Become a Whale',
};

export const Course = mongoose.model('Course', courseSchema);
