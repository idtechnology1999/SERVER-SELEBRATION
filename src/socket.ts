import { Server } from 'socket.io';

let _io: Server;

export function initSocket(io: Server) {
  _io = io;
  io.on('connection', (socket) => {
    console.log('[Socket.io] Admin connected:', socket.id);
    socket.on('disconnect', () => {
      console.log('[Socket.io] Admin disconnected:', socket.id);
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
