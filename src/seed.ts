import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { Admin, Settings } from './models/index.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI!;

async function seed() {
  if (!MONGO_URI) {
    console.error('MONGO_URI not defined');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  // Admin account
  const adminExists = await Admin.countDocuments();
  if (adminExists === 0) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await Admin.create({
      name: 'Admin User',
      email: 'owolabiidowu99@gmail.com',
      password: hashedPassword,
      role: 'superadmin',
    });
    console.log('Admin created');
  } else {
    console.log('Admin already exists — skipped');
  }

  // Platform settings
  const settingsExists = await Settings.countDocuments();
  if (settingsExists === 0) {
    await Settings.create({
      paystackKey: '',
      paystackSecret: '',
      bankName: '',
      bankAccount: '',
      bankAccountName: '',
      commissionLevel1: 3250,
      commissionLevel2: 750,
      commissionLevel3: 250,
      commissionLevel4: 100,
      commissionLevel5: 50,
      commissionLevel6: 25,
      emailNotifications: true,
      withdrawalNotifications: true,
      commissionNotifications: true,
    });
    console.log('Settings created');
  } else {
    console.log('Settings already exist — skipped');
  }

  console.log('Seed complete!');
  process.exit(0);
}

seed();
