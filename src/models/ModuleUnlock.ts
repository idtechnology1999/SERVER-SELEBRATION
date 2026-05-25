import mongoose from 'mongoose';

const moduleUnlockSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  moduleId: { type: String, required: true },  // embedded module _id (string)
  amount:   { type: Number, required: true },
  reference: { type: String, required: true, unique: true },
}, { timestamps: true });

moduleUnlockSchema.index({ userId: 1, moduleId: 1 }, { unique: true });

export const ModuleUnlock = mongoose.model('ModuleUnlock', moduleUnlockSchema);
