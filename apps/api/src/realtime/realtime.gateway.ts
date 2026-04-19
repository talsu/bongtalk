import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway {
  @WebSocketServer()
  server!: Server;

  // TODO(task-005): add JWT verification handshake hook here.
  @SubscribeMessage('ping')
  ping(@MessageBody() data: unknown, @ConnectedSocket() client: Socket): void {
    client.emit('pong', data ?? null);
  }
}
