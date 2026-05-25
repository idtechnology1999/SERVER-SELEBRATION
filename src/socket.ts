import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

let _io: Server;

export function initSocket(io: Server) {
  _io = io;
  io.on('connection', (socket) => {
    console.log('[Socket.io] Client connected:', socket.id);

    // User joins their personal room — verified by JWT
    socket.on('join:user', ({ userId, token }: { userId: string; token: string }) => {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
        if (decoded.id === userId && (decoded.role === 'student' || decoded.role === 'affiliate')) {
          socket.join(`user_${userId}`);
        }
      } catch {}
    });

    // Admin joins the shared admins room — verified by JWT
    socket.on('join:admin', ({ token }: { token: string }) => {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
        if (decoded.role === 'admin' || decoded.role === 'superadmin') {
          socket.join('admins');
        }
      } catch {}
    });

    socket.on('disconnect', () => {
      console.log('[Socket.io] Client disconnected:', socket.id);
    });
  });
}

export function getIO(): Server {
  if (!_io) throw new Error('Socket.io not initialized');
  return _io;
}

export function emit(event: string, data: unknown) {
  if (_io) _io.emit(event, data);
}
