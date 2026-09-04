import mongoose from 'mongoose';

const usedReferenceSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  userId:    { type: String, required: true },
  purpose:   { type: String },
  amount:    { type: Number },
}, { timestamps: true });

export const UsedReference = mongoose.model('UsedReference', usedReferenceSchema);
