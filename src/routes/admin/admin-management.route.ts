import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { Admin, Notification } from '../../models/index.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { RECOVERY_EMAIL } from '../../config/email.js';

const router = Router();

function makeTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: (process.env.EMAIL_PASS || '').replace(/\s/g, ''),
    },
    tls: { rejectUnauthorized: false },
  });
}

// GET /api/admins - List all admins (superadmin only)
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (req.admin!.role !== 'superadmin') {
      res.status(403).json({ success: false, message: 'Only super admins can view admin list' });
      return;
    }

    const admins = await Admin.find({}).select('-password').sort({ createdAt: -1 });
    const data = admins.map(adm => ({
      id: adm._id.toString(),
      name: adm.name,
      email: adm.email,
      role: adm.role,
    }));

    res.json({ success: true, data });
  } catch (err: any) {
    console.error('[list admins error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admins - Create new admin (superadmin only)
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (req.admin!.role !== 'superadmin') {
      res.status(403).json({ success: false, message: 'Only super admins can create admin accounts' });
      return;
    }

    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({ success: false, message: 'Name, email, and password are required' });
      return;
    }

    if (role && !['admin', 'superadmin'].includes(role)) {
      res.status(400).json({ success: false, message: 'Invalid role' });
      return;
    }

    const existing = await Admin.findOne({ email });
    if (existing) {
      res.status(409).json({ success: false, message: 'An admin with this email already exists' });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);
    const newAdmin = await Admin.create({
      name,
      email,
      password: hashed,
      role: role || 'admin',
    });

    // Send email to new admin
    try {
      const transporter = makeTransporter();
      const adminUrl = process.env.ADMIN_URL || 'http://localhost:5173';
      await transporter.sendMail({
        from: `"Selliberation Admin" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: `You've been added as ${role === 'superadmin' ? 'Super Admin' : 'Admin'}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#0D2847;border-radius:12px;color:#fff;">
            <h2 style="color:#F5820A;margin-top:0;">Welcome to Selliberation Admin</h2>
            <p>Hello ${name},</p>
            <p>You have been added as a <strong>${role === 'superadmin' ? 'Super Admin' : 'Admin'}</strong> on Selliberation.</p>
            <p><strong>Your login credentials:</strong></p>
            <div style="background:rgba(245,130,10,0.15);padding:16px;border-radius:8px;margin:16px 0;">
              <p style="margin:4px 0;">Email: ${email}</p>
              <p style="margin:4px 0;">Password: ${password}</p>
            </div>
            <p>You can login and change your password later.</p>
            <a href="${adminUrl}/login" style="display:inline-block;background:#F5820A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:16px;">Access Admin Panel</a>
          </div>
        `,
      });
      transporter.close();
    } catch (emailErr: any) {
      console.error('[admin email error]', emailErr.message);
    }

    // Notify super admin who created this
    await Notification.create({
      userId: req.admin!.id,
      userType: 'admin',
      title: 'Admin Added',
      message: `${name} has been added as ${role === 'superadmin' ? 'Super Admin' : 'Admin'}.`,
      type: 'admin_created',
    });

    // Notify the new admin
    await Notification.create({
      userId: newAdmin._id.toString(),
      userType: 'admin',
      title: `You are now ${role === 'superadmin' ? 'Super Admin' : 'Admin'}`,
      message: `You have been added as a ${role === 'superadmin' ? 'Super Admin' : 'Admin'}. Login to access the admin panel.`,
      type: 'admin_created',
    });

    res.status(201).json({
      success: true,
      data: {
        id: newAdmin._id.toString(),
        name: newAdmin.name,
        email: newAdmin.email,
        role: newAdmin.role,
      },
    });
  } catch (err: any) {
    console.error('[create admin error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admins/:id - Delete admin (superadmin only, cannot delete superadmin or self)
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (req.admin!.role !== 'superadmin') {
      res.status(403).json({ success: false, message: 'Only super admins can delete admin accounts' });
      return;
    }

    const { id } = req.params;

    const target = await Admin.findById(id);
    if (!target) {
      res.status(404).json({ success: false, message: 'Admin not found' });
      return;
    }

    if (target.role === 'superadmin') {
      res.status(403).json({ success: false, message: 'Cannot delete super admin accounts' });
      return;
    }

    if (target._id.toString() === req.admin!.id) {
      res.status(403).json({ success: false, message: 'You cannot delete your own account' });
      return;
    }

    await Admin.findByIdAndDelete(id);
    res.json({ success: true, message: 'Admin deleted successfully' });
  } catch (err: any) {
    console.error('[delete admin error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
